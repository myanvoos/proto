import { hasFsCode, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import conflictNoticeTemplate from "../prompts/tools/read-conflict-notice.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";

interface ConflictBlock {
	startLine: number;

	separatorLine: number;

	endLine: number;

	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

export function scanConflictLines(lines: readonly string[], firstLineNumber: number): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let phase: "idle" | "ours" | "base" | "theirs" = "idle";
	let partial: {
		startLine: number;
		oursLabel?: string;
		oursLines: string[];
		baseLine?: number;
		baseLabel?: string;
		baseLines?: string[];
		separatorLine?: number;
		theirsLines?: string[];
	} | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = stripTrailingCr(lines[i]);
		const ln = firstLineNumber + i;

		const oursLabel = matchMarker(line, OURS_PREFIX);
		if (oursLabel !== null) {
			partial = { startLine: ln, oursLabel: oursLabel || undefined, oursLines: [] };
			phase = "ours";
			continue;
		}

		if (phase === "idle" || partial === null) continue;

		const baseLabel = matchMarker(line, BASE_PREFIX);
		if (baseLabel !== null) {
			if (phase !== "ours") {
				partial = null;
				phase = "idle";
				continue;
			}
			partial.baseLine = ln;
			partial.baseLabel = baseLabel || undefined;
			partial.baseLines = [];
			phase = "base";
			continue;
		}

		if (line === SEPARATOR) {
			if (phase === "ours" || phase === "base") {
				partial.separatorLine = ln;
				partial.theirsLines = [];
				phase = "theirs";
			} else {
				partial = null;
				phase = "idle";
			}
			continue;
		}

		const theirsLabel = matchMarker(line, THEIRS_PREFIX);
		if (theirsLabel !== null) {
			if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
				blocks.push({
					startLine: partial.startLine,
					separatorLine: partial.separatorLine,
					endLine: ln,
					baseLine: partial.baseLine,
					oursLabel: partial.oursLabel,
					baseLabel: partial.baseLabel,
					theirsLabel: theirsLabel || undefined,
					oursLines: partial.oursLines,
					baseLines: partial.baseLines,
					theirsLines: partial.theirsLines,
				});
			}
			partial = null;
			phase = "idle";
			continue;
		}

		if (phase === "ours") partial.oursLines.push(line);
		else if (phase === "base" && partial.baseLines) partial.baseLines.push(line);
		else if (phase === "theirs" && partial.theirsLines) partial.theirsLines.push(line);
	}

	return blocks;
}

interface ConflictFileScan {
	blocks: ConflictBlock[];
	truncatedAtLine?: number;
}

const SCAN_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export async function scanFileForConflicts(
	absolutePath: string,
	options: { maxBytes?: number } = {},
): Promise<{ blocks: ConflictBlock[]; scanTruncated: boolean }> {
	const maxBytes = options.maxBytes ?? SCAN_FILE_DEFAULT_MAX_BYTES;
	const file = Bun.file(absolutePath);
	const size = file.size;
	const truncated = size > maxBytes;
	const bytes = truncated ? new Uint8Array(await file.slice(0, maxBytes).arrayBuffer()) : await file.bytes();
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

	const lines = text.split("\n");
	return { blocks: scanConflictLines(lines, 1), scanTruncated: truncated };
}

function matchMarker(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) return null;
	if (line.length === prefix.length) return "";
	if (line.charCodeAt(prefix.length) !== 32) return null;
	return line.slice(prefix.length + 1);
}

export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

export class ConflictHistory {
	#nextId = 1;
	#entries = new Map<number, ConflictEntry>();

