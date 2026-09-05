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
	#widthEpochBoundaries = new WeakMap<
		object,
		{
			segment: BlockSegment;
			childBoundary: unknown;
			childHasBoundary: boolean;
			precedingSegments: BlockSegment[];
			trailingSegments: BlockSegment[];
		}
	>();

	#stableRowsFloor = 0;
	override addChild(component: Component): void {
		const wasEmpty = this.children.length === 0;
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		if (wasEmpty && this.onFirstContent) this.onFirstContent();
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
		super.clear();
		this.#lines = [];
		this.#segments = EMPTY_SEGMENTS;
		this.#renderWidth = -1;
		this.#stableRowsFloor = 0;
		this.#widthEpochBoundaries = new WeakMap();
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackLiveRegionPinned = false;
		this.#nativeScrollbackLiveRegionPinnedStart = undefined;
		this.#committedRows = 0;
	}

	override setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i]!;
			const segment = this.#segments[i];
			if (segment === undefined || segment.component !== child) continue;
			const committedContribution = Math.min(
				segment.contribution.length,
				Math.max(0, this.#committedRows - segment.startRow - segment.sep),
			);
			if (committedContribution === 0) {
				setBlockCommittedRows(child, 0);
				continue;
			}

			let leadingTrimmedRows = 0;
			while (leadingTrimmedRows < segment.rawRef.length && isPlainBlank(segment.rawRef[leadingTrimmedRows]!)) {
				leadingTrimmedRows++;
			}
			setBlockCommittedRows(child, Math.min(segment.rawRef.length, leadingTrimmedRows + committedContribution));
		}
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
			segment,
			childBoundary: childHasBoundary ? child.captureNativeScrollbackWidthEpoch?.() : undefined,
			childHasBoundary,
			precedingSegments: this.#segments.slice(0, segmentIndex),
			trailingSegments: this.#segments.slice(segmentIndex + 1),
		});
		return marker;
	}

	override resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const marker = this.#widthEpochBoundaries.get(boundary);
		if (!marker) return undefined;
		const currentIndex = this.#segments.findIndex(segment => segment.component === marker.segment.component);
		const current = this.#segments[currentIndex];
		if (!current) return undefined;
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
		for (const captured of marker.trailingSegments) {
			const trailing = this.#segments.find(segment => segment.component === captured.component);
			if (!captured.finalized || !trailing?.finalized || trailing.version !== captured.version) return undefined;
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

		const count = this.children.length;

		for (let i = 0; i < count && i < this.#segments.length; i++) {
			const previous = this.#segments[i];
			if (previous === undefined) continue;

			const bodyStart = previous.startRow + previous.sep;
			if (bodyStart >= this.#committedRows) break;
			if (previous.rowCount === 0 || previous.component !== this.children[i]) continue;
			sealCommittedSnapshot(previous.component);
		}

		let liveStartIndex = -1;
		let hasLiveBlock = false;
		for (let i = 0; i < count; i++) {
			if (!isBlockFinalized(this.children[i]!)) {
				liveStartIndex = i;
				hasLiveBlock = true;
				break;
			}
		}

		const lines = this.#lines;
		const previousLineCount = lines.length;
		const previousSegments = this.#segments;
		const widthChanged = this.#renderWidth !== width;
		const segments: BlockSegment[] = new Array(count);

		this.#segments = EMPTY_SEGMENTS;
		const stableFloorBefore = this.#stableRowsFloor;
		this.#stableRowsFloor = 0;

		let chainStable = !widthChanged;
		this.#renderWidth = width;

		if (!chainStable) lines.length = 0;

		let row = 0;
		let stableRows = 0;

		let pinCandidates: { index: number; pinAt: number }[] | undefined;
		for (let i = 0; i < count; i++) {
			const child = this.children[i]!;

			const previous = previousSegments[i];
			const finalized = isBlockFinalized(child);
			const version = getBlockVersion(child);
			const committedReusable =
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
				(previous !== undefined &&
					previous.component === child &&
					previous.rawRef === raw &&
					previous.width === width &&
					previous.generation === this.#generation);
			const contribution = reusable ? previous.contribution : stripPlainBlankEdges(raw);

			if (contribution.length === 0) {
				if (hasLiveBlock && i === liveStartIndex) {
					this.#nativeScrollbackLiveRegionStart = row;
				}
				if (!finalized && isBlockPinned(child)) {
					if (pinCandidates === undefined) pinCandidates = [];
					pinCandidates.push({ index: i, pinAt: row });
				}
				if (chainStable && !(reusable && previous.rowCount === 0 && previous.startRow === row)) {
					chainStable = false;
					lines.length = row;
				}
				if (chainStable) stableRows = row;
				segments[i] = {
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
				};
				continue;
			}

			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;

			let settled = 0;
			if (!finalized || (hasLiveBlock && i === liveStartIndex)) {
				const settledRaw = getBlockSettledRows(child);
				if (settledRaw > 0) {
					let lead = 0;
					while (lead < raw.length && isPlainBlank(raw[lead]!)) lead++;
					settled = Math.max(0, Math.min(contribution.length, settledRaw - lead));
				}
			}
			if (hasLiveBlock && i === liveStartIndex) {
				this.#nativeScrollbackLiveRegionStart = row + sep + settled;
			}
			if (!finalized && isBlockPinned(child)) {
				if (pinCandidates === undefined) pinCandidates = [];
				pinCandidates.push({ index: i, pinAt: row + sep + settled });
			}

			const rowCount = sep + contribution.length;
			const stable = chainStable && reusable && previous.startRow === row && previous.sep === sep;
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

			segments[i] = {
				component: child,
				rawRef: raw,
				contribution,
				width,
				generation: this.#generation,
				startRow: row,
				rowCount,
				sep,
				finalized,
				version,
			};
			row += rowCount;
		}

		if (lines.length !== row) lines.length = row;
		this.#segments = segments;
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
				if (candidate.index < lastVisible && block.isDisplaceableBlock?.() === true) continue;
				this.#notePinnedLiveBlock(candidate.pinAt);
				break;
			}
		}
		this.#stableRowsFloor = Math.min(stableFloorBefore, stableRows, row);
		return lines;
	}
}

export class TranscriptBlock extends Container {}
