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

	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.#entries.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
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

	get(id: number): ConflictEntry | undefined {
		return this.#entries.get(id);
	}

	entries(): ConflictEntry[] {
		return [...this.#entries.values()];
	}
}

export function getConflictHistory(session: ToolSession): ConflictHistory {
	if (!session.conflictHistory) session.conflictHistory = new ConflictHistory();
	return session.conflictHistory;
}

export type ConflictScope = "ours" | "theirs" | "base";

const CONFLICT_SCOPES = new Set<ConflictScope>(["ours", "theirs", "base"]);

export interface ParsedConflictUri {
	id: number | "*";
	scope?: ConflictScope;

	recoveredPrefix?: string;
}

const CONFLICT_URI_RE = /^(?:(.+):)?conflict:\/\/(.+)$/;

export function parseConflictUri(raw: string): ParsedConflictUri | null {
	const match = raw.match(CONFLICT_URI_RE);
	if (!match) return null;
	const recoveredPrefix = match[1];
	const tail = match[2];
	const slashIdx = tail.indexOf("/");
	const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
	const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);

	if (idPart === "*") {
		if (scopePart !== undefined) {
			throw new ToolError(
				`Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`,
			);
		}
		return recoveredPrefix !== undefined ? { id: "*", recoveredPrefix } : { id: "*" };
	}

	if (!/^\d+$/.test(idPart)) {
		throw new ToolError(
			`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior \`read\`.`,
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

	return recoveredPrefix !== undefined ? { id, scope, recoveredPrefix } : { id, scope };
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

interface FormatConflictWarningOptions {
	totalInFile?: number;

	displayPath?: string;

	scanTruncated?: boolean;
}

export function formatConflictWarning(
	entries: readonly ConflictEntry[],
	options: FormatConflictWarningOptions = {},
): string {
	if (entries.length === 0) return "";
	const total = options.totalInFile ?? entries.length;
	const partial = total > entries.length;
	const out: string[] = [];
	out.push("");
	const word = total === 1 ? "conflict" : "conflicts";
	if (partial) {
		const hintPath = options.displayPath ?? "<file>";
		out.push(
			`${entries.length} of ${total} unresolved ${word} visible in this window (read \`${hintPath}:conflicts\` for the full list).`,
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
	out.push(
		'NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side). Resolve with `write({ path: "conflict://<N>", content })`, or bulk-resolve every registered conflict with `write({ path: "conflict://*", content })`. Writes replace ONLY the marker block (markers + all sides) — never repeat the lines before/after it; they stay in place.',
	);
	out.push(
		'`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. `@both` is ours-then-theirs with no separator — only for additive conflicts where each side adds something different; NEVER for competing edits of the same lines (pick a side or write the combined text). Lines that are not a token pass through verbatim, so `"// keep both\\n@ours\\n@theirs"` literally writes the comment, then ours, then theirs.',
	);
	out.push(
		'Per-id bulk: `write({ path: "conflict://*", content: "1: @ours\\n2: @theirs\\n…" })` resolves each listed id with that side in ONE call — the cheapest way through many pick-one conflicts; unlisted ids stay registered.',
	);
	out.push(
		"Resolve each block faithfully: keep one side (`@ours`/`@theirs`), or combine them when both intents apply — never invent content beyond the recorded sides, and never stack both sides of competing edits. Resolve several conflicts in a single turn by issuing multiple `write` calls at once; ids stay valid as earlier blocks are resolved.",
	);

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
	options: { displayPath: string; scanTruncated?: boolean } = { displayPath: "" },
): string {
	const lines: string[] = [];
	const total = entries.length;
	const word = total === 1 ? "conflict" : "conflicts";
	lines.push(`${total} unresolved ${word} in ${options.displayPath || "<file>"}`);
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
	lines.push(
		'NOTICE: Bulk-resolve with `write({ path: "conflict://*", content })`, or address a single block with `write({ path: "conflict://<N>", content })`. Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` for a single side).',
	);
	lines.push(
		'`content` shorthand: `@ours` / `@theirs` / `@base` / `@both` lines expand to the recorded sections; `@both` = ours-then-theirs (additive conflicts only — never for competing edits of the same lines). Per-id bulk: content of `<id>: @side` lines (e.g. "1: @ours\\n2: @theirs") resolves each listed id in one call. Non-token lines pass through verbatim. Writes replace ONLY the marker block — never repeat the surrounding lines. Keep one side or combine faithfully; never invent content beyond the recorded sides.',
	);
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