	/**
	 * Reuse an id only for the same block at the same position. Reconciliation
	 * relocates unchanged blocks first; a changed block never inherits an old id.
	 */
	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				if (!conflictRegionsEqual(existing, input)) {
					this.#entries.delete(existing.id);
					continue;
				}
				const merged: ConflictEntry = { ...input, id: existing.id };
				this.#entries.set(existing.id, merged);
				return merged;
			}
		}
		const id = this.#nextId++;
		const entry: ConflictEntry = { ...input, id };
		this.#entries.set(id, entry);
		return entry;
	}

	/**
	 * Refresh only already-registered blocks, without registering unseen ones.
	 * Match unchanged positions before relocations so identical distinct blocks
	 * keep separate ids. A capped scan cannot disprove a block crossing or beyond
	 * its unscanned boundary.
	 */
	reconcilePath(absolutePath: string, scan: ConflictFileScan): void {
		const entries = this.entries().filter(entry => entry.absolutePath === absolutePath);
		const available = new Set(scan.blocks);
		const matched = new Map<ConflictEntry, ConflictBlock>();
		for (const entry of entries) {
			for (const block of available) {
				if (block.startLine === entry.startLine && conflictRegionsEqual(entry, block)) {
					matched.set(entry, block);
					available.delete(block);
					break;
				}
			}
		}
		for (const entry of entries) {
			if (matched.has(entry)) continue;
			let nearest: ConflictBlock | undefined;
			let distance = Number.POSITIVE_INFINITY;
			for (const block of available) {
				const delta = Math.abs(block.startLine - entry.startLine);
				if (delta < distance && conflictRegionsEqual(entry, block)) {
					nearest = block;
					distance = delta;
				}
			}
			if (nearest) {
				matched.set(entry, nearest);
				available.delete(nearest);
			}
		}
		for (const entry of entries) {
			const block = matched.get(entry);
			if (block) this.#entries.set(entry.id, { ...entry, ...block });
			else if (scan.truncatedAtLine === undefined || entry.endLine < scan.truncatedAtLine) {
				this.#entries.delete(entry.id);
			}
		}
	}

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	/** Snapshot every registered entry in insertion (id) order. */
	entries(): ConflictEntry[] {
		return [...this.#entries.values()];
	}

	/** Drop a single entry by id. Used after a successful resolve. */
	invalidate(id: number): void {
		this.#entries.delete(id);
	}

	/** Drop every entry referencing `absolutePath`. Used after a successful resolve. */
	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.#entries) {
			if (entry.absolutePath === absolutePath) {
				this.#entries.delete(id);
			}
		}
	}
}

/**
 * Stream `absolutePath` for marker blocks equal to a registered entry. Unlike
 * discovery this has no byte cap, so memory is bounded instead: only one
 * candidate block is held, and it is dropped once it outgrows the largest
 * registered block (in lines or line bytes). Stops early once every entry is
 * found at its recorded line.
 */
async function findRegisteredBlocks(absolutePath: string, entries: readonly ConflictEntry[]): Promise<ConflictBlock[]> {
	const regions = new Set<string>();
	const unconfirmed = new Map<number, string>();
	let maxLines = 0;
	let maxLineBytes = 0;
	for (const entry of entries) {
		const region = buildRecordedRegion(entry);
		const key = region.join("\n");
		regions.add(key);
		unconfirmed.set(entry.startLine, key);
		maxLines = Math.max(maxLines, region.length);
		for (const line of region) maxLineBytes = Math.max(maxLineBytes, Buffer.byteLength(line));
	}
	maxLineBytes += 1; // trailing CR

	const found: ConflictBlock[] = [];
	let candidate: string[] = [];
	let candidateStart = 0;
	/** Feed one line (`null` when over the byte bound); returns true once every entry is confirmed. */
	const feed = (raw: string | null, lineNumber: number): boolean => {
		const line = raw === null ? null : stripTrailingCr(raw);
		if (line !== null && matchMarker(line, OURS_PREFIX) !== null) {
			candidate = [line];
			candidateStart = lineNumber;
			return false;
		}
		if (candidate.length === 0) return false;
		if (line === null || candidate.length === maxLines) {
			candidate = [];
			return false;
		}
		candidate.push(line);
		if (matchMarker(line, THEIRS_PREFIX) === null) return false;
		const block = scanConflictLines(candidate, candidateStart)[0];
		candidate = [];
		if (!block) return false;
		const key = buildRecordedRegion(block).join("\n");
		if (!regions.has(key)) return false;
		found.push(block);
		if (unconfirmed.get(block.startLine) === key) unconfirmed.delete(block.startLine);
		return unconfirmed.size === 0;
	};

	// The decoder drops a leading BOM, as discovery's whole-file decode does.
	const decoder = new TextDecoder();
	let parts: Uint8Array[] = [];
	let lineBytes = 0;
	let lineNumber = 1;
	const takeLine = (): string | null => {
		const line = lineBytes > maxLineBytes ? null : decoder.decode(Buffer.concat(parts, lineBytes));
		parts = [];
		lineBytes = 0;
		return line;
	};
	for await (const chunk of Bun.file(absolutePath).stream()) {
		let start = 0;
		for (let end = chunk.indexOf(10); ; end = chunk.indexOf(10, start)) {
			const segment = chunk.subarray(start, end === -1 ? chunk.length : end);
			lineBytes += segment.length;
			if (lineBytes <= maxLineBytes) parts.push(segment);
			if (end === -1) break;
			if (feed(takeLine(), lineNumber++)) return found;
			start = end + 1;
		}
	}
	if (lineBytes > 0) feed(takeLine(), lineNumber);
	return found;
}

