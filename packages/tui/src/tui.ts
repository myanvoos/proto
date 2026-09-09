import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { getDebugLogPath } from "@oh-my-pi/pi-utils/dirs";
import { $flag } from "@oh-my-pi/pi-utils/env";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { planDeccaraFills } from "./deccara";
import { isKeyRelease, matchesKey } from "./keys";
import { LoopWatchdog } from "./loop-watchdog";
import { setAltScreenActive, type Terminal } from "./terminal";
import {
	encodeKittyDeleteImage,
	encodeKittyDeletePlacement,
	encodeKittyPlacementLine,
	ImageProtocol,
	isImageProtocolForced,
	isInsideHerdr,
	isInsideTerminalMultiplexer,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	setTerminalImageProtocol,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "./terminal-capabilities";
import {
	Ellipsis,
	extractSegments,
	isOsc66Line,
	normalizeTerminalOutput,
	osc66MaxScale,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils";

const SEGMENT_RESET = "\x1b[0m";

const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const ERASE_LINE = "\x1b[2K";
const ERASE_TO_END_OF_LINE = "\x1b[K";

const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;

const HIDE_CURSOR = "\x1b[?25l";
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
const CURSOR_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}`;
const CURSOR_BEGIN_NO_SYNC = HIDE_CURSOR;
const CURSOR_END = SYNC_OUTPUT_END;
const CURSOR_END_NO_SYNC = "";

const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type StartListener = () => void;

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
}

export interface TUIStartOptions {
	clearScrollback?: boolean;

	deferInput?: boolean;
}

const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

export interface Component {
	render(width: number): readonly string[];

	handleInput?(data: string): void;

	wantsKeyRelease?: boolean;

	invalidate?(): void;

	setIgnoreTight?(ignore: boolean): any;

	dispose?(): void;
}

export interface OverlayFocusOwner {
	ownsOverlayFocusTarget(component: Component): boolean;
}

export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;

	isNativeScrollbackLiveRegionPinned?(): boolean;

	getNativeScrollbackLiveRegionPinnedStart?(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

export interface NativeScrollbackWidthEpoch {
	captureNativeScrollbackWidthEpoch(): unknown;
	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined;
	getNativeScrollbackWidthEpochRows(): number | undefined;

	isNativeScrollbackWidthEpochAppendOnly?(boundary: unknown): boolean;

	getNativeScrollbackWidthEpochRevision?(): number;
}

export interface NativeScrollbackReplay {
	prepareNativeScrollbackReplay(): void;
}

function prepareNativeScrollbackReplay(component: Component): void {
	(component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay?.();
}

function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

function getNativeScrollbackWidthEpoch(component: Component): NativeScrollbackWidthEpoch | undefined {
	const candidate = component as Component & Partial<NativeScrollbackWidthEpoch>;
	return candidate.captureNativeScrollbackWidthEpoch &&
		candidate.resolveNativeScrollbackWidthEpoch &&
		candidate.getNativeScrollbackWidthEpochRows
		? (candidate as NativeScrollbackWidthEpoch)
		: undefined;
}

function getNativeScrollbackWidthEpochRevision(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackWidthEpoch>).getNativeScrollbackWidthEpochRevision?.();
}

function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

function getNativeScrollbackLiveRegionPinnedStart(component: Component): number | undefined {
	const start = (
		component as Component & Partial<NativeScrollbackLiveRegion>
	).getNativeScrollbackLiveRegionPinnedStart?.();
	return start === undefined || !Number.isFinite(start) ? undefined : start;
}

export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}

export interface ViewportTailProvider {
	renderViewportTail(width: number, maxRows: number): readonly string[];
}

function asViewportTailProvider(component: Component): ViewportTailProvider | undefined {
	const candidate = component as Component & Partial<ViewportTailProvider>;
	return typeof candidate.renderViewportTail === "function" ? (candidate as ViewportTailProvider) : undefined;
}

export interface Focusable {
	focused: boolean;

	setUseTerminalCursor?(useTerminalCursor: boolean): void;
}

export interface RenderRequestOptions {
	clearScrollback?: boolean;
}

export type ResizeScrollbackMode = "rebuild" | "append" | "preserve";

export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export type SizeValue = number | `${number}%`;

function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;

	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isMultiplexerSession(): boolean {
	if (!isInsideTerminalMultiplexer()) return false;
	if (Bun.env.HERDR_ENV !== "1") return true;
	const term = Bun.env.TERM?.toLowerCase() ?? "";
	return Boolean(
		Bun.env.TMUX ||
			Bun.env.STY ||
			Bun.env.ZELLIJ ||
			Bun.env.CMUX_WORKSPACE_ID ||
			Bun.env.CMUX_SURFACE_ID ||
			Bun.env.CMUX_REMOTE_TRANSPORT ||
			term.startsWith("tmux") ||
			term.startsWith("screen"),
	);
}

function reportsSizeOnAltScreenToggle(): boolean {
	const override = Bun.env.PI_TUI_RESIZE_IN_PLACE;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
}

function resizeRepaintsInPlace(): boolean {
	return isMultiplexerSession() || Bun.env.HERDR_ENV === "1" || reportsSizeOnAltScreenToggle();
}

export interface OverlayOptions {
	width?: SizeValue;

	minWidth?: number;

	maxHeight?: SizeValue;

	anchor?: OverlayAnchor;

	offsetX?: number;

	offsetY?: number;

	row?: SizeValue;

	col?: SizeValue;

	margin?: OverlayMargin | number;

	visible?: (termWidth: number, termHeight: number) => boolean;

	fullscreen?: boolean;

	mouseTracking?: boolean;
}

export interface OverlayHandle {
	hide(): void;

	setHidden(hidden: boolean): void;

	isHidden(): boolean;
}

export class Container
	implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay, NativeScrollbackWidthEpoch
{
	children: Component[] = [];

	#memoLines: string[] | undefined;
	#memoChildLines: (readonly string[])[] = [];
	#memoChildWidthEpochRevisions: Array<number | undefined> = [];
	#memoWidth = -1;

	#memoChildren: Component[] = [];
	#widthEpochBoundaries = new WeakMap<
		object,
		{
			component: Component;
			childBoundary: unknown;
			sourceIndex: number;
			leading: ReadonlyArray<{ component: Component; revision: number | undefined; rowCount: number }>;
			trailing: ReadonlyArray<{
				component: Component;
				revision: number | undefined;
				rowCount: number;
				hadRows: boolean;
			}>;
		}
	>();
	#activeWidthEpochBoundary: object | undefined;
	#widthEpochRevision = 0;
	#widthEpochChildRevisions = new WeakMap<Component, number | undefined>();

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		for (const child of this.children) {
			child.setIgnoreTight?.(ignore);
		}
		this.invalidate();
		return this;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#widthEpochRevision++;
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#memoLines = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#widthEpochRevision++;
			this.#memoLines = undefined;
		}
	}

	clear(): void {
		if (this.children.length > 0) this.#widthEpochRevision++;
		this.children = [];
		this.#memoLines = undefined;
	}

	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		this.#memoLines = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	dispose(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		const refs = this.#memoChildLines;
		if (this.#memoLines === undefined || refs.length !== this.children.length) return;
		const committed = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		let offset = 0;
		for (let i = 0; i < this.children.length; i++) {
			const childRows = refs[i];
			if (childRows === undefined) return;
			setNativeScrollbackCommittedRows(
				this.children[i]!,
				Math.min(childRows.length, Math.max(0, committed - offset)),
			);
			offset += childRows.length;
		}
	}

	prepareNativeScrollbackReplay(): void {
		for (const child of this.children) prepareNativeScrollbackReplay(child);
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		const refs = this.#memoChildLines;
		const children = this.#memoChildren;
		if (this.#memoLines === undefined || refs.length !== children.length) return undefined;
		for (let index = children.length - 1; index >= 0; index--) {
			const component = children[index]!;
			const source = getNativeScrollbackWidthEpoch(component);
			const childBoundary = source?.captureNativeScrollbackWidthEpoch();
			if (childBoundary === undefined) continue;
			const marker = {};
			this.#activeWidthEpochBoundary = marker;
			this.#widthEpochBoundaries.set(marker, {
				component,
				childBoundary,
				sourceIndex: index,
				leading: children.slice(0, index).map((child, leadingIndex) => ({
					component: child,
					revision: this.#memoChildWidthEpochRevisions[leadingIndex],
					rowCount: refs[leadingIndex]!.length,
				})),
				trailing: children.slice(index + 1).map((child, trailingIndex) => ({
					component: child,
					revision: this.#memoChildWidthEpochRevisions[index + 1 + trailingIndex],
					rowCount: refs[index + 1 + trailingIndex]!.length,
					hadRows: refs[index + 1 + trailingIndex]!.length > 0,
				})),
			});
			return marker;
		}
		return undefined;
	}

	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const marker = this.#widthEpochBoundaries.get(boundary);
		if (!marker) return undefined;
		const index = marker.sourceIndex;
		if (
			this.#memoChildren[index] !== marker.component ||
			this.#memoLines === undefined ||
			this.#memoChildLines.length !== this.#memoChildren.length
		) {
			return undefined;
		}
		for (let leadingIndex = 0; leadingIndex < marker.leading.length; leadingIndex++) {
			const captured = marker.leading[leadingIndex]!;

			if (
				this.#memoChildren[leadingIndex] !== captured.component ||
				(captured.revision !== undefined &&
					getNativeScrollbackWidthEpochRevision(captured.component) !== captured.revision)
			) {
				return undefined;
			}
		}
		const childRows = getNativeScrollbackWidthEpoch(marker.component)?.resolveNativeScrollbackWidthEpoch(
			marker.childBoundary,
		);
		if (childRows === undefined) return undefined;
		let rows = childRows;
		for (let i = 0; i < index; i++) rows += this.#memoChildLines[i]!.length;
		for (let trailingIndex = 0; trailingIndex < marker.trailing.length; trailingIndex++) {
			const captured = marker.trailing[trailingIndex]!;
			const currentIndex = index + 1 + trailingIndex;
			const currentRows = this.#memoChildLines[currentIndex];
			if (
				this.#memoChildren[currentIndex] !== captured.component ||
				currentRows === undefined ||
				(captured.revision === undefined
					? currentRows.length !== captured.rowCount
					: getNativeScrollbackWidthEpochRevision(captured.component) !== captured.revision)
			) {
				let capturedRows = 0;
				for (let index = trailingIndex; index < marker.trailing.length; index++) {
					capturedRows += marker.trailing[index]!.rowCount;
				}
				let settledRows = 0;
				for (let index = currentIndex; index < this.#memoChildLines.length; index++) {
					settledRows += this.#memoChildLines[index]!.length;
				}
				rows += Math.min(capturedRows, settledRows);
				break;
			}
			rows += currentRows.length;
		}
		return rows;
	}

	getNativeScrollbackWidthEpochRows(): number | undefined {
		if (this.#memoLines === undefined || this.#memoChildLines.length !== this.#memoChildren.length) return undefined;
		const marker =
			this.#activeWidthEpochBoundary === undefined
				? undefined
				: this.#widthEpochBoundaries.get(this.#activeWidthEpochBoundary);
		if (marker !== undefined) {
			const index = marker.sourceIndex;
			if (this.#memoChildren[index] !== marker.component) return undefined;
			const rows = getNativeScrollbackWidthEpoch(marker.component)?.getNativeScrollbackWidthEpochRows();
			if (rows === undefined) return undefined;
			let boundary = rows;
			for (let leading = 0; leading < index; leading++) boundary += this.#memoChildLines[leading]!.length;
			for (let trailing = index + 1; trailing < this.#memoChildLines.length; trailing++) {
				boundary += this.#memoChildLines[trailing]!.length;
			}
			return boundary;
		}
		let offset = this.#memoLines.length;
		for (let index = this.#memoChildren.length - 1; index >= 0; index--) {
			offset -= this.#memoChildLines[index]!.length;
			const rows = getNativeScrollbackWidthEpoch(this.#memoChildren[index]!)?.getNativeScrollbackWidthEpochRows();
			if (rows !== undefined) {
				let boundary = offset + rows;
				for (let trailing = index + 1; trailing < this.#memoChildLines.length; trailing++) {
					boundary += this.#memoChildLines[trailing]!.length;
				}
				return boundary;
			}
		}
		return undefined;
	}

	isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		const marker = this.#widthEpochBoundaries.get(boundary);
		if (!marker) return true;
		const source = getNativeScrollbackWidthEpoch(marker.component);
		if (source?.isNativeScrollbackWidthEpochAppendOnly?.(marker.childBoundary) === false) return false;
		if (!marker.trailing.some(child => child.hadRows)) return true;
		for (let trailingIndex = 0; trailingIndex < marker.trailing.length; trailingIndex++) {
			const captured = marker.trailing[trailingIndex]!;
			const currentIndex = marker.sourceIndex + 1 + trailingIndex;
			const currentRows = this.#memoChildLines[currentIndex];
			const changed =
				this.#memoChildren[currentIndex] !== captured.component ||
				currentRows === undefined ||
				(captured.revision === undefined
					? currentRows.length !== captured.rowCount
					: getNativeScrollbackWidthEpochRevision(captured.component) !== captured.revision);
			if (changed && (captured.hadRows || marker.trailing.slice(trailingIndex + 1).some(child => child.hadRows))) {
				return false;
			}
		}
		const previousRows = source?.resolveNativeScrollbackWidthEpoch(marker.childBoundary);
		const currentRows = source?.getNativeScrollbackWidthEpochRows();
		return previousRows === undefined || currentRows === undefined || currentRows <= previousRows;
	}

	getNativeScrollbackWidthEpochRevision(): number {
		for (const child of this.children) {
			const revision = getNativeScrollbackWidthEpochRevision(child);
			if (!this.#widthEpochChildRevisions.has(child)) {
				this.#widthEpochChildRevisions.set(child, revision);
			} else if (this.#widthEpochChildRevisions.get(child) !== revision) {
				this.#widthEpochChildRevisions.set(child, revision);
				this.#widthEpochRevision++;
			}
		}
		return this.#widthEpochRevision;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const children = this.children;
		const count = children.length;
		let refs = this.#memoChildLines;
		let revisions = this.#memoChildWidthEpochRevisions;
		let unchanged = this.#memoLines !== undefined && this.#memoWidth === width && refs.length === count;
		if (refs.length !== count) {
			refs = new Array(count);
			this.#memoChildLines = refs;
			revisions = new Array(count);
			this.#memoChildWidthEpochRevisions = revisions;
		}
		for (let i = 0; i < count; i++) {
			const childLines = children[i]!.render(width);
			revisions[i] = getNativeScrollbackWidthEpochRevision(children[i]!);
			if (refs[i] !== childLines) {
				unchanged = false;
				refs[i] = childLines;
			}
		}
		this.#memoChildren = children.slice();
		this.#memoWidth = width;
		if (unchanged) return this.#memoLines!;
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const childLines = refs[i]!;
			for (let j = 0; j < childLines.length; j++) lines.push(childLines[j]!);
		}
		this.#memoLines = lines;
		return lines;
	}
}

type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	widthEpochRevision?: number;
	liveLocalStart?: number;
	liveRegionPinned: boolean;

	liveRegionPinnedStart?: number;
}

function subtreeContains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return false;
	for (let i = 0; i < children.length; i++) {
		if (subtreeContains(children[i]!, target)) return true;
	}
	return false;
}

interface PreparedLine {
	raw: string;
	width: number;
	line: string;
	asciiWidth: number | undefined;
	terminalLine: string | undefined;
}

const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;

const SGR_COALESCE_ENABLED = !$flag("PI_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b;
const CC_M = 0x6d;
const CC_SEMI = 0x3b;
const CC_COLON = 0x3a;

const MERGE_TOKEN_CAP = 16;

function frameOutputEscapeEnd(text: string, start: number): number {
	if (text.charCodeAt(start) !== CC_ESC) return start + 1;
	const next = text.charCodeAt(start + 1);
	if (!Number.isFinite(next)) return start + 1;

	// CSI sequences end at their final byte (0x40..0x7e).
	if (next === CC_BRACKET) {
		for (let i = start + 2; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i + 1;
		}
		return text.length;
	}

	// OSC, DCS, SOS, PM, and APC sequences terminate with BEL or ST.
	if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
		for (let i = start + 2; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code === 0x07 || code === 0x9c) return i + 1;
			if (code === CC_ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2;
		}
		return text.length;
	}

	// Other 7-bit escape sequences have optional intermediates followed by one
	// final byte. Treat an unknown/truncated sequence as ESC plus its next byte.
	let i = start + 1;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code >= 0x20 && code <= 0x2f) {
			i++;
			continue;
		}
		return code >= 0x30 && code <= 0x7e ? i + 1 : i;
	}
	return text.length;
}

function frameOutputBoundary(text: string, start: number, maxLength: number): number {
	const limit = Math.min(text.length, start + maxLength);
	let cursor = start;
	let safe = start;
	while (cursor < limit) {
		const code = text.charCodeAt(cursor);
		if (code === CC_ESC) {
			const end = frameOutputEscapeEnd(text, cursor);
			if (end > limit) break;
			cursor = end;
		} else if (code >= 0xd800 && code <= 0xdbff && cursor + 1 < limit) {
			const low = text.charCodeAt(cursor + 1);
			if (low >= 0xdc00 && low <= 0xdfff) cursor += 2;
			else cursor++;
		} else {
			cursor++;
		}
		safe = cursor;
	}
	return safe;
}

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	let i = 0;
	while (i < t.length) {
		const tok = t[i];
		if (tok === "38" || tok === "48" || tok === "58") {
			const mode = t[i + 1];
			if (mode === undefined) return true;
			if (mode === "2") {
				if (i + 4 >= t.length) return true;
				i += 5;
				continue;
			}
			if (mode === "5") {
				if (i + 2 >= t.length) return true;
				i += 3;
				continue;
			}
		}
		i += 1;
	}
	return false;
}

export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}

		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			i = j;
			continue;
		}

		const params: string[] = [line.slice(i + 2, j)];
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);

			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	verifiedTo: number = prefix.length,
	finalTo: number = verifiedTo,
): number {
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	const hardEnd = Math.min(prefix.length, Math.max(verified, Math.trunc(finalTo)));
	if (hardEnd === 0) return -1;
	if (frame.length >= hardEnd) {
		let hardMismatch = false;
		for (let i = verified; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			let samples = 0;
			let mismatches = 0;
			for (let j = 1; j <= verified && j <= RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
				const idx = verified - j;
				const row = frame[idx]!;
				const old = prefix[idx]!;
				if (row === old) {
					if (!isBlankRow(row)) samples++;
					continue;
				}
				if (isBlankRow(row) && isBlankRow(old)) continue;
				samples++;
				if (!rowsEquivalent(row, old)) mismatches++;
			}

			if (samples === 0 || mismatches <= 1) return -1;
		}
	}

	const limit = Math.min(hardEnd, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < hardEnd ? limit : -1;
}

export class TUI extends Container {
	terminal: Terminal;
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();
	#startListeners = new Set<StartListener>();

	#renderRequested = false;
	#renderTimer: RenderTimer | undefined;
	#renderScheduler: RenderScheduler;
	#lastRenderAt = 0;

	#lastFrameCostMs = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly #INPUT_RENDER_GRACE_MS = TUI.#MIN_RENDER_INTERVAL_MS;

	static readonly #MAX_ADAPTIVE_RENDER_MS = 200;

	static readonly #MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
	static readonly #MAX_FRAME_WRITE_CHUNK_CODE_UNITS = 1024;

	static readonly #OUTPUT_BACKLOG_RETRY_MS = 10;
	#inputRenderGraceUntilMs = 0;

	static readonly #MULTIPLEXER_RESIZE_DEBOUNCE_MS = 50;

	static readonly #RESIZE_VIEWPORT_SETTLE_MS = 120;

	static readonly #OSC66_MAX_SPACER_ROWS = 6;

	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;

	#hardwareCursorRow = 0;
	#hardwareCursorState: HardwareCursorState | null = null;
	#hardwareCursorVisibilityKnown = false;
	#hardwareCursorVisible = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("PI_HARDWARE_CURSOR");
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;
	#cursorBeginSequence = this.#synchronizedOutputEnabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
	#cursorEndSequence = this.#synchronizedOutputEnabled ? CURSOR_END : CURSOR_END_NO_SYNC;

	#committedRows = 0;

	#committedPrefix: string[] = [];

	#committedPrefixAuditRows = 0;

	#widthEpochBaselineRows: number | undefined;

	#widthEpochReplayUnresolved = false;

	#widthEpochOverlayReplayPending = false;

	#widthEpochOverlayBoundary: unknown;

	#widthEpochCommittedPrefix?: {
		nativeBaseRows: number;
		frameRows: number[];
		prefix: string[];
		auditRows: number;
	};

	#multiplexerWidthEpochBoundary: unknown;
	#multiplexerWidthEpochPending = false;

	#altWidthEpochBoundary: unknown;

	#windowTopRow = 0;

	#previousWindow: string[] = [];
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackLiveRegionPinned = false;

	#nativeScrollbackPinnedBoundary: number | undefined;
	#fullRedrawCount = 0;

	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#ghosttyInitialImageDelayDone = false;
	#ghosttyInitialImageDelayTimer: RenderTimer | undefined;
	#ghosttyImageReadyAtMs = 0;
	#clearScrollbackOnNextRender = false;

	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#scrollbackRebuildEnabled =
		Bun.env.PI_TUI_SCROLLBACK_REBUILD === "1" || Bun.env.PI_TUI_SCROLLBACK_REBUILD === "true";
	#resizeScrollbackMode: ResizeScrollbackMode = TUI.#initialResizeScrollbackMode();
	static #initialResizeScrollbackMode(): ResizeScrollbackMode {
		const raw = Bun.env.PI_TUI_RESIZE_SCROLLBACK;
		return raw === "rebuild" || raw === "preserve" || raw === "append" ? raw : "preserve";
	}

	#resizeScrollbackReplayPending = false;

	#resizeEventPending = false;

	#multiplexerResizeTimer: RenderTimer | undefined;
	#deferredForcedClearScrollback = false;
	#multiplexerResizeHasPendingRender = false;

	#muxPushedRows = 0;
	#muxPushSeam = 0;

	#resizeViewportActive = false;

	#resizeViewportSettleTimer: RenderTimer | undefined;

	#resizeViewportPaintCount = 0;

	#resizeAltActive = false;

	#altToggleResizesInPlace = false;
	#stopped = false;

	#inputDeferred = false;

	#watchdog: LoopWatchdog;

	#altActive = false;
	#altMouseTrackingActive = false;
	#altPreviousLines: string[] = [];
	#altEnterWidth = 0;
	#altEnterHeight = 0;

	#pendingAltExit = "";

	#composedFrame: string[] = [];
	#composedFrameChangedFrom = Number.POSITIVE_INFINITY;
	#composedFrameChangedTo = 0;

	#frameSegments: FrameSegment[] = [];
	#frameSegmentsScratch: FrameSegment[] = [];
	#composeWidth = -1;
	#rootWidthEpochBoundaries = new WeakMap<
		object,
		{
			component: Component;
			childBoundary: unknown;
			sourceIndex: number;
			leading: ReadonlyArray<{ component: Component; revision: number | undefined; rowCount: number }>;
			trailing: ReadonlyArray<{ component: Component; revision: number | undefined; rowCount: number }>;
			hasTrailingRows: boolean;
		}
	>();

	#frameCursorMarkers: { row: number; col: number }[] = [];

	#renderStablePrefixRows = 0;

	#componentRenderTargets = new Set<Component>();
	#pendingRenderComponentsOnly = false;

	#partialComposeRoots: Set<Component> | null = null;
	#partialComposeRootsScratch = new Set<Component>();

	#componentRootCache = new WeakMap<Component, Component>();
	#scopedInputRenderComponents = new WeakSet<Component>();

	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;
	#preparedRawFrame: string[] = [];
	#preparedRowSafety: number[] = [];
	#preparedCacheWidth = -1;
	#preparedCacheHeight = -1;
	#preparedCacheOverlay = false;
	#preparedCacheAlt = false;
	#preparedCacheImageProtocol: ImageProtocol | null | undefined;
	#preparedCacheValid = false;
	#windowScratchA: string[] = [];
	#windowScratchB: string[] = [];
	#frameOutput: string[] = [];

	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		this.#showHardwareCursor = showHardwareCursor === undefined ? this.#showHardwareCursor : showHardwareCursor;
		this.#watchdog = new LoopWatchdog();
	}

	override captureNativeScrollbackWidthEpoch(): unknown {
		const liveSource = this.#frameSegments.findIndex(segment => segment.liveLocalStart !== undefined);
		const indices = Array.from({ length: this.#frameSegments.length }, (_value, index) => index)
			.reverse()
			.filter(index => index !== liveSource);
		if (liveSource >= 0) indices.unshift(liveSource);
		for (const index of indices) {
			const segment = this.#frameSegments[index]!;
			const source = getNativeScrollbackWidthEpoch(segment.component);
			const childBoundary = source?.captureNativeScrollbackWidthEpoch();
			if (childBoundary === undefined) continue;
			const marker = {};
			this.#rootWidthEpochBoundaries.set(marker, {
				component: segment.component,
				childBoundary,
				sourceIndex: index,
				leading: this.#frameSegments.slice(0, index).map(candidate => ({
					component: candidate.component,
					revision: candidate.widthEpochRevision,
					rowCount: candidate.rowCount,
				})),
				trailing: this.#frameSegments.slice(index + 1).map(candidate => ({
					component: candidate.component,
					revision: candidate.widthEpochRevision,
					rowCount: candidate.rowCount,
				})),
				hasTrailingRows: this.#frameSegments.slice(index + 1).some(candidate => candidate.rowCount > 0),
			});
			return marker;
		}
		return undefined;
	}

	override resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const marker = this.#rootWidthEpochBoundaries.get(boundary);
		if (!marker) return undefined;
		const segment = this.#frameSegments[marker.sourceIndex];
		if (segment?.component !== marker.component) return undefined;
		for (let index = 0; index < marker.leading.length; index++) {
			const captured = marker.leading[index]!;
			const current = this.#frameSegments[index];

			if (
				current?.component !== captured.component ||
				(captured.revision !== undefined && current.widthEpochRevision !== captured.revision)
			) {
				return undefined;
			}
		}
		const childRows = getNativeScrollbackWidthEpoch(marker.component)?.resolveNativeScrollbackWidthEpoch(
			marker.childBoundary,
		);
		if (childRows === undefined) return undefined;
		let rows = segment.start + childRows;
		for (let trailingIndex = 0; trailingIndex < marker.trailing.length; trailingIndex++) {
			const captured = marker.trailing[trailingIndex]!;
			const candidate = this.#frameSegments[marker.sourceIndex + 1 + trailingIndex];

			if (
				candidate?.component !== captured.component ||
				(captured.revision === undefined
					? candidate.rowCount !== captured.rowCount
					: candidate.widthEpochRevision !== captured.revision)
			) {
				let capturedRows = 0;
				for (let index = trailingIndex; index < marker.trailing.length; index++) {
					capturedRows += marker.trailing[index]!.rowCount;
				}
				let settledRows = 0;
				for (let index = marker.sourceIndex + 1 + trailingIndex; index < this.#frameSegments.length; index++) {
					settledRows += this.#frameSegments[index]!.rowCount;
				}
				rows += Math.min(capturedRows, settledRows);
				break;
			}
			rows += candidate.rowCount;
		}
		return rows;
	}

	#getNativeScrollbackWidthEpochCurrentRows(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const marker = this.#rootWidthEpochBoundaries.get(boundary);
		if (!marker) return undefined;
		const index = marker.sourceIndex;
		if (this.#frameSegments[index]?.component !== marker.component) return undefined;
		const sourceRows = getNativeScrollbackWidthEpoch(marker.component)?.getNativeScrollbackWidthEpochRows();
		if (sourceRows === undefined) return undefined;
		let rows = this.#frameSegments[index]!.start + sourceRows;
		for (let trailing = index + 1; trailing < this.#frameSegments.length; trailing++) {
			rows += this.#frameSegments[trailing]!.rowCount;
		}
		return rows;
	}

	#isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		const marker = this.#rootWidthEpochBoundaries.get(boundary);
		if (!marker) return true;
		const source = getNativeScrollbackWidthEpoch(marker.component);
		if (source?.isNativeScrollbackWidthEpochAppendOnly?.(marker.childBoundary) === false) return false;
		if (!marker.hasTrailingRows) return true;
		for (let trailingIndex = 0; trailingIndex < marker.trailing.length; trailingIndex++) {
			const captured = marker.trailing[trailingIndex]!;
			const current = this.#frameSegments[marker.sourceIndex + 1 + trailingIndex];
			const changed =
				current?.component !== captured.component ||
				(captured.revision === undefined
					? current.rowCount !== captured.rowCount
					: current.widthEpochRevision !== captured.revision);
			if (
				changed &&
				(captured.rowCount > 0 || marker.trailing.slice(trailingIndex + 1).some(segment => segment.rowCount > 0))
			) {
				return false;
			}
		}
		const previousRows = source?.resolveNativeScrollbackWidthEpoch(marker.childBoundary);
		const currentRows = source?.getNativeScrollbackWidthEpochRows();
		return previousRows === undefined || currentRows === undefined || currentRows <= previousRows;
	}

	override getNativeScrollbackWidthEpochRows(): number | undefined {
		for (let index = this.#frameSegments.length - 1; index >= 0; index--) {
			const segment = this.#frameSegments[index]!;
			const rows = getNativeScrollbackWidthEpoch(segment.component)?.getNativeScrollbackWidthEpochRows();
			if (rows !== undefined) {
				let boundary = segment.start + rows;
				for (let trailing = index + 1; trailing < this.#frameSegments.length; trailing++) {
					boundary += this.#frameSegments[trailing]!.rowCount;
				}
				return boundary;
			}
		}
		return undefined;
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#composedFrameChangedFrom = Number.POSITIVE_INFINITY;
		this.#composedFrameChangedTo = 0;
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackLiveRegionPinned = false;
		this.#nativeScrollbackPinnedBoundary = undefined;
		const children = this.children;
		const previousSegments = this.#frameSegments;
		const segments = this.#frameSegmentsScratch;
		this.#frameSegmentsScratch = previousSegments;
		segments.length = children.length;

		const committedCoordinatesOpaque =
			this.#composeWidth > 0 && this.#composeWidth !== width && this.#resizeRepaintsInPlace();
		const componentCommittedRows =
			this.#widthEpochBaselineRows === undefined ? this.#committedRows : this.#windowTopRow;

		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;
		const partialRoots = this.#partialComposeRoots;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];

			const reuse =
				partialRoots !== null && previous !== undefined && previous.component === child && !partialRoots.has(child);
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let liveRegionPinned = false;
			let liveRegionPinnedStart: number | undefined;
			let widthEpochRevision: number | undefined;
			let reported: number | undefined;
			if (reuse) {
				childLines = previous.lines;
				liveLocalStart = previous.liveLocalStart;
				liveRegionPinned = previous.liveRegionPinned;
				liveRegionPinnedStart = previous.liveRegionPinnedStart;
				widthEpochRevision = previous.widthEpochRevision;
			} else {
				const prevRows = previous !== undefined && previous.component === child ? previous.rowCount : 0;
				const prevStart = previous !== undefined && previous.component === child ? previous.start : offset;
				if (!committedCoordinatesOpaque) {
					setNativeScrollbackCommittedRows(
						child,
						Math.min(prevRows, Math.max(0, componentCommittedRows - prevStart)),
					);
				}
				childLines = child.render(width);
				widthEpochRevision = getNativeScrollbackWidthEpochRevision(child);
				const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
				if (liveRegionStart !== undefined) {
					liveLocalStart = Number.isFinite(liveRegionStart)
						? Math.max(0, Math.min(childLines.length, Math.trunc(liveRegionStart)))
						: childLines.length;
				}
				if (liveLocalStart !== undefined) {
					liveRegionPinned =
						(child as Component & Partial<NativeScrollbackLiveRegion>).isNativeScrollbackLiveRegionPinned?.() ===
						true;
					if (liveRegionPinned) {
						const pinStart = getNativeScrollbackLiveRegionPinnedStart(child);
						if (pinStart !== undefined) {
							liveRegionPinnedStart = Math.max(
								liveLocalStart,
								Math.min(childLines.length, Math.trunc(pinStart)),
							);
						}
					}
				}

				reported = getRenderStablePrefixRows(child);
			}

			if (liveLocalStart !== undefined) {
				const start = offset + liveLocalStart;
				if (this.#nativeScrollbackLiveRegionStart === undefined) {
					this.#nativeScrollbackLiveRegionStart = start;
					this.#nativeScrollbackLiveRegionPinned = liveRegionPinned;
				}

				if (liveRegionPinned && this.#nativeScrollbackPinnedBoundary === undefined) {
					this.#nativeScrollbackPinnedBoundary = offset + (liveRegionPinnedStart ?? liveLocalStart);
				}
			}
			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;

					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			const segment =
				segments[index] ??
				({
					component: child,
					lines: childLines,
					start: offset,
					rowCount: childLines.length,
					liveRegionPinned: false,
				} satisfies FrameSegment);
			segment.component = child;
			segment.lines = childLines;
			segment.start = offset;
			segment.rowCount = childLines.length;
			segment.widthEpochRevision = widthEpochRevision;
			segment.liveLocalStart = liveLocalStart;
			segment.liveRegionPinned = liveRegionPinned;
			segment.liveRegionPinnedStart = liveRegionPinnedStart;
			segments[index] = segment;
			offset += childLines.length;
		}
		this.#frameSegments = segments;

		const frame = this.#composedFrame;

		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			const retainedFrameLength = frame.length;
			if (frame.length < offset) frame.length = offset;
			this.#pruneFrameCursorMarkers(stableRows);
			for (let index = 0; index < segments.length; index++) {
				const segment = segments[index]!;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				if (from < segment.lines.length) {
					const previous = previousSegments[index];
					const previousLines =
						previous?.component === segment.component && previous.start === segment.start
							? previous.lines
							: undefined;
					this.#writeFrameRows(segment.start, segment.lines, from, previousLines, retainedFrameLength);
				}
			}
			frame.length = offset;
		}
		this.#renderStablePrefixRows = stableRows;
		// Row writes now record the exact dirty range; unchanged suffix rows may keep
		// their prepared entries even when a child returned a fresh array.
		this.#preparedValidRows = Math.min(this.#preparedValidRows, frame.length);
		return frame;
	}

	getComposedFrameChangedFrom(): number {
		return this.#composedFrameChangedFrom;
	}

	getComposedFrameChangedTo(): number {
		return this.#composedFrameChangedTo;
	}

	#pruneFrameCursorMarkers(fromRow: number): void {
		const markers = this.#frameCursorMarkers;
		let keep = markers.length;
		while (keep > 0 && markers[keep - 1]!.row >= fromRow) keep--;
		markers.length = keep;
	}

	#replaceFrameCursorMarkers(startRow: number, lines: readonly string[]): void {
		const markers = this.#frameCursorMarkers;
		const endRow = startRow + lines.length;
		let intervalStart = 0;
		while (intervalStart < markers.length && markers[intervalStart]!.row < startRow) intervalStart++;
		let intervalEnd = intervalStart;
		while (intervalEnd < markers.length && markers[intervalEnd]!.row < endRow) intervalEnd++;

		let nextCount = 0;
		for (let row = 0; row < lines.length; row++) {
			if (lines[row]!.includes(CURSOR_MARKER)) nextCount++;
		}

		const previousCount = intervalEnd - intervalStart;
		const delta = nextCount - previousCount;
		const previousLength = markers.length;
		if (delta > 0) {
			markers.length = previousLength + delta;
			for (let index = previousLength - 1; index >= intervalEnd; index--) {
				markers[index + delta] = markers[index]!;
			}
		} else if (delta < 0) {
			for (let index = intervalEnd; index < previousLength; index++) {
				markers[index + delta] = markers[index]!;
			}
			markers.length = previousLength + delta;
		}

		const reusableCount = Math.min(previousCount, nextCount);
		let markerSlot = intervalStart;
		for (let row = 0; row < lines.length; row++) {
			const line = lines[row]!;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			const absoluteRow = startRow + row;
			const col = visibleWidth(line.slice(0, markerIndex));
			if (markerSlot < intervalStart + reusableCount) {
				const marker = markers[markerSlot]!;
				marker.row = absoluteRow;
				marker.col = col;
			} else {
				markers[markerSlot] = { row: absoluteRow, col };
			}
			markerSlot++;
		}
	}

	#stripCursorMarkers(line: string, markerIndex = line.indexOf(CURSOR_MARKER)): string {
		if (markerIndex === -1) return line;
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		return stripped;
	}

	#writeFrameRows(
		startRow: number,
		lines: readonly string[],
		from: number,
		previousLines?: readonly string[],
		retainedFrameLength = 0,
	): void {
		const frame = this.#composedFrame;
		const markers = this.#frameCursorMarkers;
		for (let row = from; row < lines.length; row++) {
			const line = lines[row]!;
			const frameRow = startRow + row;
			const previousLine = previousLines?.[row];
			if (frameRow < retainedFrameLength && previousLine === line && frame[frameRow] === line) continue;
			if (frameRow < this.#composedFrameChangedFrom) this.#composedFrameChangedFrom = frameRow;
			if (frameRow + 1 > this.#composedFrameChangedTo) this.#composedFrameChangedTo = frameRow + 1;
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) {
				frame[frameRow] = line;
				continue;
			}
			const absoluteRow = startRow + row;
			markers.push({ row: absoluteRow, col: visibleWidth(line.slice(0, markerIndex)) });
			frame[frameRow] = this.#stripCursorMarkers(line, markerIndex);
		}
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	get resizeViewportPaints(): number {
		return this.#resizeViewportPaintCount;
	}

	get resizeViewportActive(): boolean {
		return this.#resizeViewportActive;
	}

	get imageBudget(): ImageBudget {
		return this.#imageBudget;
	}

	setMaxInlineImages(cap: number): void {
		this.#imageBudget.setCap(cap);
	}

	clearInlineImages(): void {
		if (this.#stopped) return;
		this.#purgeInlineImages();
	}

	#purgeInlineImages(): void {
		const transmittedIds = this.#imageBudget.takeAllTransmittedIds();
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const id of transmittedIds) {
			this.terminal.write(encodeKittyDeleteImage(id));
		}
	}

	getScrollbackRebuild(): boolean {
		return this.#scrollbackRebuildEnabled;
	}

	setScrollbackRebuild(enabled: boolean): void {
		this.#scrollbackRebuildEnabled = enabled;
	}

	getResizeScrollback(): ResizeScrollbackMode {
		return this.#resizeScrollbackMode;
	}

	setResizeScrollback(mode: ResizeScrollbackMode): void {
		this.#resizeScrollbackMode = mode;
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	get synchronizedOutput(): boolean {
		return this.#synchronizedOutputEnabled;
	}
	#deccaraFillsEnabled(): boolean {
		return TERMINAL.deccara && this.#synchronizedOutputEnabled;
	}

	setFocus(component: Component | null): void {
		const topVisibleOverlay = this.#getTopmostVisibleOverlay();
		if (topVisibleOverlay && !isOverlayFocusTarget(topVisibleOverlay.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(topVisibleOverlay.component, currentFocus)
				? currentFocus
				: topVisibleOverlay.component;
		}

		const previousFocusedComponent = this.#focusedComponent;

		if (isFocusable(previousFocusedComponent)) {
			previousFocusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	getFocused(): Component | null {
		return this.#focusedComponent;
	}

	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false };
		this.overlayStack.push(entry);

		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.#invalidatePreparedRowCache();
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.requestRender();

		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);

					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) {
						this.terminal.hideCursor();
						this.#recordHardwareCursorHidden();
					}
					this.#invalidatePreparedRowCache();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;

				if (hidden) {
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.#invalidatePreparedRowCache();
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;

		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.#invalidatePreparedRowCache();
		this.requestRender();
	}

	hasOverlay(): boolean {
		return this.overlayStack.some(o => this.#isOverlayVisible(o));
	}

	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		this.#inputDeferred = options?.deferInput === true;
		this.#watchdog.start();
		this.#ghosttyInitialImageDelayDone = false;
		this.#ghosttyImageReadyAtMs = this.#renderScheduler.now() + TUI.#GHOSTTY_INITIAL_IMAGE_DELAY_MS;

		this.terminal.onPrivateModeReport?.((mode, supported, confirmed = true) => {
			if (mode !== 2026 || !confirmed) return;
			if (synchronizedOutputUserOverride() !== null) return;
			if (!supported && isInsideHerdr()) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				if (this.#altActive) {
					if (this.#altEnterWidth === this.terminal.columns && this.#altEnterHeight !== this.terminal.rows) {
						this.#altToggleResizesInPlace = true;
					}
					if (this.#previousWidth > 0 && this.terminal.columns !== this.#previousWidth) {
						this.#multiplexerWidthEpochPending = true;
						if (this.#multiplexerWidthEpochBoundary === undefined) {
							this.#multiplexerWidthEpochBoundary = this.#altWidthEpochBoundary;
						}
					}
					this.#resizeEventPending = true;
					this.requestRender();
					return;
				}
				this.#resizeEventPending = true;
				if (!this.#resizeRepaintsInPlace()) {
					this.#beginResizeViewport();
					this.#requestResizeViewportPaint();
					return;
				}
				if (this.#previousWidth > 0 && this.terminal.columns !== this.#previousWidth) {
					this.#multiplexerWidthEpochPending = true;
					if (this.#multiplexerWidthEpochBoundary === undefined) {
						this.#multiplexerWidthEpochBoundary = this.captureNativeScrollbackWidthEpoch();
					}
				}
				this.#armMultiplexerResizeTimer({
					clearScrollback: false,
					hasPendingRender:
						this.#multiplexerResizeTimer === undefined &&
						(this.#renderRequested || this.#renderTimer !== undefined),
				});
			},
			() => this.stop(),
			{ deferInput: this.#inputDeferred },
		);
		if (this.#stopped) return;
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch {}
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		if (!this.#inputDeferred) {
			this.#querySixelSupport();
			this.#queryCellSize();
		}
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}

	enableInput(): void {
		if (!this.#inputDeferred || this.#stopped) return;
		this.#inputDeferred = false;
		this.terminal.enableInput?.();
		this.#querySixelSupport();
		this.#queryCellSize();
	}

	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#querySixelSupport(): void {
		if (TERMINAL.imageProtocol) return;
		if (isImageProtocolForced()) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clearSixelProbeState();
		this.#sixelProbePendingGraphics = true;
		this.#sixelProbeUnsubscribe = this.addInputListener(data => this.#handleSixelProbeInput(data));

		this.terminal.write("\x1b[?2;1;0S");
		this.#sixelProbeTimeout = setTimeout(() => {
			this.#finishSixelProbe(false);
		}, 250);
	}

	#handleSixelProbeInput(data: string): InputListenerResult {
		if (!this.#sixelProbePendingGraphics) {
			return undefined;
		}

		this.#sixelProbeBuffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		while (this.#sixelProbeBuffer.length > 0) {
			const graphicsMatch = this.#sixelProbeBuffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);
			if (!graphicsMatch || graphicsMatch.index === undefined) break;

			passthrough += this.#sixelProbeBuffer.slice(0, graphicsMatch.index);
			this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(graphicsMatch.index + graphicsMatch[0].length);

			if (this.#sixelProbePendingGraphics) {
				this.#sixelProbePendingGraphics = false;

				const status = Number.parseInt(graphicsMatch[1] ?? "", 10);
				const hasGeometry = (graphicsMatch[2] ?? "").split(";").some(part => Number.parseInt(part, 10) > 0);
				probeOutcome = status === 0 && hasGeometry;
			}
		}

		if (this.#sixelProbePendingGraphics) {
			const partialStart = this.#getSixelProbePartialStart(this.#sixelProbeBuffer);
			if (partialStart >= 0) {
				passthrough += this.#sixelProbeBuffer.slice(0, partialStart);
				this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(partialStart);
			} else {
				passthrough += this.#sixelProbeBuffer;
				this.#sixelProbeBuffer = "";
			}
		} else {
			passthrough += this.#sixelProbeBuffer;
			this.#sixelProbeBuffer = "";
		}

		if (probeOutcome !== null) {
			this.#finishSixelProbe(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
	}

	#getSixelProbePartialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clearSixelProbeState(): void {
		if (this.#sixelProbeTimeout) {
			clearTimeout(this.#sixelProbeTimeout);
			this.#sixelProbeTimeout = undefined;
		}
		if (this.#sixelProbeUnsubscribe) {
			this.#sixelProbeUnsubscribe();
			this.#sixelProbeUnsubscribe = undefined;
		}
		this.#sixelProbePendingGraphics = false;
		this.#sixelProbeBuffer = "";
	}

	#finishSixelProbe(supported: boolean): void {
		this.#clearSixelProbeState();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#queryCellSize();
		this.invalidate();
		this.requestRender(true);
	}
	#queryCellSize(): void {
		if (!TERMINAL.imageProtocol) {
			return;
		}

		this.terminal.write("\x1b[16t");
	}

	#setSynchronizedOutput(enabled: boolean): void {
		if (this.#synchronizedOutputEnabled === enabled) return;
		this.#synchronizedOutputEnabled = enabled;
		this.#paintBeginSequence = enabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
		this.#paintEndSequence = enabled ? PAINT_END : PAINT_END_NO_SYNC;
		this.#cursorBeginSequence = enabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
		this.#cursorEndSequence = enabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	}

	stop(): void {
		if (this.#resizeAltActive) {
			this.terminal.write(this.#leaveResizeAltSequence());
		}
		if (this.#altActive || this.#pendingAltExit) {
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const exitSequence = this.#pendingAltExit || `${mouseExit}${this.#keyboardEnhancementExit()}\x1b[?1049l`;
			this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			this.#pendingAltExit = "";
		}
		this.#purgeInlineImages();
		this.#clearSixelProbeState();
		this.#stopped = true;
		this.#watchdog.stop();
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#ghosttyInitialImageDelayTimer) {
			this.#ghosttyInitialImageDelayTimer.cancel();
			this.#ghosttyInitialImageDelayTimer = undefined;
		}
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
			this.#multiplexerResizeTimer = undefined;
		}
		if (this.#resizeViewportSettleTimer) {
			this.#resizeViewportSettleTimer.cancel();
			this.#resizeViewportSettleTimer = undefined;
		}
		this.#resizeViewportActive = false;
		this.#deferredForcedClearScrollback = false;

		if (this.#previousFrameLength > 0) {
			const targetRow = this.#previousFrameLength;
			const viewportBottom = this.#windowTopRow + this.terminal.rows - 1;
			const clampedCursorRow = Math.max(this.#windowTopRow, Math.min(this.#hardwareCursorRow, viewportBottom));
			const moveTargetRow = Math.min(targetRow, viewportBottom);
			const lineDiff = moveTargetRow - clampedCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write(targetRow <= viewportBottom ? "\r" : "\r\n");
		}

		this.terminal.showCursor(true);
		this.#forgetHardwareCursorState();
		this.terminal.stop();
	}

	resetDisplay(): void {
		if (this.#stopped) return;

		this.invalidate();

		if (this.#multiplexerResizeTimer) {
			this.#armMultiplexerResizeTimer({ clearScrollback: !isMultiplexerSession(), hasPendingRender: true });
			return;
		}
		this.#prepareForcedRender(!isMultiplexerSession());
		this.#resizeEventPending = true;
		this.#renderRequested = false;
		this.#executeRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		this.#pendingRenderComponentsOnly = false;
		if (force) {
			if (this.#multiplexerResizeTimer) {
				this.#armMultiplexerResizeTimer({
					clearScrollback: options?.clearScrollback === true,
					hasPendingRender: true,
				});
				return;
			}

			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#executeRender();
			});
			return;
		}
		this.#requestOrdinaryRender();
	}

	enableScopedInputRender(component: Component): void {
		this.#scopedInputRenderComponents.add(component);
	}

	requestComponentRender(component: Component): void {
		if (this.#stopped) return;

		if (!this.#renderRequested) {
			this.#pendingRenderComponentsOnly = true;
		}
		this.#componentRenderTargets.add(component);
		this.#requestOrdinaryRender();
	}

	requestDirectWrite(component: Component): void {
		if (this.#stopped) return;
		if (this.#renderRequested) {
			this.requestComponentRender(component);
			return;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (!this.#hasEverRendered || this.#resizeEventPending) {
			this.requestComponentRender(component);
			return;
		}
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) {
			this.requestComponentRender(component);
			return;
		}
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) {
			this.requestComponentRender(component);
			return;
		}
		if (this.overlayStack.length > 0 || this.#altActive || !this.#imageBudget.quiescent) {
			this.requestComponentRender(component);
			return;
		}

		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) {
			this.requestComponentRender(component);
			return;
		}
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) {
				this.requestComponentRender(component);
				return;
			}
		}

		const root = this.#resolveComponentRoot(component);
		if (root === null) {
			this.requestComponentRender(component);
			return;
		}
		const segmentIndex = segments.findIndex(segment => segment.component === root);
		if (segmentIndex === -1) {
			this.requestComponentRender(component);
			return;
		}
		const segment = segments[segmentIndex]!;
		const fullyLiveUncommittedSegment = segment.liveLocalStart === 0 && segment.start >= this.#committedRows;
		if (
			(segment.liveLocalStart !== undefined && !fullyLiveUncommittedSegment) ||
			segment.start < this.#committedRows
		) {
			this.requestComponentRender(component);
			return;
		}

		const windowTop = Math.max(this.#committedRows, this.#composedFrame.length - height, 0);
		if (windowTop !== this.#windowTopRow) {
			this.requestComponentRender(component);
			return;
		}
		const screenStart = segment.start - windowTop;
		if (screenStart < 0 || screenStart + segment.rowCount > height) {
			this.requestComponentRender(component);
			return;
		}

		this.#invalidatePreparedRowCache();
		const nextLines = root.render(width);
		if (nextLines.length !== segment.rowCount) {
			this.requestComponentRender(component);
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const previousWindow = this.#previousWindow;
		for (let i = 0; i < nextLines.length; i++) {
			const frameRow = segment.start + i;
			const raw = nextLines[i]!;
			const composed = this.#stripCursorMarkers(raw);
			const prepared = this.#prepareLine(composed, width);
			this.#composedFrame[frameRow] = composed;
			this.#preparedMeta[frameRow] = prepared;
			this.#preparedFrame[frameRow] = prepared.line;
			if (previousWindow[screenStart + i] === prepared.line) continue;
			previousWindow[screenStart + i] = prepared.line;
			if (firstChanged === -1) firstChanged = i;
			lastChanged = i;
		}
		this.#replaceFrameCursorMarkers(segment.start, nextLines);
		segment.lines = nextLines;
		this.#preparedValidRows = Math.max(this.#preparedValidRows, segment.start + nextLines.length);
		this.#renderStablePrefixRows = Math.min(this.#renderStablePrefixRows, segment.start);

		let cursorPos: { row: number; col: number } | null = null;
		for (let i = this.#frameCursorMarkers.length - 1; i >= 0; i--) {
			const marker = this.#frameCursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}

		if (firstChanged === -1) {
			this.#writeCursorPosition(cursorPos, this.#composedFrame.length);
			this.#previousWidth = width;
			this.#previousHeight = height;
			return;
		}

		const currentScreenRow = Math.max(0, Math.min(height - 1, this.#hardwareCursorRow - windowTop));
		const targetScreenRow = screenStart + firstChanged;
		const rowDelta = targetScreenRow - currentScreenRow;
		const output = this.#beginFrameOutput(this.#paintBeginSequence);
		if (rowDelta > 0) output.push(`\x1b[${rowDelta}B`);
		else if (rowDelta < 0) output.push(`\x1b[${-rowDelta}A`);
		output.push("\r");
		for (let i = firstChanged; i <= lastChanged; i++) {
			if (i > firstChanged) output.push("\r\n");
			this.#appendLineRewrite(
				output,
				this.#preparedFrame[segment.start + i] ?? "",
				width,
				screenStart + i,
				segment.start + i,
				this.#committedRows,
				this.#osc66SpacerGlyphWidth(this.#preparedFrame, segment.start + i),
			);
		}
		const cursorControl = this.#cursorControlSequence(
			cursorPos,
			this.#composedFrame.length,
			segment.start + lastChanged,
		);
		output.push(cursorControl.seq, this.#paintEndSequence);
		this.#writeFrameOutput();
		this.#windowTopRow = windowTop;
		this.#commit(this.#composedFrame, previousWindow, width, height, cursorControl);
	}

	#requestOrdinaryRender(): void {
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeHasPendingRender = true;
			return;
		}

		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	#resolvePartialComposeRoots(width: number, height: number): Set<Component> | null {
		if (this.#componentRenderTargets.size === 0) return null;
		if (!this.#hasEverRendered || this.#resizeEventPending) return null;
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) return null;
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) return null;
		if (this.overlayStack.length > 0) return null;

		if (!this.#imageBudget.quiescent) return null;

		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) return null;
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) return null;
		}
		const roots = this.#partialComposeRootsScratch;
		roots.clear();
		for (const target of this.#componentRenderTargets) {
			const root = this.#resolveComponentRoot(target);
			if (root === null) return null;
			roots.add(root);
		}
		return roots;
	}

	#resolveComponentRoot(target: Component): Component | null {
		const cached = this.#componentRootCache.get(target);
		if (cached !== undefined && this.children.includes(cached) && subtreeContains(cached, target)) {
			return cached;
		}
		for (const child of this.children) {
			if (subtreeContains(child, target)) {
				this.#componentRootCache.set(target, child);
				return child;
			}
		}
		this.#componentRootCache.delete(target);
		return null;
	}

	#armMultiplexerResizeTimer(options: { clearScrollback: boolean; hasPendingRender?: boolean }): void {
		this.#deferredForcedClearScrollback ||= options.clearScrollback;
		this.#multiplexerResizeHasPendingRender ||= options.hasPendingRender === true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		this.#renderRequested = false;
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
		}
		this.#multiplexerResizeTimer = this.#renderScheduler.scheduleRender(() => {
			this.#multiplexerResizeTimer = undefined;
			if (this.#stopped) {
				this.#deferredForcedClearScrollback = false;
				return;
			}
			const deferredClearScrollback = this.#deferredForcedClearScrollback;
			this.#deferredForcedClearScrollback = false;
			this.requestRender(true, { clearScrollback: deferredClearScrollback });
		}, TUI.#MULTIPLEXER_RESIZE_DEBOUNCE_MS);
	}

	#maybeDeferGhosttyInitialImagePaint(): boolean {
		if (this.#ghosttyInitialImageDelayDone) return false;
		if (TERMINAL.id !== "ghostty" || TERMINAL.imageProtocol !== ImageProtocol.Kitty) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}
		if (!this.#imageBudget.hasPendingTransmits()) return false;
		if (this.#ghosttyInitialImageDelayTimer) return true;

		const delayMs = Math.max(0, this.#ghosttyImageReadyAtMs - this.#renderScheduler.now());
		if (delayMs === 0) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}

		this.#ghosttyInitialImageDelayTimer = this.#renderScheduler.scheduleRender(() => {
			this.#ghosttyInitialImageDelayTimer = undefined;
			this.#ghosttyInitialImageDelayDone = true;
			if (this.#stopped) return;
			this.#executeRender();
			if (this.#renderRequested) this.#scheduleRender();
		}, delayMs);
		return true;
	}
	#invalidatePreparedRowCache(): void {
		this.#preparedCacheValid = false;
	}

	#prepareForcedRender(clearScrollback: boolean): void {
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
	}

	#runScheduledRender = (): void => {
		this.#renderTimer = undefined;
		if (this.#stopped || !this.#renderRequested) {
			return;
		}
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) {
			this.#scheduleRender();
		}
	};

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}

		if (this.#multiplexerResizeTimer) {
			return;
		}
		const now = this.#renderScheduler.now();
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);

		const adaptiveFloor = Math.min(TUI.#MAX_ADAPTIVE_RENDER_MS, this.#lastFrameCostMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		const delay = Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
		this.#renderTimer = this.#renderScheduler.scheduleRender(this.#runScheduledRender, delay);
	}

	#executeRender(): void {
		if (this.#deferRenderForOutputBacklog()) return;
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		this.#doRender();
		this.#lastFrameCostMs = this.#renderScheduler.now() - start;
	}

	#deferRenderForOutputBacklog(): boolean {
		const pending = this.terminal.pendingOutputBytes;
		if (pending === undefined || pending <= TUI.#MAX_PENDING_OUTPUT_BYTES) return false;
		this.#renderRequested = true;
		this.#renderTimer ??= this.#renderScheduler.scheduleRender(
			this.#runScheduledRender,
			TUI.#OUTPUT_BACKLOG_RETRY_MS,
		);
		return true;
	}

	#handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayVisible(focusedOverlay)) {
			const topVisible = this.#getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		const focused = this.#focusedComponent;
		if (focused?.handleInput) {
			if (isKeyRelease(data) && !focused.wantsKeyRelease) {
				return;
			}
			focused.handleInput(data);
			if (this.#focusedComponent === focused && this.#scopedInputRenderComponents.has(focused)) {
				this.requestComponentRender(focused);
			} else {
				this.requestRender();
			}
		}
	}

	#consumeCellSizeResponse(data: string): boolean {
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });

		this.invalidate();
		this.requestRender();
		return true;
	}

	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number } {
		const opt = options ?? {};

		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);

		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}

		width = Math.max(1, Math.min(width, availWidth));

		let maxHeight = parseSizeValue(opt.maxHeight, termHeight) ?? availHeight;
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));

		const effectiveHeight = Math.min(overlayHeight, maxHeight);

		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				row = opt.row;
			}
		} else {
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				col = opt.col;
			}
		} else {
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	#acquireWindow(height: number): string[] {
		const window = this.#previousWindow === this.#windowScratchA ? this.#windowScratchB : this.#windowScratchA;
		window.length = height;
		return window;
	}

	#compositeOverlaysIntoWindow(window: string[], termWidth: number, termHeight: number): string[] {
		const result = window;
		for (const entry of this.overlayStack) {
			if (!this.#isOverlayVisible(entry)) continue;
			const { component, options } = entry;

			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);
			let overlayLines = component.render(width);
			if (overlayLines.length > maxHeight) {
				const anchor = options?.anchor ?? "center";
				overlayLines =
					anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
						? overlayLines.slice(overlayLines.length - maxHeight)
						: overlayLines.slice(0, maxHeight);
			}
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = row + i;
				if (idx < 0 || idx >= result.length) continue;
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > width ? sliceByColumn(overlayLines[i], 0, width, true) : overlayLines[i];
				result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
	}

	#compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (TERMINAL.isImageLine(baseLine)) {
			if (startCol !== 0 || overlayWidth < totalWidth) return baseLine;
			const overlay = sliceWithWidth(overlayLine, 0, totalWidth, true);
			return SEGMENT_RESET + overlay.text + " ".repeat(Math.max(0, totalWidth - overlay.width));
		}

		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		const r = SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}

		return sliceByColumn(result, 0, totalWidth, true);
	}

	#extractCursorMarkers(lines: string[]): { row: number; col: number }[] {
		const markers: { row: number; col: number }[] = [];
		for (let row = lines.length - 1; row >= 0; row--) {
			const line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			const beforeMarker = line.slice(0, markerIndex);
			markers.push({ row, col: visibleWidth(beforeMarker) });
			let stripped = line;
			while (markerIndex !== -1) {
				stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
			}
			lines[row] = stripped;
		}
		return markers;
	}

	#imageLineSequence(line: string, screenRow: number, frameRow: number, committedTo: number): string {
		if (screenRow < 0) return line;
		const parsed = parseKittyDirectPlacementLine(line);
		if (!parsed) return line;

		const placement = this.#imageBudget.resolvePlacementEmit(
			parsed.imageId,
			frameRow >= 0 ? frameRow - Math.min(parsed.rows - 1, screenRow) : -1,
			committedTo,
		);
		if (!placement) return line;
		return encodeKittyPlacementLine({
			imageId: parsed.imageId,
			placementId: placement.placementId,
			columns: parsed.columns,
			rows: parsed.rows,
			screenRow,
			imageHeightPx: placement.heightPx,
		});
	}

	#terminalLine(line: string, screenRow = -1, frameRow = -1, committedTo = -1): string {
		if (TERMINAL.isImageLine(line)) return this.#imageLineSequence(line, screenRow, frameRow, committedTo);
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	#terminalLineForFrame(
		line: string,
		width: number,
		screenRow: number,
		frameRow: number,
		committedTo: number,
	): string {
		const prepared = frameRow >= 0 ? this.#preparedMeta[frameRow] : undefined;
		if (prepared?.width === width && prepared.line === line) {
			if (prepared.terminalLine !== undefined) return prepared.terminalLine;
			const terminalLine = this.#terminalLine(line, screenRow, frameRow, committedTo);
			if (prepared.asciiWidth !== undefined) prepared.terminalLine = terminalLine;
			return terminalLine;
		}
		return this.#terminalLine(line, screenRow, frameRow, committedTo);
	}

	#beginFrameOutput(first: string, second?: string, third?: string, fourth?: string): string[] {
		const output = this.#frameOutput;
		output.length = 0;
		output.push(first);
		if (second !== undefined) output.push(second);
		if (third !== undefined) output.push(third);
		if (fourth !== undefined) output.push(fourth);
		return output;
	}

	#writeFrameOutput(): void {
		const output = this.#frameOutput;
		const maxChunk = TUI.#MAX_FRAME_WRITE_CHUNK_CODE_UNITS;
		try {
			let chunk = "";
			const flush = (): void => {
				if (chunk.length === 0) return;
				this.terminal.write(chunk);
				chunk = "";
			};

			for (const fragment of output) {
				if (fragment.length === 0) continue;
				if (fragment.length <= maxChunk) {
					if (chunk.length > 0 && chunk.length + fragment.length > maxChunk) flush();
					chunk += fragment;
					continue;
				}

				let offset = 0;
				while (offset < fragment.length) {
					if (chunk.length === maxChunk) flush();
					const capacity = maxChunk - chunk.length;
					const remaining = fragment.length - offset;
					if (remaining <= capacity) {
						chunk += fragment.slice(offset);
						offset = fragment.length;
						continue;
					}

					let boundary = frameOutputBoundary(fragment, offset, capacity);
					if (boundary === offset) {
						if (chunk.length > 0) {
							flush();
							continue;
						}
						const escapeEnd =
							fragment.charCodeAt(offset) === CC_ESC ? frameOutputEscapeEnd(fragment, offset) : offset + 1;
						if (escapeEnd > offset + capacity) {
							// A control sequence longer than the chunk cap must stay intact;
							// plain text and shorter escape sequences remain bounded below.
							this.terminal.write(fragment.slice(offset, escapeEnd));
							offset = escapeEnd;
							continue;
						}
						boundary = Math.min(fragment.length, offset + capacity);
						if (boundary === offset) boundary = offset + 1;
					}
					chunk += fragment.slice(offset, boundary);
					offset = boundary;
					if (chunk.length === maxChunk) flush();
				}
			}
			flush();
		} finally {
			output.length = 0;
		}
	}

	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		const componentScopedOnly = this.#pendingRenderComponentsOnly;
		this.#pendingRenderComponentsOnly = false;

		let deferredAltExit = this.#pendingAltExit;
		const topOverlay = this.#getTopmostVisibleOverlay();
		const wantAlt = topOverlay?.options?.fullscreen === true;
		const wantMouseTracking = wantAlt && topOverlay.options?.mouseTracking !== false;
		if (wantAlt && !this.#altActive) {
			this.#invalidatePreparedRowCache();
			const mouseEnter = wantMouseTracking ? MOUSE_TRACKING_ON : "";
			this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}${mouseEnter}`);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			this.#altActive = true;
			this.#altMouseTrackingActive = wantMouseTracking;
			this.#altPreviousLines = [];
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
			this.#altWidthEpochBoundary = this.captureNativeScrollbackWidthEpoch();
		} else if (!wantAlt && this.#altActive) {
			this.#invalidatePreparedRowCache();
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const enhancementExit = this.#keyboardEnhancementExit();
			const exitSequence = `${mouseExit}${enhancementExit}\x1b[?1049l`;

			if (this.#clearScrollbackOnNextRender) {
				this.#pendingAltExit = exitSequence;
				deferredAltExit = exitSequence;
			} else this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#forgetHardwareCursorState();
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			this.#altWidthEpochBoundary = undefined;

			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				this.#resizeEventPending = true;
				if (width === this.#altEnterWidth) this.#altToggleResizesInPlace = true;
			}
		} else if (wantMouseTracking !== this.#altMouseTrackingActive) {
			this.terminal.write(wantMouseTracking ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
			this.#altMouseTrackingActive = wantMouseTracking;
		}
		if (this.#altActive) {
			this.#componentRenderTargets.clear();
			this.#renderAltFrame(width, height);
			return;
		}

		if (this.#resizeViewportActive && this.#hasEverRendered && this.#getTopmostVisibleOverlay() === undefined) {
			this.#componentRenderTargets.clear();
			this.#renderResizeViewport(width, height);
			return;
		}

		const replayFullHistory =
			this.#hasEverRendered &&
			!this.#resizeRepaintsInPlace() &&
			(this.#clearScrollbackOnNextRender ||
				this.#resizeEventPending ||
				(this.#previousWidth > 0 && this.#previousWidth !== width) ||
				(this.#previousHeight > 0 && this.#previousHeight !== height));
		if (replayFullHistory) {
			for (const child of this.children) prepareNativeScrollbackReplay(child);
		}

		const partialRoots = componentScopedOnly ? this.#resolvePartialComposeRoots(width, height) : null;
		this.#componentRenderTargets.clear();
		let rawFrame: readonly string[];
		if (partialRoots !== null) {
			this.#partialComposeRoots = partialRoots;
			try {
				rawFrame = this.render(width);
			} finally {
				this.#partialComposeRoots = null;
			}
		} else {
			this.#imageBudget.beginPass();
			rawFrame = this.render(width);
			this.#imageBudget.endPass();
		}

		if (this.#maybeDeferGhosttyInitialImagePaint()) return;

		const cursorMarkers = this.#frameCursorMarkers;
		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;
		const liveRegionPinned = this.#nativeScrollbackLiveRegionPinned;

		const frameLength = rawFrame.length;
		const finalBoundary = Math.max(0, Math.min(frameLength, liveRegionStart ?? frameLength));

		const commitCeiling = this.#nativeScrollbackPinnedBoundary ?? frameLength;

		let prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		const resizeHadPendingRender = this.#multiplexerResizeHasPendingRender;
		this.#multiplexerResizeHasPendingRender = false;
		if (resizeEventOccurred) this.#forgetHardwareCursorState();
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const widthEpochOccurred = widthChanged || (resizeEventOccurred && this.#multiplexerWidthEpochPending);
		const capturedWidthEpochBoundary = this.#multiplexerWidthEpochBoundary;
		const widthEpochBoundary = this.#widthEpochOverlayBoundary ?? capturedWidthEpochBoundary;
		const widthEpochSourceBoundary = widthEpochOccurred
			? this.resolveNativeScrollbackWidthEpoch(widthEpochBoundary)
			: undefined;
		const widthEpochCurrentRows = widthEpochOccurred
			? this.#getNativeScrollbackWidthEpochCurrentRows(widthEpochBoundary)
			: undefined;
		const widthEpochAppendOnly = widthEpochOccurred
			? this.#isNativeScrollbackWidthEpochAppendOnly(widthEpochBoundary)
			: true;
		if (resizeEventOccurred) {
			this.#multiplexerWidthEpochBoundary = undefined;
			this.#multiplexerWidthEpochPending = false;
		}

		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;
		const widthEpochReset = widthEpochOccurred && this.#resizeRepaintsInPlace();

		const placementEpochWatermark = this.#widthEpochBaselineRows === undefined ? this.#committedRows : prevWindowTop;
		if (widthEpochReset) this.#widthEpochCommittedPrefix = undefined;

		let committedRowsResynced = false;
		const widthEpochPrefix = this.#widthEpochCommittedPrefix;
		if (widthEpochPrefix && !geometryChanged && !this.#clearScrollbackOnNextRender) {
			let newlyFinalRows = 0;
			while (
				newlyFinalRows < widthEpochPrefix.frameRows.length &&
				widthEpochPrefix.frameRows[newlyFinalRows]! < finalBoundary
			) {
				newlyFinalRows++;
			}
			widthEpochPrefix.auditRows = Math.min(widthEpochPrefix.auditRows, newlyFinalRows);
			const verifiedTailRow = widthEpochPrefix.frameRows[widthEpochPrefix.auditRows - 1];
			const shouldAudit =
				newlyFinalRows > widthEpochPrefix.auditRows ||
				(verifiedTailRow !== undefined && this.#renderStablePrefixRows <= verifiedTailRow);
			let resyncTo = -1;
			const firstMissing = widthEpochPrefix.frameRows.findIndex(row => row >= frameLength);
			if (firstMissing >= 0) {
				const surviving = widthEpochPrefix.frameRows.slice(0, firstMissing).map(row => rawFrame[row]!);
				for (let i = 0; i < surviving.length; i++) {
					if (!rowsEquivalent(surviving[i]!, widthEpochPrefix.prefix[i]!)) {
						resyncTo = i;
						break;
					}
				}
				if (resyncTo < 0) resyncTo = firstMissing;
			} else if (shouldAudit) {
				const current = widthEpochPrefix.frameRows.map(row => rawFrame[row]!);
				resyncTo = findCommittedPrefixResync(
					current,
					widthEpochPrefix.prefix,
					widthEpochPrefix.auditRows,
					newlyFinalRows,
				);
				if (resyncTo < 0) widthEpochPrefix.auditRows = newlyFinalRows;
			}
			if (resyncTo >= 0) {
				const recoveryRow = Math.min(frameLength, widthEpochPrefix.frameRows[resyncTo] ?? frameLength);
				widthEpochPrefix.frameRows.length = resyncTo;
				widthEpochPrefix.prefix.length = resyncTo;
				widthEpochPrefix.auditRows = Math.min(widthEpochPrefix.auditRows, resyncTo);
				this.#committedRows = widthEpochPrefix.nativeBaseRows + resyncTo;
				this.#widthEpochBaselineRows = recoveryRow;
				this.#windowTopRow = recoveryRow;
				prevWindowTop = recoveryRow;
				if ($flag("PI_DEBUG_REDRAW")) {
					const msg = `[${new Date().toISOString()}] width epoch commit resync: local prefix diverged at row ${recoveryRow}; recommitting\n`;
					fs.appendFileSync(getDebugLogPath(), msg);
				}
			}
		}
		const newlyFinalEnd = Math.min(this.#committedRows, finalBoundary);

		if (this.#widthEpochBaselineRows === undefined && this.#committedPrefixAuditRows > newlyFinalEnd) {
			this.#committedPrefixAuditRows = newlyFinalEnd;
		}
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			this.#widthEpochBaselineRows === undefined &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < this.#committedPrefixAuditRows ||
				newlyFinalEnd > this.#committedPrefixAuditRows);
		if (auditRan) {
			const committedRowsBeforeAudit = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, newlyFinalEnd);
			committedRowsResynced = this.#committedRows !== committedRowsBeforeAudit;
		}

		if (
			this.#widthEpochBaselineRows === undefined &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			frameLength < this.#committedRows
		) {
			const limit = Math.min(this.#committedRows, frameLength);
			let diverged = limit;
			for (let i = 0; i < limit; i++) {
				if (!rowsEquivalent(rawFrame[i]!, this.#committedPrefix[i]!)) {
					diverged = i;
					break;
				}
			}
			if (diverged < this.#committedRows) {
				this.#committedRows = diverged;
				this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, diverged);
				this.#committedPrefix.length = diverged;
				committedRowsResynced = true;
			}
		}

		const preCommitRows = this.#committedRows;
		const preAuditRows = this.#committedPrefixAuditRows;
		let committedPrefixResliced = false;

		let hasVisibleOverlay = false;
		for (const entry of this.overlayStack) {
			if (this.#isOverlayVisible(entry)) {
				hasVisibleOverlay = true;
				break;
			}
		}

		if (widthEpochReset && hasVisibleOverlay && widthEpochSourceBoundary === undefined && resizeHadPendingRender) {
			this.#widthEpochOverlayReplayPending = true;
		}
		if (widthEpochReset && hasVisibleOverlay && this.#widthEpochOverlayBoundary === undefined) {
			this.#widthEpochOverlayBoundary = capturedWidthEpochBoundary;
		}

		if (widthEpochReset && hasVisibleOverlay && this.#resizeScrollbackMode !== "preserve") {
			this.#resizeScrollbackReplayPending = true;
		}
		const replayUnresolvedOverlayFrame = widthEpochReset && this.#widthEpochOverlayReplayPending;
		const replayUnresolvedWidthEpoch =
			replayUnresolvedOverlayFrame ||
			(widthEpochReset && liveRegionPinned && this.#widthEpochReplayUnresolved) ||
			(widthEpochReset &&
				resizeHadPendingRender &&
				widthEpochBoundary !== undefined &&
				widthEpochSourceBoundary === undefined);
		if (replayUnresolvedWidthEpoch) prevWindowTop = 0;

		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !this.#resizeRepaintsInPlace();

		const divergenceRebuild =
			this.#scrollbackRebuildEnabled &&
			!firstPaint &&
			!replaceRequested &&
			!geometryChanged &&
			!isMultiplexerSession() &&
			(committedRowsResynced || frameLength <= this.#committedRows);

		const resizeScrollbackReplay =
			(widthEpochReset || this.#resizeScrollbackReplayPending) &&
			!hasVisibleOverlay &&
			this.#resizeScrollbackMode !== "preserve";
		const fullPaint =
			firstPaint || replaceRequested || geometryRebuild || divergenceRebuild || resizeScrollbackReplay;

		if (fullPaint || widthChanged) {
			this.#muxPushedRows = 0;
		} else if (
			geometryChanged &&
			this.#previousHeight > 0 &&
			this.#previousFrameLength - this.#windowTopRow >= this.#previousHeight
		) {
			if (this.#committedRows !== this.#muxPushSeam) this.#muxPushedRows = 0;
			if (height < this.#previousHeight) {
				this.#muxPushedRows += this.#previousHeight - height;
				this.#muxPushSeam = this.#committedRows;
			} else if (height > this.#previousHeight) {
				const pull = height - this.#previousHeight;
				const fromPushed = Math.min(pull, this.#muxPushedRows);
				this.#muxPushedRows -= fromPushed;
				const fromCommitted = Math.min(pull - fromPushed, this.#committedRows);
				this.#committedRows -= fromCommitted;
				this.#committedPrefix.length = this.#committedRows;
				this.#muxPushSeam = this.#committedRows;
			}
		}
		let windowTop: number;
		let chunkTo: number;
		let widthEpochAppendFrom = 0;
		let widthEpochAppendTo = 0;
		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, commitCeiling);
		} else if (widthEpochReset) {
			this.#widthEpochBaselineRows = replayUnresolvedWidthEpoch
				? 0
				: (widthEpochSourceBoundary ??
					(resizeHadPendingRender ? Math.min(frameLength, this.#previousFrameLength) : frameLength));
			this.#widthEpochReplayUnresolved = replayUnresolvedWidthEpoch;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = this.#committedRows;
			widthEpochAppendFrom = this.#widthEpochBaselineRows;
			widthEpochAppendTo =
				hasVisibleOverlay || widthEpochCurrentRows === undefined
					? hasVisibleOverlay
						? widthEpochAppendFrom
						: Math.max(widthEpochAppendFrom, commitCeiling)
					: Math.max(widthEpochAppendFrom, widthEpochCurrentRows);
		} else if (this.#widthEpochBaselineRows !== undefined) {
			windowTop = Math.max(0, frameLength - height);
			chunkTo = this.#committedRows;
			widthEpochAppendFrom = this.#widthEpochBaselineRows;
			const appendBoundary = commitCeiling;
			widthEpochAppendTo = hasVisibleOverlay ? widthEpochAppendFrom : Math.max(widthEpochAppendFrom, appendBoundary);
		} else if (
			frameLength <= this.#committedRows ||
			(committedRowsResynced &&
				frameLength - this.#committedRows < height &&
				cursorMarkers.some(marker => marker.row >= this.#committedRows))
		) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, commitCeiling);
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else if (geometryChanged && Math.max(0, frameLength - height) < this.#committedRows) {
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
			this.#committedRows = windowTop;
			if (widthChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, windowTop);
			} else {
				this.#committedPrefix.length = Math.min(this.#committedPrefix.length, windowTop);
			}
		} else {
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);

			chunkTo =
				hasVisibleOverlay || geometryChanged
					? this.#committedRows
					: Math.min(windowTop, Math.max(this.#committedRows, commitCeiling));
			if (widthChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		let cursorPos: { row: number; col: number } | null = null;
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}
		const preparedReuseBlocked =
			resizeEventOccurred ||
			geometryChanged ||
			widthEpochOccurred ||
			widthEpochReset ||
			this.#clearScrollbackOnNextRender ||
			this.#widthEpochBaselineRows !== undefined ||
			this.#widthEpochCommittedPrefix !== undefined ||
			this.#widthEpochOverlayReplayPending ||
			this.#widthEpochOverlayBoundary !== undefined ||
			this.#resizeScrollbackReplayPending ||
			liveRegionStart !== undefined ||
			liveRegionPinned ||
			commitCeiling !== frameLength ||
			hasVisibleOverlay;
		const frame = this.#prepareFrame(rawFrame, width, height, preparedReuseBlocked, hasVisibleOverlay);
		const window = this.#acquireWindow(height);
		for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";
		if (hasVisibleOverlay) {
			this.#compositeOverlaysIntoWindow(window, width, height);
			const overlayMarkers = this.#extractCursorMarkers(window);
			if (overlayMarkers.length > 0) {
				cursorPos = { row: windowTop + overlayMarkers[0]!.row, col: overlayMarkers[0]!.col };
			}
			const preparedWindow = this.#prepareLinesArray(window, width);
			for (let i = 0; i < preparedWindow.length; i++) window[i] = preparedWindow[i]!;
		}
		const cursorTrackingLineCount = hasVisibleOverlay ? Math.max(frame.length, windowTop + height) : frame.length;

		const intent: RenderIntent = fullPaint
			? {
					kind: "fullPaint",
					clearScrollback:
						divergenceRebuild ||
						(resizeScrollbackReplay && this.#resizeScrollbackMode === "rebuild") ||
						((replaceRequested || geometryRebuild) && !isMultiplexerSession()),
				}
			: { kind: "update", chunkTo, windowTop };
		this.#logRedraw(intent, frameLength, height);

		let imageTransmitBuffer = "";
		for (const seq of this.#imageBudget.takeTransmits()) imageTransmitBuffer += seq;

		let purgeSequence = "";
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takePurgeIds()) purgeSequence += encodeKittyDeleteImage(id);
		} else {
			this.#imageBudget.takePurgeIds();
		}

		if (widthEpochReset && !(intent.kind === "fullPaint" && intent.clearScrollback)) {
			this.#imageBudget.observeCommitWatermark(placementEpochWatermark);
			this.#imageBudget.beginPlacementCoordinateEpoch();
		} else if (intent.kind === "fullPaint" || this.#widthEpochBaselineRows === undefined) {
			this.#imageBudget.observeCommitWatermark(chunkTo);
		}

		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, purgeSequence, imageTransmitBuffer, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
				cursorTrackingLineCount,
				leadingSequence: deferredAltExit,

				copyScreenToScrollback: !resizeScrollbackReplay,
			});
			this.#pendingAltExit = "";
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			this.#committedPrefixAuditRows = Math.min(chunkTo, finalBoundary);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#widthEpochBaselineRows = undefined;
			this.#widthEpochReplayUnresolved = false;
			this.#widthEpochOverlayReplayPending = false;
			this.#widthEpochOverlayBoundary = undefined;
			this.#widthEpochCommittedPrefix = undefined;
			this.#resizeScrollbackReplayPending = false;
			this.#publishCommittedRows();
			return;
		}
		if (this.#widthEpochBaselineRows !== undefined) {
			const logicalAppend =
				!replayUnresolvedOverlayFrame &&
				widthEpochSourceBoundary !== undefined &&
				widthEpochCurrentRows !== undefined;
			const logicalPrefixAppend = logicalAppend && widthEpochAppendOnly;
			let scrollRows: number;
			let commitFrom: number;
			let commitTo: number;
			if (replayUnresolvedWidthEpoch) {
				commitFrom = 0;
				commitTo = Math.min(windowTop, commitCeiling);
				scrollRows = commitTo;
			} else if (logicalAppend && !logicalPrefixAppend) {
				const sourceWindowTop = Math.max(0, widthEpochSourceBoundary - height);
				const logicalSuffixRows = Math.max(0, widthEpochCurrentRows - widthEpochSourceBoundary);
				const appendWindowMovement = Math.max(0, windowTop - sourceWindowTop);
				scrollRows = Math.min(logicalSuffixRows, appendWindowMovement);
				commitFrom = Math.max(0, windowTop - scrollRows);
				commitTo = commitFrom + scrollRows;
			} else if (!logicalAppend) {
				const windowMovement = Math.max(0, windowTop - prevWindowTop);
				const previousViewportRows = Math.min(
					this.#previousHeight,
					Math.max(0, this.#previousFrameLength - prevWindowTop),
				);
				const hostHeightShrinkRows = Math.min(windowMovement, Math.max(0, previousViewportRows - height));
				const appendWindowMovement = windowMovement - hostHeightShrinkRows;
				const epochGrowthRows = Math.max(0, widthEpochAppendTo - widthEpochAppendFrom);
				scrollRows = Math.min(appendWindowMovement, epochGrowthRows);
				commitFrom = prevWindowTop + hostHeightShrinkRows;
				commitTo = commitFrom + scrollRows;
			} else {
				commitFrom = widthEpochSourceBoundary;
				const logicalSuffixRows = Math.max(0, widthEpochCurrentRows - commitFrom);
				const sourceWindowTop = Math.max(0, commitFrom - height);
				const appendWindowMovement = Math.max(0, windowTop - sourceWindowTop);
				scrollRows = Math.min(logicalSuffixRows, appendWindowMovement);
				commitTo = commitFrom + scrollRows;
			}
			if (hasVisibleOverlay) {
				scrollRows = 0;
				commitTo = commitFrom;
			}
			this.#imageBudget.observeCommitWatermark(commitTo);
			this.#emitWidthEpochBaseline(frame, window, width, height, cursorPos, purgeSequence, imageTransmitBuffer, {
				repaintFromScreenRow: 0,
				commitFrom,
				commitTo,
				appendOnly: logicalAppend,
				prepaintWindowTop: logicalAppend && !logicalPrefixAppend && !hasVisibleOverlay ? commitFrom : undefined,
				windowTop,
				cursorTrackingLineCount,
				leadingSequence: deferredAltExit,
			});
			this.#pendingAltExit = "";
			if (!hasVisibleOverlay) {
				this.#widthEpochOverlayReplayPending = false;
				this.#widthEpochOverlayBoundary = undefined;
				if (liveRegionPinned) {
					this.#widthEpochBaselineRows = this.#widthEpochReplayUnresolved ? commitTo : widthEpochAppendTo;
					this.#windowTopRow = logicalAppend ? windowTop : prevWindowTop + scrollRows;
				} else {
					this.#widthEpochBaselineRows = frameLength;
					this.#widthEpochReplayUnresolved = false;
					this.#windowTopRow = windowTop;
				}
				this.#committedRows += scrollRows;
				if (!widthEpochReset && this.#widthEpochCommittedPrefix) {
					const epochPrefix = this.#widthEpochCommittedPrefix;

					const overlap = epochPrefix.frameRows.findIndex(row => row >= commitFrom);
					if (overlap >= 0) {
						epochPrefix.nativeBaseRows += epochPrefix.frameRows.length - overlap;
						epochPrefix.frameRows.length = overlap;
						epochPrefix.prefix.length = overlap;
						epochPrefix.auditRows = Math.min(epochPrefix.auditRows, overlap);
					}
					for (let row = commitFrom; row < commitTo; row++) {
						epochPrefix.frameRows.push(row);
						epochPrefix.prefix.push(rawFrame[row]!);
					}
					while (
						epochPrefix.auditRows < epochPrefix.frameRows.length &&
						epochPrefix.frameRows[epochPrefix.auditRows]! < finalBoundary
					) {
						epochPrefix.auditRows++;
					}
				}
			} else if (widthEpochReset) {
				this.#windowTopRow = replayUnresolvedOverlayFrame
					? 0
					: logicalAppend
						? Math.max(0, widthEpochSourceBoundary! - height)
						: windowTop;
			}
			if (widthEpochReset) {
				let trackedFrom = commitFrom;
				let trackedTo = commitTo;
				if (logicalPrefixAppend) trackedTo = Math.max(trackedFrom, trackedTo - height);
				if (trackedTo > this.#windowTopRow) {
					trackedFrom = trackedTo;
				}
				const frameRows = Array.from({ length: trackedTo - trackedFrom }, (_value, index) => trackedFrom + index);
				let auditRows = 0;
				while (auditRows < frameRows.length && frameRows[auditRows]! < finalBoundary) auditRows++;
				this.#widthEpochCommittedPrefix = {
					nativeBaseRows: this.#committedRows - frameRows.length,
					frameRows,
					prefix: frameRows.map(row => rawFrame[row]!),
					auditRows,
				};
			}
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#publishCommittedRows(this.#windowTopRow);
			return;
		}
		if (imageTransmitBuffer.length > 0) {
			this.terminal.write(imageTransmitBuffer);
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, purgeSequence, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite:
				this.#forceViewportRepaintOnNextRender || (geometryChanged && this.#resizeRepaintsInPlace()),
			repaintVirtualScrollInPlace: hasVisibleOverlay,
			cursorTrackingLineCount,
		});
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}

		if (committedPrefixResliced || auditRan || preAuditRows >= Math.min(preCommitRows, finalBoundary)) {
			this.#committedPrefixAuditRows = Math.min(this.#committedRows, finalBoundary);
		} else {
			this.#committedPrefixAuditRows = Math.min(preAuditRows, this.#committedRows);
		}
		this.#publishCommittedRows();
	}

	#auditCommittedPrefix(rawFrame: readonly string[], newlyFinalEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(rawFrame, prefix, this.#committedPrefixAuditRows, newlyFinalEnd);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		prefix.length = resyncTo;
		if ($flag("PI_DEBUG_REDRAW")) {
			const msg = `[${new Date().toISOString()}] commit resync: committed prefix diverged at row ${resyncTo}; recommitting\n`;
			fs.appendFileSync(getDebugLogPath(), msg);
		}
	}

	#publishCommittedRows(committedRows = this.#committedRows): void {
		for (const segment of this.#frameSegments) {
			setNativeScrollbackCommittedRows(
				segment.component,
				Math.min(segment.rowCount, Math.max(0, committedRows - segment.start)),
			);
		}
	}

	#prepareFrame(
		frame: readonly string[],
		width: number,
		height: number,
		reuseBlocked: boolean,
		overlayVisible: boolean,
	): string[] {
		const prepared = this.#preparedFrame;
		const meta = this.#preparedMeta;
		const previousRaw = this.#preparedRawFrame;
		// This cache is indexed by logical frame rows, not screen rows. A viewport slide
		// changes windowTop but never changes which logical row lives at frame[i].
		// Keeping that distinction avoids reusing a prepared row for the wrong screen row.
		const canReuse =
			!reuseBlocked &&
			this.#preparedCacheValid &&
			this.#preparedCacheWidth === width &&
			this.#preparedCacheHeight === height &&
			this.#preparedCacheOverlay === overlayVisible &&
			this.#preparedCacheAlt === this.#altActive &&
			this.#preparedCacheImageProtocol === TERMINAL.imageProtocol;

		if (prepared.length > frame.length) prepared.length = frame.length;
		if (meta.length > frame.length) meta.length = frame.length;
		if (previousRaw.length > frame.length) previousRaw.length = frame.length;
		if (this.#preparedRowSafety.length > frame.length) this.#preparedRowSafety.length = frame.length;
		const preparedRows = canReuse ? Math.min(this.#preparedValidRows, frame.length) : 0;
		let firstRow = preparedRows;
		let endRow = frame.length;
		if (canReuse) {
			const changedFrom = this.getComposedFrameChangedFrom();
			const changedTo = Math.min(frame.length, this.getComposedFrameChangedTo());
			if (changedFrom < changedTo) {
				firstRow = Math.min(preparedRows, changedFrom);
				endRow = Math.max(preparedRows, changedTo);
			}
		}
		for (let i = firstRow; i < endRow; i++) {
			const raw = frame[i]!;
			const sameRaw = canReuse && previousRaw[i] === raw;
			const reusable =
				sameRaw && raw.length > 0 && this.#preparedRowSafety[i] === 1
					? true
					: this.#isPreparedRowReusable(frame, i, raw);
			const entry = sameRaw && reusable ? meta[i]! : this.#prepareLine(raw, width, meta[i]);
			meta[i] = entry;
			prepared[i] = entry.line;
			previousRaw[i] = raw;
			this.#preparedRowSafety[i] = reusable && raw.length > 0 ? 1 : 0;
		}
		this.#preparedValidRows = frame.length;
		this.#preparedCacheWidth = width;
		this.#preparedCacheHeight = height;
		this.#preparedCacheOverlay = overlayVisible;
		this.#preparedCacheAlt = this.#altActive;
		this.#preparedCacheImageProtocol = TERMINAL.imageProtocol;
		this.#preparedCacheValid = true;
		return prepared;
	}

	#isPreparedRowReusable(frame: readonly string[], row: number, raw: string): boolean {
		if (raw.length === 0) return this.#osc66SpacerGlyphWidth(frame, row) < 0;
		if (raw.charCodeAt(0) !== CC_ESC) return true;
		if (raw.includes("\x1b]66;")) return false;
		return TERMINAL.imageProtocol === null || !TERMINAL.isImageLine(raw);
	}

	#prepareLinesArray(lines: readonly string[], width: number): string[] {
		const prepared: string[] = new Array(lines.length);
		for (let i = 0; i < lines.length; i++) {
			prepared[i] = this.#prepareLine(lines[i]!, width).line;
		}
		return prepared;
	}

	#prepareLine(raw: string, width: number, reusable?: PreparedLine): PreparedLine {
		const entry =
			reusable ??
			({ raw: "", width: 0, line: "", asciiWidth: undefined, terminalLine: undefined } satisfies PreparedLine);
		entry.raw = raw;
		entry.width = width;
		entry.terminalLine = undefined;
		if (TERMINAL.isImageLine(raw)) {
			entry.line = raw;
			entry.asciiWidth = undefined;
			return entry;
		}
		const source = this.#lineFitSource(raw, width);
		const normalized = normalizeTerminalOutput(source);
		const normalizedWidth = this.#ansiAsciiLineWidth(normalized, width);
		let line = normalized;
		let asciiWidth = normalizedWidth;
		if ((normalizedWidth ?? visibleWidth(normalized)) > width) {
			line = truncateToWidth(normalized, width, Ellipsis.Omit);
			asciiWidth = this.#ansiAsciiLineWidth(line, width);
		}
		entry.line = line;
		entry.asciiWidth = asciiWidth;
		return entry;
	}

	#lineFitSource(raw: string, width: number): string {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const maxSourceLength = Math.min(
			LINE_FIT_MAX_SOURCE_CODE_UNITS,
			Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
		);
		if (raw.length <= maxSourceLength) return raw;

		let output = "";
		let cells = 0;
		for (let i = 0; i < raw.length && cells < safeWidth; ) {
			if (raw.charCodeAt(i) === 0x1b) {
				const end = this.#ansiSequenceEnd(raw, i);
				if (end < 0) break;
				if (this.#ansiSequenceHasVisiblePayload(raw, i)) {
					const sequence = raw.slice(i, end);
					if (output.length + sequence.length <= maxSourceLength) {
						output += sequence;
						cells += visibleWidth(sequence);
					}
				}
				i = end;
				continue;
			}

			const code = raw.charCodeAt(i);
			if (code >= 0x20 && code <= 0x7e) {
				if (output.length >= maxSourceLength) break;
				const cap = i + Math.min(safeWidth - cells, maxSourceLength - output.length);
				let j = i + 1;
				while (j < raw.length && j < cap) {
					const c = raw.charCodeAt(j);
					if (c < 0x20 || c > 0x7e) break;
					j++;
				}
				output += raw.slice(i, j);
				cells += j - i;
				i = j;
				continue;
			}

			const next = code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length ? i + 2 : i + 1;
			const char = raw.slice(i, next);
			const charWidth = visibleWidth(char);
			if (charWidth > 0 && cells + charWidth > safeWidth) break;
			if (output.length + char.length > maxSourceLength) {
				if (charWidth > 0) break;
				i = next;
				continue;
			}
			if (charWidth === 0) {
				const remainingVisibleCells = safeWidth - cells;
				const reservedCodeUnits = remainingVisibleCells * 2;
				if (output.length + char.length > maxSourceLength - reservedCodeUnits) {
					i = next;
					continue;
				}
			}
			output += char;
			cells += charWidth;
			i = next;
		}

		return output + SEGMENT_RESET;
	}

	#ansiSequenceEnd(line: string, start: number): number {
		const next = line.charCodeAt(start + 1);
		if (next === 0x5b) {
			let i = start + 2;
			while (i < line.length) {
				const final = line.charCodeAt(i);
				if (final >= 0x40 && final <= 0x7e) return i + 1;
				i++;
			}
			return -1;
		}
		if (next === 0x5d) {
			let i = start + 2;
			while (i < line.length) {
				const osc = line.charCodeAt(i);
				if (osc === 0x07) return i + 1;
				if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
				i++;
			}
			return -1;
		}
		return start + 2 <= line.length ? start + 2 : -1;
	}

	#ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
		return (
			line.charCodeAt(start + 1) === 0x5d &&
			line.charCodeAt(start + 2) === 0x36 &&
			line.charCodeAt(start + 3) === 0x36 &&
			line.charCodeAt(start + 4) === 0x3b
		);
	}

	#ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
		let col = 0;
		for (let i = 0; i < line.length; ) {
			const code = line.charCodeAt(i);
			if (code === 0x1b) {
				const next = line.charCodeAt(i + 1);
				if (next === 0x5b) {
					let j = i + 2;
					while (j < line.length) {
						const final = line.charCodeAt(j);
						if (final >= 0x40 && final <= 0x7e) break;
						j++;
					}
					if (j >= line.length) return undefined;
					i = j + 1;
					continue;
				}
				if (next === 0x5d) {
					if (
						line.charCodeAt(i + 2) === 0x36 &&
						line.charCodeAt(i + 3) === 0x36 &&
						line.charCodeAt(i + 4) === 0x3b
					) {
						return undefined;
					}
					let j = i + 2;
					while (j < line.length) {
						const osc = line.charCodeAt(j);
						if (osc === 0x07) {
							i = j + 1;
							break;
						}
						if (osc === 0x1b && line.charCodeAt(j + 1) === 0x5c) {
							i = j + 2;
							break;
						}
						j++;
					}
					if (j >= line.length) return undefined;
					continue;
				}
				return undefined;
			}
			if (code < 0x20 || code > 0x7e) return undefined;
			col++;
			if (col > maxWidth) return col;
			i++;
		}
		return col;
	}

	#osc66SpacerGlyphWidth(lines: readonly string[], index: number): number {
		if (index <= 0 || lines[index] !== "") return -1;
		let gap = 1;
		while (gap < TUI.#OSC66_MAX_SPACER_ROWS && index - gap > 0 && lines[index - gap] === "") {
			gap++;
		}
		const above = lines[index - gap];
		if (above === undefined || !isOsc66Line(above) || gap > osc66MaxScale(above) - 1) return -1;
		return visibleWidth(above);
	}

	#appendLineRewrite(
		output: string[],
		line: string,
		width: number,
		screenRow = -1,
		frameRow = -1,
		committedTo = -1,
		spacerGlyphWidth = -1,
	): void {
		if (spacerGlyphWidth >= 0) {
			if (spacerGlyphWidth < width) output.push(`${SEGMENT_RESET}\x1b[${spacerGlyphWidth}C${ERASE_TO_END_OF_LINE}`);
			return;
		}
		if (TERMINAL.isImageLine(line)) {
			output.push(ERASE_LINE, this.#imageLineSequence(line, screenRow, frameRow, committedTo));
			return;
		}
		const prepared = frameRow >= 0 ? this.#preparedMeta[frameRow] : undefined;
		const cached = prepared?.width === width && prepared.line === line ? prepared : undefined;
		let terminalLine = cached?.terminalLine;
		if (terminalLine === undefined) {
			terminalLine = this.#terminalLine(line);
			if (cached?.asciiWidth !== undefined) cached.terminalLine = terminalLine;
		}
		const asciiWidth = cached ? cached.asciiWidth : this.#ansiAsciiLineWidth(line, width);
		if (asciiWidth !== undefined) {
			output.push(terminalLine);
			if (asciiWidth < width) output.push(ERASE_TO_END_OF_LINE);
			return;
		}

		output.push(SEGMENT_RESET, ERASE_TO_END_OF_LINE, terminalLine);
	}

	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#recordHardwareCursorUpdate(hardwareCursor);
	}

	#targetHardwareCursorState(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#recordHardwareCursorState(state: HardwareCursorState): void {
		this.#hardwareCursorRow = state.row;
		this.#hardwareCursorState = state;
		this.#hardwareCursorVisible = state.visible;
		this.#hardwareCursorVisibilityKnown = true;
	}

	#recordHardwareCursorRowOnly(row: number, visible?: boolean): void {
		this.#hardwareCursorRow = row;
		this.#hardwareCursorState = null;
		if (visible !== undefined) {
			this.#hardwareCursorVisible = visible;
			this.#hardwareCursorVisibilityKnown = true;
		}
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		if (update.state) {
			this.#recordHardwareCursorState(update.state);
			return;
		}
		this.#recordHardwareCursorRowOnly(update.toRow, update.visible);
	}

	#recordHardwareCursorHidden(): void {
		this.#hardwareCursorVisible = false;
		this.#hardwareCursorVisibilityKnown = true;
		if (!this.#hardwareCursorState) return;
		this.#hardwareCursorState = { ...this.#hardwareCursorState, visible: false };
	}

	#forgetHardwareCursorState(): void {
		this.#hardwareCursorState = null;
		this.#hardwareCursorVisibilityKnown = false;
	}

	#sameHardwareCursorState(state: HardwareCursorState): boolean {
		const current = this.#hardwareCursorState;
		return (
			current !== null && current.row === state.row && current.col === state.col && current.visible === state.visible
		);
	}

	#emitWidthEpochBaseline(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		imageTransmitBuffer: string,
		options: {
			repaintFromScreenRow: number;
			commitFrom: number;
			commitTo: number;
			appendOnly: boolean;
			prepaintWindowTop?: number;
			windowTop: number;
			cursorTrackingLineCount: number;
			leadingSequence: string;
		},
	): void {
		this.#fullRedrawCount += 1;
		const output = this.#beginFrameOutput(
			this.#paintBeginSequence,
			purgeSequence,
			options.leadingSequence,
			imageTransmitBuffer,
		);
		if (options.commitTo > options.commitFrom) {
			if (options.appendOnly) {
				if (options.prepaintWindowTop !== undefined) {
					for (let screenRow = 0; screenRow < height; screenRow++) {
						const frameRow = options.prepaintWindowTop + screenRow;
						output.push(`\x1b[${screenRow + 1};1H`);
						this.#appendLineRewrite(output, frame[frameRow] ?? "", width, screenRow, frameRow, options.commitTo);
					}
				}
				output.push(`\x1b[${height};1H`);
				for (let row = options.commitFrom; row < options.commitTo; row++) {
					const enteringRow = options.prepaintWindowTop === undefined ? row : row + height;
					output.push("\r\n");
					this.#appendLineRewrite(
						output,
						frame[enteringRow] ?? "",
						width,
						height - 1,
						enteringRow,
						options.commitTo,
					);
				}
				for (let screenRow = 0; screenRow < height; screenRow++) {
					output.push(`\x1b[${screenRow + 1};1H`);
					this.#appendLineRewrite(
						output,
						window[screenRow] ?? "",
						width,
						screenRow,
						options.windowTop + screenRow,
						options.commitTo,
					);
				}
			} else {
				output.push("\x1b[1;1H");
				let wroteLine = false;
				for (let row = options.commitFrom; row < options.commitTo; row++) {
					if (wroteLine) output.push("\r\n");
					this.#appendLineRewrite(
						output,
						frame[row] ?? "",
						width,
						Math.min(row - options.commitFrom, height - 1),
						row,
						options.commitTo,
					);
					wroteLine = true;
				}
				for (let screenRow = 0; screenRow < height; screenRow++) {
					if (wroteLine) output.push("\r\n");
					this.#appendLineRewrite(
						output,
						window[screenRow] ?? "",
						width,
						Math.min(options.commitTo - options.commitFrom + screenRow, height - 1),
						options.windowTop + screenRow,
						options.commitTo,
					);
					wroteLine = true;
				}
			}
		} else {
			for (let screenRow = options.repaintFromScreenRow; screenRow < height; screenRow++) {
				output.push(`\x1b[${screenRow + 1};1H`);
				this.#appendLineRewrite(
					output,
					window[screenRow] ?? "",
					width,
					screenRow,
					options.windowTop + screenRow,
					options.commitTo,
				);
			}
		}
		output.push("\r");
		const contentRows = Math.max(1, Math.min(height, frame.length - options.windowTop));
		const contentBottomRow = options.windowTop + contentRows - 1;
		const target = this.#targetHardwareCursorState(cursorPos, options.cursorTrackingLineCount);
		if (target) {
			const screenRow = Math.max(0, Math.min(height - 1, target.row - options.windowTop));
			output.push(`\x1b[${screenRow + 1};${target.col + 1}H`);
			output.push(target.visible ? "\x1b[?25h" : "\x1b[?25l");
		} else {
			output.push(`\x1b[${contentRows};1H\x1b[?25l`);
		}
		output.push(this.#paintEndSequence);
		this.#writeFrameOutput();

		this.#commit(frame, window, width, height, {
			toRow: target?.row ?? contentBottomRow,
			state: target,
			visible: target?.visible ?? false,
		});
	}

	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		imageTransmitBuffer: string,
		options: {
			clearScrollback: boolean;
			chunkTo: number;
			windowTop: number;
			cursorTrackingLineCount: number;

			leadingSequence: string;
			copyScreenToScrollback: boolean;
		},
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop, cursorTrackingLineCount } = options;

		let paintCursorPos: { row: number; col: number } | null = null;
		if (cursorPos !== null) {
			if (cursorPos.row < chunkTo) {
				paintCursorPos = cursorPos;
			} else if (cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				paintCursorPos = { row: chunkTo + cursorPos.row - windowTop, col: cursorPos.col };
			}
		}

		const paintLineCount = chunkTo + height;
		const output = this.#beginFrameOutput(
			this.#paintBeginSequence,
			this.#leaveResizeAltSequence(),
			options.leadingSequence,
			purgeSequence,
		);
		if (options.clearScrollback) {
			output.push("\x1b[H\x1b[3J");
			for (const { imageId, lastEpoch } of this.#imageBudget.resetPlacementEpochs()) {
				for (let placementId = 1; placementId <= lastEpoch; placementId++) {
					output.push(encodeKittyDeletePlacement(imageId, placementId));
				}
			}
		} else {
			if (options.copyScreenToScrollback && TERMINAL.supportsScreenToScrollback) output.push("\x1b[22J");
			output.push("\x1b[2J\x1b[H");
		}
		if (imageTransmitBuffer.length > 0) output.push(imageTransmitBuffer);

		const visibleStart = Math.max(0, paintLineCount - height);
		let fillSequence = "";
		let visibleTexts: string[] | null = null;
		if (this.#deccaraFillsEnabled() && visibleStart < paintLineCount) {
			const plan = planDeccaraFills(window, width);
			visibleTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		for (let i = 0; i < chunkTo; i++) {
			if (i > 0) output.push("\r\n");
			const writeRow = Math.min(i, height - 1);
			const line = frame[i] ?? "";
			if (options.clearScrollback) {
				this.#appendLineRewrite(output, line, width, writeRow, i, chunkTo, this.#osc66SpacerGlyphWidth(frame, i));
			} else {
				output.push(this.#terminalLineForFrame(line, width, writeRow, i, chunkTo));
			}
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (chunkTo + screenRow > 0) output.push("\r\n");
			const line = visibleTexts ? (visibleTexts[screenRow] ?? "") : (window[screenRow] ?? "");
			const writeRow = Math.min(chunkTo + screenRow, height - 1);
			const frameRow = windowTop + screenRow;
			if (options.clearScrollback) {
				this.#appendLineRewrite(
					output,
					line,
					width,
					writeRow,
					frameRow,
					chunkTo,
					this.#osc66SpacerGlyphWidth(frame, frameRow),
				);
			} else if (visibleTexts) {
				output.push(this.#terminalLine(line, writeRow, frameRow, chunkTo));
			} else {
				output.push(this.#terminalLineForFrame(line, width, writeRow, frameRow, chunkTo));
			}
		}
		output.push(fillSequence);

		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const parkUp = height - contentRows;
		if (parkUp > 0) output.push(`\x1b[${parkUp}A`);
		const contentBottomRow = windowTop + contentRows - 1;
		const paintContentBottomRow = Math.max(0, paintLineCount - 1 - parkUp);
		const cursorControl = this.#cursorControlSequence(paintCursorPos, paintLineCount, paintContentBottomRow);
		output.push(cursorControl.seq, this.#paintEndSequence);
		this.#writeFrameOutput();

		const committedCursorState = paintCursorPos
			? this.#targetHardwareCursorState(cursorPos, cursorTrackingLineCount)
			: null;
		const committedCursor = committedCursorState
			? {
					toRow: committedCursorState.row,
					state: committedCursorState,
					visible: committedCursorState.visible,
				}
			: {
					toRow: contentBottomRow,
					state: null,
					visible: cursorControl.visible,
				};

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, committedCursor);
	}

	#beginResizeViewport(): void {
		this.#resizeViewportActive = true;
		this.#resizeViewportSettleTimer?.cancel();
		this.#resizeViewportSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeViewportSettleTimer = undefined;
			this.#resizeViewportActive = false;
			if (this.#stopped) return;

			this.#resizeEventPending = true;
			this.requestRender(true, { clearScrollback: !isMultiplexerSession() });
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
	}

	#requestResizeViewportPaint(): void {
		if (this.#stopped) return;
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) this.#scheduleRender();
	}

	#renderResizeViewport(width: number, height: number): void {
		if (width <= 0 || height <= 0) return;
		this.#invalidatePreparedRowCache();

		this.#imageBudget.beginPass(true);
		const { framed, viewportTop, contentRows } = this.#composeResizeViewport(width, height);
		this.#emitResizeViewport(framed, viewportTop, height, contentRows, width);
		this.#resizeViewportPaintCount += 1;
	}

	#composeResizeViewport(
		width: number,
		height: number,
	): { framed: readonly string[]; viewportTop: number; contentRows: number } {
		const maxRows = height + TUI.#OSC66_MAX_SPACER_ROWS;
		const tail: string[] = [];
		const children = this.children;
		for (let i = children.length - 1; i >= 0 && tail.length < maxRows; i--) {
			const child = children[i]!;
			const provider = asViewportTailProvider(child);
			const rows = provider ? provider.renderViewportTail(width, maxRows - tail.length) : child.render(width);
			for (let r = rows.length - 1; r >= 0 && tail.length < maxRows; r--) {
				tail.push(rows[r]!);
			}
		}
		const contentRows = Math.min(tail.length, height);
		const extra = tail.length - contentRows;
		const window: string[] = new Array(height);
		for (let screenRow = 0; screenRow < height; screenRow++) {
			window[screenRow] = screenRow < contentRows ? tail[contentRows - 1 - screenRow]! : "";
		}
		this.#extractCursorMarkers(window);

		const framed: string[] = new Array(extra + height);
		for (let k = 0; k < extra; k++) framed[k] = tail[tail.length - 1 - k]!;
		for (let screenRow = 0; screenRow < height; screenRow++) framed[extra + screenRow] = window[screenRow]!;
		return { framed: this.#prepareLinesArray(framed, width), viewportTop: extra, contentRows };
	}

	#keyboardEnhancementEnter(): string {
		return this.terminal.keyboardEnhancementEnterSequence ?? this.terminal.kittyEnableSequence ?? "";
	}

	#keyboardEnhancementExit(): string {
		const exit = this.terminal.keyboardEnhancementExitSequence;
		if (exit !== undefined) return exit ?? "";
		return this.terminal.kittyEnableSequence ? "\x1b[<u" : "";
	}

	#enterResizeAltSequence(): string {
		if (this.#resizeAltActive || this.#altActive) return "";
		this.#resizeAltActive = true;
		setAltScreenActive(true);
		this.#forgetHardwareCursorState();
		this.#recordHardwareCursorHidden();
		return `${ALT_SCREEN_ENTER}${this.#keyboardEnhancementEnter()}`;
	}

	#leaveResizeAltSequence(): string {
		if (!this.#resizeAltActive) return "";
		const enhancementExit = this.#keyboardEnhancementExit();
		this.#resizeAltActive = false;
		setAltScreenActive(false);
		this.#forgetHardwareCursorState();
		return `${enhancementExit}${ALT_SCREEN_EXIT}`;
	}

	#resizeRepaintsInPlace(): boolean {
		const override = Bun.env.PI_TUI_RESIZE_IN_PLACE;
		const allowAutoDetection = override !== "0" && override !== "false";
		return resizeRepaintsInPlace() || (allowAutoDetection && this.#altToggleResizesInPlace);
	}

	#emitResizeViewport(
		framed: readonly string[],
		viewportTop: number,
		height: number,
		contentRows: number,
		width: number,
	): void {
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const altEnter = widthChanged ? this.#enterResizeAltSequence() : "";
		const output = this.#beginFrameOutput(`${this.#paintBeginSequence + altEnter}\x1b[H`);
		for (let r = 0; r < height; r++) {
			if (r > 0) output.push("\r\n");

			const idx = viewportTop + r;
			this.#appendLineRewrite(
				output,
				framed[idx] ?? "",
				width,
				r,
				-1,
				this.#committedRows,
				this.#osc66SpacerGlyphWidth(framed, idx),
			);
		}

		const parkUp = height - Math.max(1, contentRows);
		if (parkUp > 0) output.push(`\x1b[${parkUp}A`);
		output.push(this.#paintEndSequence);
		this.#writeFrameOutput();
	}

	#renderAltFrame(width: number, height: number): void {
		this.#invalidatePreparedRowCache();
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#compositeOverlaysIntoWindow(base, width, height);
		this.#extractCursorMarkers(lines);
		lines = this.#prepareLinesArray(lines, width);
		this.#emitAltFrame(lines, width, height);
	}

	#emitAltFrame(lines: string[], width: number, height: number): void {
		const fitted: string[] = new Array(height);
		for (let r = 0; r < height; r++) fitted[r] = lines[r] ?? "";

		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (const seq of imageTransmits) transmitBuffer += seq;
			this.terminal.write(transmitBuffer);
		}

		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		if (!force && this.#altPreviousLines.length === height) {
			let same = true;
			for (let r = 0; r < height; r++) {
				if (fitted[r] !== this.#altPreviousLines[r]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		const output = this.#beginFrameOutput(`${this.#paintBeginSequence}\x1b[H`);
		for (let r = 0; r < height; r++) {
			if (r > 0) output.push("\r\n");
			this.#appendLineRewrite(output, fitted[r], width, r, -1, -1, this.#osc66SpacerGlyphWidth(fitted, r));
		}
		output.push(this.#paintEndSequence);
		this.#writeFrameOutput();
		this.#altPreviousLines = fitted;
		this.#fullRedrawCount += 1;
	}

	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
			repaintVirtualScrollInPlace: boolean;
			cursorTrackingLineCount: number;
		},
	): void {
		const {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite,
			repaintVirtualScrollInPlace,
			cursorTrackingLineCount,
		} = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const contentBottomRow = windowTop + contentRows - 1;

		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevWindowTop));

		if (
			!forceWindowRewrite &&
			chunkLength > 0 &&
			chunkLength === scroll &&
			scroll < height &&
			chunkFrom === prevWindowTop
		) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				const output = this.#beginFrameOutput(this.#paintBeginSequence, purgeSequence);
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) output.push(`\x1b[${moveToBottom}B`);
				for (let r = height - scroll; r < height; r++) {
					output.push("\r\n");
					this.#appendLineRewrite(
						output,
						window[r] ?? "",
						width,
						height - 1,
						windowTop + r,
						chunkTo,
						this.#osc66SpacerGlyphWidth(frame, windowTop + r),
					);
				}

				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) output.push(`\x1b[${up}A`);
					output.push("\r");
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) output.push("\r\n");
						this.#appendLineRewrite(
							output,
							window[r] ?? "",
							width,
							r,
							windowTop + r,
							chunkTo,
							this.#osc66SpacerGlyphWidth(frame, windowTop + r),
						);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
				output.push(cursorControl.seq, this.#paintEndSequence);
				this.#writeFrameOutput();
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;
		if (chunkLength === 0) {
			if (forceWindowRewrite || inPlaceRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;
			if (!forceWindowRewrite && !inPlaceRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				if (purgeSequence.length > 0) this.terminal.write(purgeSequence);
				this.#writeCursorPosition(cursorPos, cursorTrackingLineCount);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			const output = this.#beginFrameOutput(this.#paintBeginSequence, purgeSequence);
			if (inPlaceRewrite) {
				if (height > 1) output.push(`\x1b[${height - 1}A`);
			} else {
				const rowDelta = firstChanged - currentScreenRow;
				if (rowDelta > 0) output.push(`\x1b[${rowDelta}B`);
				else if (rowDelta < 0) output.push(`\x1b[${-rowDelta}A`);
			}
			output.push("\r");

			let fillTexts: string[] | null = null;
			let fillSequence = "";
			if (this.#deccaraFillsEnabled()) {
				const slice: string[] = new Array(lastChanged - firstChanged + 1);
				for (let r = firstChanged; r <= lastChanged; r++) slice[r - firstChanged] = window[r] ?? "";
				const plan = planDeccaraFills(slice, width, firstChanged);
				fillTexts = plan.texts;
				fillSequence = plan.sequence;
			}
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) output.push("\r\n");
				this.#appendLineRewrite(
					output,
					fillTexts ? fillTexts[r - firstChanged] : (window[r] ?? ""),
					width,
					r,
					windowTop + r,
					this.#committedRows,
					this.#osc66SpacerGlyphWidth(frame, windowTop + r),
				);
			}
			output.push(fillSequence);

			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				output.push(`\x1b[${lastChanged - contentBottomScreenRow}A`);
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
			output.push(cursorControl.seq, this.#paintEndSequence);
			this.#writeFrameOutput();
			this.#windowTopRow = windowTop;
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		this.#fullRedrawCount += 1;
		const output = this.#beginFrameOutput(this.#paintBeginSequence, purgeSequence);
		if (currentScreenRow > 0) output.push(`\x1b[${currentScreenRow}A`);
		output.push("\r");
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) output.push("\r\n");
			this.#appendLineRewrite(
				output,
				frame[i] ?? "",
				width,
				Math.min(i - chunkFrom, height - 1),
				i,
				chunkTo,
				this.#osc66SpacerGlyphWidth(frame, i),
			);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) output.push("\r\n");
			this.#appendLineRewrite(
				output,
				window[screenRow] ?? "",
				width,
				Math.min(chunkTo - chunkFrom + screenRow, height - 1),
				windowTop + screenRow,
				chunkTo,
				this.#osc66SpacerGlyphWidth(frame, windowTop + screenRow),
			);
			wroteLine = true;
		}
		const parkUp = height - 1 - (contentBottomRow - windowTop);
		if (parkUp > 0) output.push(`\x1b[${parkUp}A`);
		const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, contentBottomRow);
		output.push(cursorControl.seq, this.#paintEndSequence);
		this.#writeFrameOutput();
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("PI_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "update"
				? `update(chunk=${this.#committedRows}..${intent.chunkTo}, windowTop=${intent.windowTop})`
				: `fullPaint(clearScrollback=${intent.clearScrollback})`;
		const state =
			`committed=${this.#committedRows}, windowTop=${this.#windowTopRow}, ` +
			`lrStart=${this.#nativeScrollbackLiveRegionStart}`;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousFrameLength}, new=${newLength}, height=${height}, ${state})\n`;
		fs.appendFileSync(getDebugLogPath(), msg);
	}

	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}

		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`;
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`;
		}

		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";

		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#isHiddenCursorKnown(): boolean {
		return this.#hardwareCursorVisibilityKnown && !this.#hardwareCursorVisible;
	}

	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			if (this.#isHiddenCursorKnown()) return;
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
			return;
		}
		if (this.#sameHardwareCursorState(target)) return;
		const cursorControl = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		this.terminal.write(`${this.#cursorBeginSequence}${cursorControl.seq}${this.#cursorEndSequence}`);
		this.#recordHardwareCursorUpdate(cursorControl);
	}
}
