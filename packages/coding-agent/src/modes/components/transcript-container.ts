import {
	type Component,
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackWidthEpoch,
	type RenderStablePrefix,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";
import { isToolActivityComponent } from "./tool-activity";

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;

	getTranscriptBlockVersion?(): number;

	getTranscriptBlockSettledRows?(): number;

	isDisplaceableBlock?(): boolean;

	seal?(): void;
}

interface TranscriptBlockChangeSubscription {
	setTranscriptBlockChangeListener?(listener: (() => void) | undefined): void;
}

interface ActiveTranscriptBlockListeners {
	dispatcher: () => void;
	listeners: Set<() => void>;
}

const activeTranscriptBlockListeners = new WeakMap<Component, ActiveTranscriptBlockListeners>();

function addBlockChangeListener(child: Component, listener: () => void): boolean {
	const setListener = (child as Component & TranscriptBlockChangeSubscription).setTranscriptBlockChangeListener;
	if (typeof setListener !== "function") return false;
	let active = activeTranscriptBlockListeners.get(child);
	if (!active) {
		const listeners = new Set<() => void>();
		const dispatcher = (): void => {
			for (const callback of listeners) callback();
		};
		active = { dispatcher, listeners };
		activeTranscriptBlockListeners.set(child, active);
		setListener.call(child, dispatcher);
	}
	active.listeners.add(listener);
	return true;
}

function removeBlockChangeListener(child: Component, listener: () => void): void {
	const active = activeTranscriptBlockListeners.get(child);
	if (!active) return;
	active.listeners.delete(listener);
	if (active.listeners.size > 0) return;
	const setListener = (child as Component & TranscriptBlockChangeSubscription).setTranscriptBlockChangeListener;
	if (typeof setListener === "function") setListener.call(child, undefined);
	activeTranscriptBlockListeners.delete(child);
}

function hasBlockChangeListener(child: Component, listener: (() => void) | undefined): boolean {
	return listener !== undefined && activeTranscriptBlockListeners.get(child)?.listeners.has(listener) === true;
}