/**
 * Re-check registered ids against the live file contents (all files, or only
 * `absolutePath`): unchanged blocks follow line shifts, changed or vanished
 * ones are retired, and a deleted file retires all of its ids.
 */
export async function reconcileRegisteredConflicts(history: ConflictHistory, absolutePath?: string): Promise<void> {
	const byPath = Map.groupBy(
		history.entries().filter(entry => absolutePath === undefined || entry.absolutePath === absolutePath),
		entry => entry.absolutePath,
	);
	for (const [file, entries] of byPath) {
		try {
			history.reconcilePath(file, { blocks: await findRegisteredBlocks(file, entries) });
		} catch (error) {
			if (!isEnoent(error) && !hasFsCode(error, "ENOTDIR")) throw error;
			history.invalidatePath(file);
		}
	}
}

export function getConflictHistory(session: ToolSession): ConflictHistory {
	if (!session.conflictHistory) session.conflictHistory = new ConflictHistory();
	return session.conflictHistory;
}

export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

export interface ParsedConflictUri {
	id: number;
	scope?: ConflictScope;
}

const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const tail = match[2];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>' or 'conflict://<N>/<scope>' where N is a positive integer surfaced by a prior \`read\`. Use the \`<path>:conflicts\` read selector to list every conflict in a file.`,
		);
	}
	const id = Number.parseInt(idPart, 10);
	if (!Number.isFinite(id) || id < 1) {
		throw new ToolError(`Invalid conflict URI '${raw}': id must be ≥ 1.`);
	}

	let scope: ConflictScope | undefined;
	if (scopePart !== undefined) {
		if (!CONFLICT_SCOPES.has(scopePart as ConflictScope)) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`,
			);
		}
		scope = scopePart as ConflictScope;
	}

	return { id, scope };
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function markerLine(prefix: string, label: string | undefined): string {
	return label && label.length > 0 ? `${prefix} ${label}` : prefix;
}

export function renderConflictRegion(
	entry: ConflictEntry,
	scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
	if (scope === "ours") {
		return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	}
	if (scope === "theirs") {
		return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
	}
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined) {
			throw new ToolError(
				`Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
			);
		}
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	const out: string[] = [];
	out.push(markerLine("<<<<<<<", entry.oursLabel));
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(markerLine("|||||||", entry.baseLabel));
		out.push(...entry.baseLines);
	}
	out.push("=======");
	out.push(...entry.theirsLines);
	out.push(markerLine(">>>>>>>", entry.theirsLabel));
	return { lines: out, startLine: entry.startLine };
}

const PREVIEW_SIDE_LINES = 6;

interface ConflictNoticeOptions {
	displayPath: string;

	bashActive: boolean;
}

interface FormatConflictWarningOptions extends ConflictNoticeOptions {
	totalInFile?: number;

	scanTruncated?: boolean;
}

function formatConflictNotice(options: ConflictNoticeOptions): string {
	return prompt.render(conflictNoticeTemplate, { path: options.displayPath, bash: options.bashActive });
}

