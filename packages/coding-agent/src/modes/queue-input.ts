import { formatDuration } from "@oh-my-pi/pi-utils";
import { parseCompoundDurationMs } from "./duration-args";

const QUEUE_PREFIXES: readonly string[] = ["->", "=>"];

export const QUEUE_LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/;
const CANONICAL_ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

interface EnumeratedItem {
	line: number;
	indent: string;
	marker: string;
	punctuation: string;
	content: string;
}

interface EnumeratedList {
	source: string;
	lines: string[];
	items: EnumeratedItem[];
}

/** Longest delay `/queue` accepts; keeps a typo like `/queue 99999999h ship it` from producing a dead entry. */
export const MAX_QUEUE_DELAY_MS = 365 * 86_400_000;

export const QUEUE_USAGE =
	"Usage: /queue [duration] <message> (or start a prompt with -> / =>). Examples: /queue ship it, /queue 3h run the benchmarks, /queue --cancel 1.";

export type QueueCommand =
	/** Deliver when the agent next yields. */
	| { kind: "queue"; text: string }
	/** Deliver once `delayMs` of wall-clock time has passed. */
	| { kind: "schedule"; delayMs: number; text: string }
	| { kind: "cancel"; target: number | "all" }
	| { kind: "error"; message: string };

function splitFirstToken(text: string): [string, string] {
	const boundary = text.search(/\s/);
	if (boundary === -1) return [text, ""];
	return [text.slice(0, boundary), text.slice(boundary + 1).trim()];
}

function parseCancelTarget(rest: string): QueueCommand {
	const target = rest.trim().toLowerCase();
	if (!target || target === "all") return { kind: "cancel", target: "all" };
	const position = Number(target);
	if (!Number.isSafeInteger(position) || position <= 0) {
		return { kind: "error", message: "Usage: /queue --cancel <n|all>" };
	}
	return { kind: "cancel", target: position };
}

/**
 * Splits `/queue` arguments into its three shapes. A leading token is read as a delay only when it is
 * a bare compound duration (`3h`, `1h30m`) followed by message text, so ordinary messages that merely
 * mention a duration still queue verbatim. The `-> ` / `=> ` shorthand never takes a delay or flags.
 */
export function parseQueueArgs(args: string): QueueCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "queue", text: "" };

	const [token, rest] = splitFirstToken(trimmed);
	if (token.toLowerCase() === "--cancel") return parseCancelTarget(rest);
	if (!rest) return { kind: "queue", text: trimmed };

	const delayMs = parseCompoundDurationMs(token);
	if (delayMs === undefined) return { kind: "queue", text: trimmed };
	if (delayMs === "unknown-unit") return { kind: "queue", text: trimmed };
	if (delayMs === "non-positive") return { kind: "error", message: `Queue delay must be positive. ${QUEUE_USAGE}` };
	if (delayMs > MAX_QUEUE_DELAY_MS) {
		return { kind: "error", message: `Queue delay must be at most ${formatDuration(MAX_QUEUE_DELAY_MS)}.` };
	}
	return { kind: "schedule", delayMs, text: rest };
}

function formatClockTime(dueAtMs: number, nowMs: number): string {
	const due = new Date(dueAtMs);
	const time = due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (due.toDateString() === new Date(nowMs).toDateString()) return time;
	return `${due.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** Countdown plus resolved wall-clock time, e.g. `2h58m (14:32)` or `17h (Sat 09:15)`. */
export function formatQueueDue(dueAtMs: number, nowMs = Date.now()): string {
	return `${formatDuration(Math.max(0, dueAtMs - nowMs))} (${formatClockTime(dueAtMs, nowMs)})`;
}

export function parseQueueShorthand(text: string): string | undefined {
	const prefix = QUEUE_PREFIXES.find(candidate => text.startsWith(candidate));
	return prefix ? text.slice(prefix.length).trim() : undefined;
}

function parseEnumeratedItem(line: string, lineIndex: number): EnumeratedItem | undefined {
	const match = QUEUE_LIST_MARKER_RE.exec(line);
	if (!match) return undefined;
	const [matched, indent, marker, punctuation] = match;
	if (indent === undefined || marker === undefined || punctuation === undefined) return undefined;
	return { line: lineIndex, indent, marker, punctuation, content: line.slice(matched.length).trimStart() };
}

function decodeDecimal(marker: string): number | undefined {
	if (!/^\d+$/.test(marker)) return undefined;
	const value = Number(marker);
	return Number.isSafeInteger(value) ? value : undefined;
}

function decodeRoman(marker: string): number | undefined {
	if (!CANONICAL_ROMAN_RE.test(marker)) return undefined;
	const values: Readonly<Record<string, number>> = {
		I: 1,
		V: 5,
		X: 10,
		L: 50,
		C: 100,
		D: 500,
		M: 1000,
	};
	const upper = marker.toUpperCase();
	let value = 0;
	for (let index = 0; index < upper.length; index++) {
		const current = values[upper[index] ?? ""];
		if (current === undefined) return undefined;
		const next = values[upper[index + 1] ?? ""] ?? 0;
		value += current < next ? -current : current;
	}
	return value;
}

function decodeAlpha(marker: string): number | undefined {
	if (!/^[A-Za-z]+$/.test(marker)) return undefined;
	let value = 0;
	for (const char of marker.toUpperCase()) {
		value = value * 26 + char.charCodeAt(0) - 64;
		if (!Number.isSafeInteger(value)) return undefined;
	}
	return value;
}

function isSequential(markers: readonly string[], decode: (marker: string) => number | undefined): boolean {
	let previous = decode(markers[0] ?? "");
	if (previous === undefined) return false;
	for (let index = 1; index < markers.length; index++) {
		const current = decode(markers[index] ?? "");
		if (current === undefined || current !== previous + 1) return false;
		previous = current;
	}
	return true;
}

function isEnumeratedSequence(items: readonly EnumeratedItem[]): boolean {
	const markers = items.map(item => item.marker);
	if (markers.every(marker => /^\d+$/.test(marker))) return isSequential(markers, decodeDecimal);
	if (
		!markers.every(marker => marker === marker.toUpperCase()) &&
		!markers.every(marker => marker === marker.toLowerCase())
	) {
		return false;
	}
	return isSequential(markers, decodeRoman) || isSequential(markers, decodeAlpha);
}

function parseEnumeratedList(text: string): EnumeratedList | undefined {
	const source = text.trim();
	if (!source) return undefined;
	const lines = source.split(/\r?\n/);
	const first = parseEnumeratedItem(lines[0] ?? "", 0);
	if (!first) return undefined;

	const items = [first];
	for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
		const item = parseEnumeratedItem(lines[lineIndex] ?? "", lineIndex);
		if (item?.indent === first.indent) items.push(item);
	}
	if (items.length < 2 || items.some(item => item.punctuation !== first.punctuation) || !isEnumeratedSequence(items)) {
		return undefined;
	}
	return { source, lines, items };
}

export function isQueuedMessageList(text: string): boolean {
	return parseEnumeratedList(text) !== undefined;
}

export function splitQueuedMessages(text: string): string[] {
	const list = parseEnumeratedList(text);
	if (!list) {
		const source = text.trim();
		return source ? [source] : [];
	}

	const messages = list.items.map((item, index) => {
		const nextLine = list.items[index + 1]?.line ?? list.lines.length;
		return [item.content, ...list.lines.slice(item.line + 1, nextLine)].join("\n").trim();
	});
	while (messages.at(-1) === "") messages.pop();
	return messages.length > 0 && messages.every(Boolean) ? messages : [list.source];
}