function hasCustomReplay(component: Component): boolean {
	const replay = (component as Component & Partial<{ prepareNativeScrollbackReplay(): void }>)
		.prepareNativeScrollbackReplay;
	if (typeof replay === "function" && replay !== Container.prototype.prepareNativeScrollbackReplay) return true;
	const children = (component as Component & Partial<{ children: Component[] }>).children;
	return children?.some(child => hasCustomReplay(child)) === true;
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

function isBlockPinned(child: Component): boolean {
	return (child as Component & Partial<NativeScrollbackLiveRegion>).isNativeScrollbackLiveRegionPinned?.() === true;
}

function getBlockVersion(child: Component): number | undefined {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
	return fn ? fn.call(child) : undefined;
}

function getBlockSettledRows(child: Component): number {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockSettledRows;
	if (!fn) return 0;
	const value = fn.call(child);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function sealCommittedSnapshot(child: Component): void {
	const block = child as Component & FinalizableBlock;
	if (block.isDisplaceableBlock?.()) block.seal?.();
}

function setBlockCommittedRows(child: Component, rows: number): void {
	(child as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

const NON_WHITESPACE = /\S/;
function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

interface BlockSegment {
	component: Component;
	rawRef: readonly string[];
	contribution: readonly string[];
	width: number;
	generation: number;

	startRow: number;

	rowCount: number;
	sep: number;

	finalized: boolean;

	version: number | undefined;
	changeTracked: boolean;

	committedRows: number;
}

const EMPTY_SEGMENTS: BlockSegment[] = [];

const EMPTY_TAIL: readonly string[] = [];

export class TranscriptContainer
	extends Container
	implements
		NativeScrollbackLiveRegion,
		NativeScrollbackCommittedRows,
		NativeScrollbackWidthEpoch,
		RenderStablePrefix,
		ViewportTailProvider
{
	#toolActivityVisible = true;

	#generation = 0;

	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackLiveRegionPinned = false;

	#nativeScrollbackLiveRegionPinnedStart: number | undefined;

	#lines: string[] = [];
	#segments: BlockSegment[] = EMPTY_SEGMENTS;
	#renderWidth = -1;
	#renderRevision = 0;

	#committedRows = 0;
	#committedRowsDirty = false;
	// Earliest current-frame row whose committed layout or bytes may differ from
	// the prior committed prefix. The TUI consumes this after render().
	#committedDirtyFromRow: number | undefined;
	#committedDirtySegments = new Set<BlockSegment>();
	#dirtyComponents = new Set<Component>();
	#renderDirtyComponents = new Set<Component>();
	#dirtyFromIndex = Number.POSITIVE_INFINITY;
	#renderDirtyFromIndex = Number.POSITIVE_INFINITY;
	#componentIndices = new WeakMap<Component, number>();
	#trackedComponents = new WeakSet<Component>();
	#trackedChildren = new Set<Component>();
	#blockListeners = new WeakMap<Component, () => void>();
	#widthEpochBoundaries = new WeakMap<
		object,
		{
			segment: {
				component: Component;
				finalized: boolean;
				version: number | undefined;
				rowCount: number;
			};
			segmentIndex: number;
			childBoundary: unknown;
			childHasBoundary: boolean;
			precedingSegments: Array<{
				component: Component;
				finalized: boolean;
				version: number | undefined;
			}>;
			trailingSegments: Array<{
				component: Component;
				finalized: boolean;
				version: number | undefined;
				rowCount: number;
			}>;
		}
	>();

	#stableRowsFloor = 0;
	#childrenRevision = 0;
	#childrenExternallyAssigned = false;
	#settingChildrenInternally = false;
	#renderedChildrenRevision = -1;
	#renderedGeneration = -1;
	#renderedCommittedRows = -1;
	#stablePrefixLength = 0;

	#noteBlockChange(component: Component): void {
		this.#dirtyComponents.add(component);
		const index = this.#componentIndices.get(component);
		if (index !== undefined && index < this.#dirtyFromIndex) this.#dirtyFromIndex = index;
	}

	#attachBlockListener(component: Component): void {
		if (this.#blockListeners.has(component)) return;
		const listener = () => this.#noteBlockChange(component);
		if (!addBlockChangeListener(component, listener)) return;
		this.#blockListeners.set(component, listener);
		this.#trackedComponents.add(component);
		this.#trackedChildren.add(component);
	}

	#detachBlockListener(component: Component): void {
		const listener = this.#blockListeners.get(component);
		if (listener !== undefined) removeBlockChangeListener(component, listener);
		this.#blockListeners.delete(component);
		this.#trackedComponents.delete(component);
		this.#trackedChildren.delete(component);
	}

	#reconcileBlockListeners(): void {
		const currentChildren = new Set(this.children);
		for (const child of this.#trackedChildren) {
			if (currentChildren.has(child)) continue;
			this.#detachBlockListener(child);
		}
		for (const child of currentChildren) {
			if (!this.#trackedChildren.has(child)) this.#attachBlockListener(child);
		}
	}

	constructor() {
		super();
		let children = this.children;
		const markChildrenChanged = (): void => {
			this.#childrenRevision++;
			this.#committedRowsDirty = true;
		};
		const wrapChildren = (target: Component[]): Component[] =>
			new Proxy(target, {
				set: (array, property, value, receiver) => {
					const previous = Reflect.get(array, property, receiver);
					const changed = Reflect.set(array, property, value, receiver);
					if (changed && previous !== value) markChildrenChanged();
					return changed;
				},
				deleteProperty: (array, property) => {
					const existed = Reflect.has(array, property);
					const deleted = Reflect.deleteProperty(array, property);
					if (deleted && existed) markChildrenChanged();
					return deleted;
				},
			});
		children = wrapChildren(children);
		Object.defineProperty(this, "children", {
			configurable: true,
			enumerable: true,
			get: () => children,
			set: (next: Component[]) => {
				if (next === children) return;
				children = wrapChildren(next);
				if (!this.#settingChildrenInternally) this.#childrenExternallyAssigned = true;
				markChildrenChanged();
			},
		});
	}

	override addChild(component: Component): void {
		const wasEmpty = this.children.length === 0;
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#attachBlockListener(component);
		this.#committedRowsDirty = true;
		if (wasEmpty && this.onFirstContent) this.onFirstContent();
	}

	override removeChild(component: Component): void {
		const hadChild = this.children.includes(component);
		super.removeChild(component);
		if (hadChild) this.#committedRowsDirty = true;
		if (hadChild && !this.children.includes(component)) this.#detachBlockListener(component);
	}

	onFirstContent?: () => void;

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	override invalidate(): void {
		this.#generation++;
		super.invalidate();
	}

	override clear(): void {
		this.#generation++;
		for (const child of this.#trackedChildren) this.#detachBlockListener(child);
		this.#trackedChildren.clear();
		this.#trackedComponents = new WeakSet();
		this.#blockListeners = new WeakMap();
		this.#dirtyComponents.clear();
		this.#renderDirtyComponents.clear();
		this.#dirtyFromIndex = Number.POSITIVE_INFINITY;
		this.#renderDirtyFromIndex = Number.POSITIVE_INFINITY;
		this.#componentIndices = new WeakMap();
		this.#settingChildrenInternally = true;
		try {
			super.clear();
		} finally {
			this.#settingChildrenInternally = false;
		}
		this.#childrenExternallyAssigned = false;
		this.#lines = [];
		this.#segments = EMPTY_SEGMENTS;
		this.#renderWidth = -1;
		this.#stableRowsFloor = 0;
		this.#widthEpochBoundaries = new WeakMap();
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackLiveRegionPinned = false;
		this.#nativeScrollbackLiveRegionPinnedStart = undefined;
		this.#committedRows = 0;
		this.#committedRowsDirty = false;
		this.#committedDirtyFromRow = undefined;
		this.#committedDirtySegments.clear();
		this.#renderedChildrenRevision = -1;
		this.#renderedGeneration = -1;
		this.#renderedCommittedRows = -1;
		this.#stablePrefixLength = 0;
	}

	override dispose(): void {
		for (const child of this.#trackedChildren) this.#detachBlockListener(child);
		this.#trackedChildren.clear();
		this.#trackedComponents = new WeakSet();
		this.#blockListeners = new WeakMap();
		this.#generation++;
		this.#stablePrefixLength = 0;
		this.#committedDirtyFromRow = undefined;
		super.dispose();
	}

	override prepareNativeScrollbackReplay(): void {
		super.prepareNativeScrollbackReplay();
		this.#committedRowsDirty = true;
		for (const child of this.children) {
			if (hasCustomReplay(child)) this.#noteBlockChange(child);
		}
	}

	#publishCommittedRows(segment: BlockSegment): void {
		const committedContribution = Math.min(
			segment.contribution.length,
			Math.max(0, this.#committedRows - segment.startRow - segment.sep),
		);
		let committedBlockRows = 0;
		if (committedContribution > 0) {
			let leadingTrimmedRows = 0;
			while (leadingTrimmedRows < segment.rawRef.length && isPlainBlank(segment.rawRef[leadingTrimmedRows]!)) {
				leadingTrimmedRows++;
			}
			committedBlockRows = Math.min(segment.rawRef.length, leadingTrimmedRows + committedContribution);
		}
		setBlockCommittedRows(segment.component, committedBlockRows);
		segment.committedRows = committedBlockRows;
	}

	override setNativeScrollbackCommittedRows(rows: number): void {
		const committed = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		if (committed !== this.#committedRows) {
			this.#committedRows = committed;
			this.#committedRowsDirty = true;
		}
		if (!this.#committedRowsDirty && this.#committedDirtySegments.size === 0) return;

		if (this.#committedRowsDirty) {
			for (const segment of this.#segments) this.#publishCommittedRows(segment);
		} else {
			for (const segment of this.#committedDirtySegments) this.#publishCommittedRows(segment);
		}
		this.#committedRowsDirty = false;
		this.#committedDirtySegments.clear();
	}

	override captureNativeScrollbackWidthEpoch(): unknown {
		const segment = this.#segments.find(candidate => !candidate.finalized) ?? this.#segments.at(-1);
		if (!segment) return undefined;
		const child = segment.component as Component & Partial<NativeScrollbackWidthEpoch>;
		const childHasBoundary =
			typeof child.captureNativeScrollbackWidthEpoch === "function" &&
			typeof child.resolveNativeScrollbackWidthEpoch === "function" &&
			typeof child.getNativeScrollbackWidthEpochRows === "function";
		const segmentIndex = this.#segments.indexOf(segment);
		const marker = {};
		this.#widthEpochBoundaries.set(marker, {
			segment: {
				component: segment.component,
				finalized: segment.finalized,
				version: segment.version,
				rowCount: segment.rowCount,
			},
			segmentIndex,
			childBoundary: childHasBoundary ? child.captureNativeScrollbackWidthEpoch?.() : undefined,
			childHasBoundary,
			precedingSegments: this.#segments.slice(0, segmentIndex).map(candidate => ({
				component: candidate.component,
				finalized: candidate.finalized,
				version: candidate.version,
			})),
			trailingSegments: this.#segments.slice(segmentIndex + 1).map(candidate => ({
				component: candidate.component,
				finalized: candidate.finalized,
				version: candidate.version,
				rowCount: candidate.rowCount,
			})),
		});
		return marker;
	}

	override resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const marker = this.#widthEpochBoundaries.get(boundary);
		if (!marker) return undefined;
		const currentIndex = marker.segmentIndex;
		const current = this.#segments[currentIndex];
		if (!current || current.component !== marker.segment.component) return undefined;
		if (currentIndex !== marker.precedingSegments.length) return undefined;
		for (let i = 0; i < marker.precedingSegments.length; i++) {
			const captured = marker.precedingSegments[i]!;
			const preceding = this.#segments[i]!;

			if (
				preceding.component !== captured.component ||
				!captured.finalized ||
				!preceding.finalized ||
				preceding.version !== captured.version
			) {
				return undefined;
			}
		}

		let rows: number | undefined;
		if (marker.childHasBoundary && marker.childBoundary !== undefined) {
			const child = current.component as Component & NativeScrollbackWidthEpoch;
			const rawRows = child.resolveNativeScrollbackWidthEpoch(marker.childBoundary);
			if (rawRows !== undefined) rows = this.#mapNativeScrollbackWidthEpochRows(current, rawRows);
		}
		if (rows === undefined) {
			if (marker.segment.rowCount === 0) rows = current.startRow;
			else if (!marker.segment.finalized || marker.segment.version !== current.version) return undefined;
			else rows = current.startRow + current.rowCount;
		}
		for (let i = 0; i < marker.trailingSegments.length; i++) {
			const captured = marker.trailingSegments[i]!;
			const trailing = this.#segments[currentIndex + i + 1];
			if (
				!captured.finalized ||
				!trailing ||
				trailing.component !== captured.component ||
				!trailing.finalized ||
				trailing.version !== captured.version
			)
				return undefined;
			rows += trailing.rowCount;
		}
		return rows;
	}

	#mapNativeScrollbackWidthEpochRows(segment: BlockSegment, rawRows: number): number {
		let leadingTrimmedRows = 0;
		while (leadingTrimmedRows < segment.rawRef.length && isPlainBlank(segment.rawRef[leadingTrimmedRows]!)) {
			leadingTrimmedRows++;
		}
		const contributionRows = Math.max(0, Math.min(segment.contribution.length, rawRows - leadingTrimmedRows));
		return segment.startRow + segment.sep + contributionRows;
	}

	override getNativeScrollbackWidthEpochRows(): number | undefined {
		const segment = this.#segments.find(candidate => !candidate.finalized) ?? this.#segments.at(-1);
		if (!segment) return undefined;
		const child = segment.component as Component & Partial<NativeScrollbackWidthEpoch>;
		if (typeof child.getNativeScrollbackWidthEpochRows !== "function") return this.#lines.length;
		const rawRows = child.getNativeScrollbackWidthEpochRows();

		if (rawRows === undefined) return this.#lines.length;
		let rows = this.#mapNativeScrollbackWidthEpochRows(segment, rawRows);
		for (const trailing of this.#segments.slice(this.#segments.indexOf(segment) + 1)) rows += trailing.rowCount;
		return rows;
	}

	override isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		const marker = this.#widthEpochBoundaries.get(boundary);
		if (!marker) return true;
		const child = marker.segment.component as Component & Partial<NativeScrollbackWidthEpoch>;
		if (child.isNativeScrollbackWidthEpochAppendOnly?.(marker.childBoundary) === false) return false;
		return !marker.trailingSegments.some(segment => segment.rowCount > 0);
	}

	getRenderStablePrefixRows(): number {
		const value = Math.min(this.#stableRowsFloor, this.#lines.length);
		this.#stableRowsFloor = this.#lines.length;
		return value;
	}

	getRenderRevision(): number {
		return this.#renderRevision;
	}

	/**
	 * Return the earliest current-frame row whose committed layout or bytes may
	 * differ after the most recent render. This includes a changed finalized
	 * block and a previously empty block that gained rows after later rows had
	 * crossed its insertion point. The value resets at render start and remains
	 * available until the next render; consumers must strict-audit from it.
	 */
	getNativeScrollbackCommittedDirtyFromRow(): number | undefined {
		return this.#committedDirtyFromRow;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#nativeScrollbackLiveRegionPinned;
	}

	getNativeScrollbackLiveRegionPinnedStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionPinned ? this.#nativeScrollbackLiveRegionPinnedStart : undefined;
	}

	#notePinnedLiveBlock(pinAt: number): void {
		if (this.#nativeScrollbackLiveRegionPinned) return;
		this.#nativeScrollbackLiveRegionPinned = true;
		this.#nativeScrollbackLiveRegionPinnedStart = pinAt;
	}

	isBlockUncommitted(component: Component): boolean {
		for (const segment of this.#segments) {
			if (segment.component !== component) continue;
			return segment.rowCount === 0 || segment.startRow + segment.sep >= this.#committedRows;
		}
		return true;
	}

	isBlockInLiveRegion(component: Component): boolean {
		const children = this.children;
		const index = children.indexOf(component);
		if (index < 0) return false;
		for (let i = 0; i <= index; i++) {
			if (!isBlockFinalized(children[i]!)) return true;
		}

		for (let i = index + 1; i < children.length; i++) {
			if (!isBlockFinalized(children[i]!)) return false;
		}
		return index === children.length - 1;
	}

	renderViewportTail(width: number, maxRows: number): readonly string[] {
		width = Math.max(1, width);
		if (maxRows <= 0) return EMPTY_TAIL;
		const collected: (readonly string[])[] = [];
		let total = 0;
		for (let i = this.children.length - 1; i >= 0 && total < maxRows; i--) {
			const contribution = stripPlainBlankEdges(this.children[i]!.render(width));
			if (contribution.length === 0) continue;

			if (collected.length > 0) total += 1;
			collected.push(contribution);
			total += contribution.length;
		}
		if (collected.length === 0) return EMPTY_TAIL;
		const rows: string[] = [];
		for (let k = collected.length - 1; k >= 0; k--) {
			if (rows.length > 0) rows.push("");
			const body = collected[k]!;
			for (let j = 0; j < body.length; j++) rows.push(body[j]!);
		}
		return rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackLiveRegionPinned = false;
		this.#nativeScrollbackLiveRegionPinnedStart = undefined;
		this.#committedDirtyFromRow = undefined;

		const dirtyComponents = this.#dirtyComponents;
		this.#dirtyComponents = this.#renderDirtyComponents;
		this.#dirtyComponents.clear();
		this.#renderDirtyComponents = dirtyComponents;
		const dirtyFromIndex = this.#dirtyFromIndex;
		this.#dirtyFromIndex = this.#renderDirtyFromIndex;
		this.#renderDirtyFromIndex = dirtyFromIndex;
		this.#dirtyFromIndex = Number.POSITIVE_INFINITY;

		const count = this.children.length;
		const previousSegments = this.#segments;
		const previousLineCount = this.#lines.length;
		const widthChanged = this.#renderWidth !== width;
		const structureChanged =
			this.#childrenExternallyAssigned ||
			this.#renderedChildrenRevision !== this.#childrenRevision ||
			previousSegments.length !== count;
		if (structureChanged) this.#reconcileBlockListeners();
		const canReusePrefix =
			!widthChanged &&
			!this.#childrenExternallyAssigned &&
			!structureChanged &&
			this.#renderedGeneration === this.#generation &&
			this.#renderedCommittedRows === this.#committedRows;
		const prefixLength = canReusePrefix ? Math.min(this.#stablePrefixLength, count) : 0;
		const startIndex = canReusePrefix ? Math.min(prefixLength, dirtyFromIndex) : 0;
		const segments =
			previousSegments.length === count ? previousSegments : new Array<BlockSegment | undefined>(count);
		if (structureChanged) this.#committedRowsDirty = true;
		this.#segments = EMPTY_SEGMENTS;
		const stableFloorBefore = this.#stableRowsFloor;
		this.#stableRowsFloor = 0;

		let chainStable = !widthChanged;
		this.#renderWidth = width;
		const lines = this.#lines;
		if (!chainStable) lines.length = 0;

		let row = 0;
		let stableRows = 0;
		let liveStartIndex = -1;
		let canSealCommitted = startIndex === 0;
		let stablePrefixLength = startIndex > 0 ? startIndex : 0;
		let pinCandidates: { index: number; pinAt: number }[] | undefined;
		if (startIndex > 0) {
			const prefix = previousSegments[startIndex - 1]!;
			row = prefix.startRow + prefix.rowCount;
			stableRows = row;
		}
		for (let i = startIndex; i < count; i++) {
			const child = this.children[i]!;
			const priorIndex = this.#componentIndices.get(child);
			if (priorIndex === undefined || i < priorIndex) this.#componentIndices.set(child, i);
			const previous = previousSegments[i];
			const previousComponent = previous?.component;
			const previousRaw = previous?.rawRef;
			const previousContribution = previous?.contribution;
			const previousWidth = previous?.width;
			const previousGeneration = previous?.generation;
			const previousStartRow = previous?.startRow;
			const previousRowCount = previous?.rowCount;
			const previousSep = previous?.sep;
			const previousFinalized = previous?.finalized;
			const previousVersion = previous?.version;
			const changeTracked =
				previous?.component === child
					? previous.changeTracked && hasBlockChangeListener(child, this.#blockListeners.get(child))
					: this.#trackedComponents.has(child);
			const blockChanged = dirtyComponents.has(child);
			const reuseBlockMetadata =
				previous !== undefined &&
				previous.component === child &&
				changeTracked &&
				previous.finalized &&
				previous.generation === this.#generation &&
				!blockChanged;

			if (canSealCommitted && previous !== undefined) {
				const bodyStart = previous.startRow + previous.sep;
				if (bodyStart >= this.#committedRows) canSealCommitted = false;
				else if (previous.component === child) sealCommittedSnapshot(child);
			}

			const finalized = reuseBlockMetadata ? previous.finalized : isBlockFinalized(child);
			if (liveStartIndex < 0 && !finalized) liveStartIndex = i;
			if (stablePrefixLength === i && finalized && changeTracked) stablePrefixLength = i + 1;
			const version = reuseBlockMetadata ? previous.version : getBlockVersion(child);
			const previousCommittedRows = previous?.component === child ? previous.committedRows : -1;
			const versionChanged =
				previous?.component === child && previous.version !== undefined && version !== previous.version;
			const previousRowsCrossedCommit = previous?.component === child && previous.startRow < this.#committedRows;
			if (
				previous?.component === child &&
				previousRowsCrossedCommit &&
				(blockChanged || versionChanged || previous.finalized !== finalized)
			) {
				const dirtyRow = Math.min(previous.startRow, row);
				this.#committedDirtyFromRow =
					this.#committedDirtyFromRow === undefined ? dirtyRow : Math.min(this.#committedDirtyFromRow, dirtyRow);
			}
			const committedReusable =
				!blockChanged &&
				previous !== undefined &&
				previous.component === child &&
				previous.width === width &&
				previous.generation === this.#generation &&
				previous.startRow === row &&
				previous.startRow + previous.rowCount <= this.#committedRows &&
				finalized &&
				previous.finalized &&
				previous.version === version;
			const raw = committedReusable ? previous.rawRef : child.render(width);
			const reusable =
				committedReusable ||
				(!blockChanged &&
					previous !== undefined &&
					previous.component === child &&
					previous.rawRef === raw &&
					previous.width === width &&
					previous.generation === this.#generation);
			const contribution = reusable ? previous.contribution : stripPlainBlankEdges(raw);
			const segment =
				previous ??
				({
					component: child,
					rawRef: raw,
					contribution,
					width,
					generation: this.#generation,
					startRow: row,
					rowCount: 0,
					sep: 0,
					finalized,
					version,
					changeTracked,
					committedRows: -1,
				} satisfies BlockSegment);
			if (
				previous === undefined ||
				previousComponent !== child ||
				previousRaw !== raw ||
				previousContribution !== contribution ||
				previousWidth !== width ||
				previousGeneration !== this.#generation ||
				previousFinalized !== finalized ||
				previousVersion !== version
			) {
				this.#committedDirtySegments.add(segment);
			}

			if (contribution.length === 0) {
				if (liveStartIndex === i) this.#nativeScrollbackLiveRegionStart = row;
				if (!finalized && isBlockPinned(child)) {
					if (pinCandidates === undefined) pinCandidates = [];
					pinCandidates.push({ index: i, pinAt: row });
				}
				if (chainStable && !(reusable && previous?.rowCount === 0 && previous.startRow === row)) {
					chainStable = false;
					lines.length = row;
				}
				if (chainStable) stableRows = row;
				segment.component = child;
				segment.rawRef = raw;
				segment.contribution = contribution;
				segment.width = width;
				segment.generation = this.#generation;
				segment.startRow = row;
				segment.rowCount = 0;
				segment.sep = 0;
				segment.finalized = finalized;
				segment.version = version;
				segment.changeTracked = changeTracked;
				segment.committedRows = previousCommittedRows;
				if (previousStartRow !== row || previousRowCount !== 0 || previousSep !== 0) {
					this.#committedDirtySegments.add(segment);
				}
				segments[i] = segment;
				continue;
			}

			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;

			let settled = 0;
			if (!finalized || liveStartIndex === i) {
				const settledRaw = getBlockSettledRows(child);
				if (settledRaw > 0) {
					let lead = 0;
					while (lead < raw.length && isPlainBlank(raw[lead]!)) lead++;
					settled = Math.max(0, Math.min(contribution.length, settledRaw - lead));
				}
			}
			if (liveStartIndex === i) this.#nativeScrollbackLiveRegionStart = row + sep + settled;
			if (!finalized && isBlockPinned(child)) {
				if (pinCandidates === undefined) pinCandidates = [];
				pinCandidates.push({ index: i, pinAt: row + sep + settled });
			}

			const rowCount = sep + contribution.length;
			const stable = chainStable && reusable && previous?.startRow === row && previous.sep === sep;
			if (stable) {
				stableRows = row + rowCount;
			} else {
				if (chainStable) {
					chainStable = false;
					lines.length = row;
				}
				if (sep) lines.push("");
				for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);
			}

			segment.component = child;
			segment.rawRef = raw;
			segment.contribution = contribution;
			segment.width = width;
			segment.generation = this.#generation;
			segment.startRow = row;
			segment.rowCount = rowCount;
			segment.sep = sep;
			segment.finalized = finalized;
			segment.version = version;
			segment.changeTracked = changeTracked;
			segment.committedRows = previousCommittedRows;
			if (previousStartRow !== row || previousRowCount !== rowCount || previousSep !== sep) {
				this.#committedDirtySegments.add(segment);
			}
			segments[i] = segment;
			row += rowCount;
		}

		if (lines.length !== row) lines.length = row;
		this.#segments = segments as BlockSegment[];
		this.#stablePrefixLength = stablePrefixLength;
		this.#renderedChildrenRevision = this.#childrenRevision;
		this.#renderedGeneration = this.#generation;
		this.#renderedCommittedRows = this.#committedRows;
		if (widthChanged || previousSegments.length !== count || !chainStable || lines.length !== previousLineCount) {
			this.#renderRevision++;
		}

		if (pinCandidates) {
			let lastVisible = -1;
			for (let i = count - 1; i >= 0; i--) {
				if (segments[i]!.rowCount > 0) {
					lastVisible = i;
					break;
				}
			}
			for (const candidate of pinCandidates) {
				const block = this.children[candidate.index]! as Component & FinalizableBlock;
				if (candidate.index < lastVisible && block.isDisplaceableBlock?.() === true && !isBlockPinned(block))
					continue;
				this.#notePinnedLiveBlock(candidate.pinAt);
				break;
			}
		}

		// A volatile live block followed by finalized rows must pin at the end of
		// the live run, not at its unstable seam. This lets the live rows scroll
		// into history while keeping the finalized tail viewport-local; otherwise
		// every growth frame shifts and re-emits that tail. An already pinned
		// displaceable block retains its stricter, block-owned boundary.
		if (!this.#nativeScrollbackLiveRegionPinned && liveStartIndex >= 0) {
			let lastLiveIndex = liveStartIndex;
			for (let i = liveStartIndex + 1; i < count; i++) {
				if (!segments[i]!.finalized) lastLiveIndex = i;
			}
			const lastLiveBlock = this.children[lastLiveIndex]! as Component & FinalizableBlock;
			if (
				lastLiveBlock.isDisplaceableBlock?.() !== true &&
				segments.slice(lastLiveIndex + 1).some(segment => (segment?.rowCount ?? 0) > 0)
			) {
				this.#nativeScrollbackLiveRegionPinned = true;
				const lastLive = segments[lastLiveIndex]!;
				this.#nativeScrollbackLiveRegionPinnedStart = lastLive.startRow + lastLive.rowCount;
			}
		}
		this.#stableRowsFloor = Math.min(stableFloorBefore, stableRows, row);
		return lines;
	}
}

export class TranscriptBlock extends Container {}