export function formatConflictWarning(
	entries: readonly ConflictEntry[],
	options: FormatConflictWarningOptions,
): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [];
	out.push("");
	const word = total === 1 ? "conflict" : "conflicts";
	if (partial) {
		out.push(
			`${entries.length} of ${total} unresolved ${word} visible in this window; only blocks below are registered. Do not infer other ids; read \`${options.displayPath}:conflicts\` to list and register them.`,
		);
	} else {
		out.push(`${total} unresolved ${word} detected`);
	}
	if (options.scanTruncated) {
		out.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}

	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) out.push(`- ours = ${oursLabel}`);
	if (theirsLabel) out.push(`- theirs = ${theirsLabel}`);
	if (anyBase) out.push(`- base = ${baseLabel ?? "(no label)"}`);
	out.push(formatConflictNotice(options));

	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		out.push("");
		out.push(`──── #${entry.id}  ${range} ────`);

		const baseEqualsOurs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.oursLines);
		const baseEqualsTheirs = entry.baseLines !== undefined && sectionsEqual(entry.baseLines, entry.theirsLines);
		const theirsEqualsOurs = sectionsEqual(entry.theirsLines, entry.oursLines);

		out.push("<<< ours");
		appendBody(out, entry.oursLines);

		if (entry.baseLines !== undefined) {
			if (baseEqualsOurs) {
				out.push("=== base ≡ ours");
			} else if (baseEqualsTheirs) {
				out.push("=== base ≡ theirs");
			} else {
				out.push("=== base");
				appendBody(out, entry.baseLines);
			}
		}

		if (theirsEqualsOurs) {
			out.push(">>> theirs ≡ ours");
		} else {
			out.push(">>> theirs");
			appendBody(out, entry.theirsLines);
		}
	}
	return out.join("\n");
}

export function formatConflictSummary(
	entries: readonly ConflictEntry[],
	options: ConflictNoticeOptions & { scanTruncated?: boolean },
): string {
	const lines: string[] = [];
	const total = entries.length;
	const word = total === 1 ? "conflict" : "conflicts";
	lines.push(`${total} unresolved ${word} in ${options.displayPath}`);
	if (options.scanTruncated) {
		lines.push("- note: file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix.");
	}
	const oursLabel = pickLabel(entries, e => e.oursLabel);
	const theirsLabel = pickLabel(entries, e => e.theirsLabel);
	const baseLabel = pickLabel(entries, e => (e.baseLines !== undefined ? e.baseLabel : undefined));
	const anyBase = entries.some(e => e.baseLines !== undefined);
	if (oursLabel) lines.push(`- ours = ${oursLabel}`);
	if (theirsLabel) lines.push(`- theirs = ${theirsLabel}`);
	if (anyBase) lines.push(`- base = ${baseLabel ?? "(no label)"}`);
	lines.push(formatConflictNotice(options));
	lines.push("");
	const idWidth = String(entries[entries.length - 1]?.id ?? 1).length;
	for (const entry of entries) {
		const range = entry.startLine === entry.endLine ? `L${entry.startLine}` : `L${entry.startLine}-${entry.endLine}`;
		const idCell = `#${String(entry.id).padStart(idWidth, " ")}`;
		const kind = entry.baseLines !== undefined ? "  (3-way)" : "";
		lines.push(`${idCell}  ${range}${kind}`);
	}
	return lines.join("\n");
}

function pickLabel(
	entries: readonly ConflictEntry[],
	get: (e: ConflictEntry) => string | undefined,
): string | undefined {
	for (const e of entries) {
		const label = get(e);
		if (label && label.trim().length > 0) return label;
	}
	return undefined;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function appendBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	const shown = section.slice(0, PREVIEW_SIDE_LINES);
	for (const line of shown) out.push(line);
	const hidden = section.length - shown.length;
	if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? "" : "s"})`);
}

function buildRecordedRegion(entry: ConflictBlock): string[] {
	const out: string[] = [];
	out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX);
	out.push(...entry.oursLines);
	if (entry.baseLines !== undefined) {
		out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX);
		out.push(...entry.baseLines);
	}
	out.push(SEPARATOR);
	out.push(...entry.theirsLines);
	out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX);
	return out;
}

export function conflictRegionsEqual(a: ConflictBlock, b: ConflictBlock): boolean {
	const ra = buildRecordedRegion(a);
	const rb = buildRecordedRegion(b);
	if (ra.length !== rb.length) return false;
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return false;
	}
	return true;
}
