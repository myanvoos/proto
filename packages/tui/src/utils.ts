import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	setHangulCompatJamoWidthOverride as nativeSetHangulCompatJamoWidthOverride,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils/tab-spacing";

export { Ellipsis } from "@oh-my-pi/pi-natives";

export { DEFAULT_TAB_WIDTH };

export type HangulCompatibilityJamoWidth = "platform" | "unicode" | 1 | 2;

let hangulCompatibilityJamoWidth: HangulCompatibilityJamoWidth = "platform";

function nativeHangulCompatibilityJamoOverride(width: HangulCompatibilityJamoWidth): number {
	if (width === "unicode") return 3;
	if (typeof width === "number") return width;
	return 0;
}

export function getHangulCompatibilityJamoWidth(): HangulCompatibilityJamoWidth {
	return hangulCompatibilityJamoWidth;
}

let widthConfigEpoch = 0;

export function getWidthConfigEpoch(): number {
	return widthConfigEpoch;
}

interface LineWidthsEntry {
	epoch: number;
	lines: readonly string[];
	widths: readonly number[];
}

const lineWidthSidecar = new WeakMap<readonly string[], LineWidthsEntry>();

export function publishLineWidths(lines: readonly string[], widths: readonly number[]): void {
	if (lines.length !== widths.length) {
		throw new RangeError(`Cannot publish ${widths.length} widths for ${lines.length} lines`);
	}
	lineWidthSidecar.set(lines, {
		epoch: widthConfigEpoch,
		lines: [...lines],
		widths: Object.freeze([...widths]),
	});
}

export function getPublishedLineWidths(lines: readonly string[]): readonly number[] | undefined {
	const entry = lineWidthSidecar.get(lines);
	if (entry === undefined || entry.epoch !== widthConfigEpoch || entry.lines.length !== lines.length) {
		return undefined;
	}
	for (let i = 0; i < lines.length; i++) {
		if (entry.lines[i] !== lines[i]) return undefined;
	}
	return entry.widths;
}

export function setHangulCompatibilityJamoWidth(width: HangulCompatibilityJamoWidth): boolean {
	const changed = hangulCompatibilityJamoWidth !== width;
	hangulCompatibilityJamoWidth = width;
	if (changed) widthConfigEpoch++;
	nativeSetHangulCompatJamoWidthOverride(nativeHangulCompatibilityJamoOverride(width));
	return changed;
}

export function resetHangulCompatibilityJamoWidthForTests(): void {
	if (hangulCompatibilityJamoWidth !== "platform") widthConfigEpoch++;
	hangulCompatibilityJamoWidth = "platform";
	nativeSetHangulCompatJamoWidthOverride(0);
}

export type TextSizingScale = 1 | 2 | 3;
export type TextSizingVerticalAlign = "top" | "bottom" | "center";
export type TextSizingHorizontalAlign = "left" | "right" | "center";

export interface TextSizingOptions {
	scale?: TextSizingScale;
	widthCells?: number;
	verticalAlign?: TextSizingVerticalAlign;
	horizontalAlign?: TextSizingHorizontalAlign;
}

const OSC66_UNSAFE = /[\x00-\x1f\x7f-\x9f]/u;
const OSC66_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f]/gu;

function textSizingVerticalAlignValue(align: TextSizingVerticalAlign | undefined): number | undefined {
	switch (align) {
		case "top":
			return 0;
		case "bottom":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

function textSizingHorizontalAlignValue(align: TextSizingHorizontalAlign | undefined): number | undefined {
	switch (align) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

export function encodeTextSized(text: string, options: TextSizingOptions = {}): string {
	const metadata: string[] = [];
	if (options.scale !== undefined) metadata.push(`s=${options.scale}`);
	if (options.widthCells !== undefined && Number.isFinite(options.widthCells)) {
		metadata.push(`w=${Math.max(0, Math.trunc(options.widthCells))}`);
	}
	const verticalAlign = textSizingVerticalAlignValue(options.verticalAlign);
	if (verticalAlign !== undefined) metadata.push(`v=${verticalAlign}`);
	const horizontalAlign = textSizingHorizontalAlignValue(options.horizontalAlign);
	if (horizontalAlign !== undefined) metadata.push(`h=${horizontalAlign}`);

	const safeText = OSC66_UNSAFE.test(text) ? text.replace(OSC66_UNSAFE_GLOBAL, " ") : text;
	return `\x1b]66;${metadata.join(":")};${safeText}\x1b\\`;
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, DEFAULT_TAB_WIDTH);
}

const TRUNCATE_CACHE_MAX = 512;
const TRUNCATE_CACHE_MAX_SIZE = 4 * 1024 * 1024;
const TRUNCATE_CACHE_MAX_ENTRY_SIZE = 64 * 1024;
const TRUNCATE_CACHE_MAX_TEXT_LENGTH = 8 * 1024;

const truncateCache = new LRUCache<string, string>({
	max: TRUNCATE_CACHE_MAX,
	maxSize: TRUNCATE_CACHE_MAX_SIZE,
	maxEntrySize: TRUNCATE_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: (value, key) => key.length + value.length,
});

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	maxWidth = Math.max(0, maxWidth | 0);
	const shouldPad = pad ?? false;
	const ellipsis = (typeof ellipsisKind === "string" ? Ellipsis.Omit : ellipsisKind) ?? Ellipsis.Unicode;

	if (!shouldPad && text.length <= maxWidth && PRINTABLE_ASCII_REGEX.test(text)) return text;
	if (!shouldPad && text.length * 3 <= maxWidth) return text;
	if (!shouldPad && !PRINTABLE_ASCII_REGEX.test(text) && visibleWidth(text) <= maxWidth) return text;
	if (text.length <= TRUNCATE_CACHE_MAX_TEXT_LENGTH) {
		const key = `${widthConfigEpoch}:${maxWidth}:${ellipsis}:${shouldPad ? 1 : 0}\x00${text}`;
		const cached = truncateCache.get(key);
		if (cached !== undefined) return cached;
		const result = nativeTruncateToWidth(text, maxWidth, ellipsis, shouldPad, DEFAULT_TAB_WIDTH);
		truncateCache.set(key, result);
		return result;
	}
	return nativeTruncateToWidth(text, maxWidth, ellipsis, shouldPad, DEFAULT_TAB_WIDTH);
}

export function truncateStartToWidth(text: string, maxWidth: number): string {
	maxWidth = Math.max(0, maxWidth | 0);
	const total = visibleWidth(text);
	if (total <= maxWidth) return text;
	const ellipsis = "…";
	const budget = maxWidth - visibleWidth(ellipsis);
	if (budget < 1) return maxWidth === 0 ? "" : ellipsis;
	return ellipsis + sliceByColumn(text, total - budget, budget);
}

const WRAP_CACHE_MAX = 512;
const WRAP_CACHE_MAX_SIZE = 16 * 1024 * 1024;
const WRAP_CACHE_MAX_ENTRY_SIZE = 512 * 1024;
const WRAP_CACHE_MAX_TEXT_LENGTH = 64 * 1024;

const wrapCache = new LRUCache<string, string[]>({
	max: WRAP_CACHE_MAX,
	maxSize: WRAP_CACHE_MAX_SIZE,
	maxEntrySize: WRAP_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: (lines, key) => key.length + lines.reduce((size, line) => size + line.length, 0),
});
let wrapCacheEpoch = widthConfigEpoch;

export function wrapTextWithAnsi(text: string, width: number): string[] {
	// Wrapping follows the configured terminal cell width (notably Hangul Jamo), so
	// discard entries rather than serving rows calculated for a prior width mode.
	if (wrapCacheEpoch !== widthConfigEpoch) {
		wrapCache.clear();
		wrapCacheEpoch = widthConfigEpoch;
	}

	// Short plain ASCII lines are already a complete wrapped row. Besides avoiding
	// the native call this keeps the common transcript path on a cheap JS path.
	if (width > 0 && text.length <= width && PRINTABLE_ASCII_REGEX.test(text)) return [text];
	if (text.length > WRAP_CACHE_MAX_TEXT_LENGTH) return nativeWrapTextWithAnsi(text, width, DEFAULT_TAB_WIDTH);

	const key = `${widthConfigEpoch}:${width}\x00${text}`;
	const cached = wrapCache.get(key);
	if (cached !== undefined) return cached;
	const lines = nativeWrapTextWithAnsi(text, width, DEFAULT_TAB_WIDTH);
	wrapCache.set(key, lines);
	return lines;
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
): ExtractSegmentsResult {
	return nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, DEFAULT_TAB_WIDTH);
}

const SPACE_BUFFER = " ".repeat(512);
const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

const OSC66_SPAN_REGEX = /\x1b\]66;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)/g;
const OSC66_PREFIX = "\x1b]66;";

const APC_SPAN_REGEX = /\x1b_[\s\S]*?(?:\x07|\x1b\\)/g;
const APC_PREFIX = "\x1b_";
const PRINTABLE_ASCII_REGEX = /^[\u0020-\u007e]*$/;

const STRING_WIDTH_OPTS = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;

const HANGUL_FILLER_CODE_POINT = 0x3164;

const HANGUL_COMPAT_JAMO_BUN_WIDTH = 2;

function printableAsciiSgrWidth(str: string): number | undefined {
	let width = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 0x1b) {
			if (str.charCodeAt(i + 1) !== 0x5b) return undefined;
			i += 2;
			let terminated = false;
			for (; i < str.length; i++) {
				const final = str.charCodeAt(i);
				if (final >= 0x40 && final <= 0x7e) {
					if (final !== 0x6d) return undefined;
					terminated = true;
					break;
				}
			}
			if (!terminated) return undefined;
			continue;
		}
		if (code < 0x20 || code > 0x7e) return undefined;
		width++;
	}
	return width;
}

function hangulCompatibilityJamoTargetWidth(): 1 | 2 | null {
	switch (hangulCompatibilityJamoWidth) {
		case 1:
			return 1;
		case 2:
			return 2;
		case "unicode":
			return null;
		default:
			return process.platform === "darwin" ? 1 : null;
	}
}

function correctHangulCompatibilityJamoWidth(
	width: number,
	compatibilityJamoCount: number,
	fillerCount: number,
): number {
	if (compatibilityJamoCount === 0) return width;
	const target = hangulCompatibilityJamoTargetWidth();
	return target === 1 ? width - compatibilityJamoCount : width - fillerCount * HANGUL_COMPAT_JAMO_BUN_WIDTH;
}

const VISIBLE_WIDTH_CACHE_MAX = 2048;
const VISIBLE_WIDTH_CACHE_MAX_LEN = 64;
const visibleWidthCache = new Map<string, number>();
let visibleWidthCacheEpoch = widthConfigEpoch;

function cacheVisibleWidth(str: string, width: number): void {
	while (visibleWidthCache.size >= VISIBLE_WIDTH_CACHE_MAX) {
		const oldest = visibleWidthCache.keys().next();
		if (oldest.done) break;
		visibleWidthCache.delete(oldest.value);
	}
	visibleWidthCache.set(str, width);
}

export function visibleWidth(str: string): number {
	if (!str) return 0;
	// Printable ASCII has a one-cell-per-code-unit width; avoid cache churn for
	// these ubiquitous short labels and let the regex be the complete fast path.
	if (PRINTABLE_ASCII_REGEX.test(str)) return str.length;
	if (str.indexOf("\x1b") !== -1) {
		const sgrWidth = printableAsciiSgrWidth(str);
		if (sgrWidth !== undefined) return sgrWidth;
	}

	const cacheable = str.length <= VISIBLE_WIDTH_CACHE_MAX_LEN;
	if (cacheable) {
		if (visibleWidthCacheEpoch !== widthConfigEpoch) {
			visibleWidthCache.clear();
			visibleWidthCacheEpoch = widthConfigEpoch;
		}
		const cached = visibleWidthCache.get(str);
		if (cached !== undefined) return cached;
	}

	let tabCount = 0;
	let compatibilityJamoCount = 0;
	let fillerCount = 0;
	let hasEsc = false;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 0x09) {
			tabCount++;
		} else if (code === 0x1b) {
			hasEsc = true;
		} else if (code >= 0x3131 && code <= 0x318e) {
			compatibilityJamoCount++;
			if (code === HANGUL_FILLER_CODE_POINT) fillerCount++;
		}
	}

	const measurable = hasEsc && str.includes(APC_PREFIX) ? str.replace(APC_SPAN_REGEX, "") : str;
	let width = Bun.stringWidth(measurable, STRING_WIDTH_OPTS);
	if (tabCount > 0) width += tabCount * DEFAULT_TAB_WIDTH;

	if (hasEsc && str.includes(OSC66_PREFIX)) {
		OSC66_SPAN_REGEX.lastIndex = 0;
		for (let m = OSC66_SPAN_REGEX.exec(str); m !== null; m = OSC66_SPAN_REGEX.exec(str)) {
			let scale = 1;
			let explicit: number | undefined;
			for (const part of m[1].split(":")) {
				if (part.indexOf("=") !== 1) continue;
				const value = Number.parseInt(part.slice(2), 10);
				if (!Number.isFinite(value)) continue;
				if (part[0] === "s") {
					if (value >= 1 && value <= 7) scale = value;
				} else if (part[0] === "w" && value > 0) {
					explicit = value;
				}
			}
			width += scale * (explicit ?? Bun.stringWidth(m[2], STRING_WIDTH_OPTS));
		}
	}

	width = correctHangulCompatibilityJamoWidth(width, compatibilityJamoCount, fillerCount);
	if (cacheable) {
		cacheVisibleWidth(str, width);
	}
	return width;
}

export function isOsc66Line(line: string): boolean {
	return line.includes(OSC66_PREFIX);
}

export function osc66MaxScale(line: string): number {
	if (!line.includes(OSC66_PREFIX)) return 1;
	let max = 1;
	OSC66_SPAN_REGEX.lastIndex = 0;
	for (let m = OSC66_SPAN_REGEX.exec(line); m !== null; m = OSC66_SPAN_REGEX.exec(line)) {
		for (const part of m[1].split(":")) {
			if (part.indexOf("=") !== 1 || part[0] !== "s") continue;
			const value = Number.parseInt(part.slice(2), 10);
			if (Number.isFinite(value) && value > max && value <= 7) max = value;
		}
	}
	return max;
}

const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	if (str.indexOf("\u0e33") === -1 && str.indexOf("\u0eb3") === -1) return str;
	return str.replace(THAI_LAO_AM_GLOBAL_REGEX, char => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
}

const makeBoolArray = (chars: string): Uint8Array => {
	const table = new Uint8Array(128);
	for (let i = 0; i < chars.length; i++) {
		const code = chars.charCodeAt(i);
		if (code < table.length) {
			table[code] = 1;
		}
	}
	return table;
};

const ASCII_WHITESPACE = makeBoolArray("\x09\x0a\x0b\x0c\x0d\x20");

export function isWhitespaceChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_WHITESPACE[code] === 1;
}

const ASCII_PUNCTUATION = makeBoolArray("(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`");

export function isPunctuationChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_PUNCTUATION[code] === 1;
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

const WORD_NAV_RE_WHITESPACE = /^\p{White_Space}$/u;
const WORD_NAV_RE_PUNCT = /^\p{P}$/u;
const WORD_NAV_RE_SYMBOL = /^\p{S}$/u;
const WORD_NAV_RE_LETTER = /^\p{L}$/u;
const WORD_NAV_RE_NUMBER = /^\p{N}$/u;
const WORD_NAV_RE_HAN = /^\p{Script=Han}$/u;
const WORD_NAV_RE_HIRAGANA = /^\p{Script=Hiragana}$/u;
const WORD_NAV_RE_KATAKANA = /^\p{Script=Katakana}$/u;
const WORD_NAV_RE_HANGUL = /^\p{Script=Hangul}$/u;

function firstCodePointChar(str: string): string {
	const cp = str.codePointAt(0);
	if (cp === undefined) return "";
	return String.fromCodePoint(cp);
}

export function getWordNavKind(grapheme: string): WordNavKind {
	if (!grapheme) return "other";
	const ch = firstCodePointChar(grapheme);
	if (!ch) return "other";
	if (WORD_NAV_RE_WHITESPACE.test(ch)) return "whitespace";
	if (ch === "_") return "word";
	if (WORD_NAV_RE_PUNCT.test(ch) || WORD_NAV_RE_SYMBOL.test(ch)) return "delimiter";
	if (
		WORD_NAV_RE_HAN.test(ch) ||
		WORD_NAV_RE_HIRAGANA.test(ch) ||
		WORD_NAV_RE_KATAKANA.test(ch) ||
		WORD_NAV_RE_HANGUL.test(ch)
	) {
		return "cjk";
	}
	if (WORD_NAV_RE_LETTER.test(ch) || WORD_NAV_RE_NUMBER.test(ch)) return "word";
	return "other";
}

const WORD_NAV_JOINERS = new Set(["'", "’", "-", "‐", "‑"]);

export function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === 0) return 0;

	const graphemes = [...segmenter.segment(text.slice(0, i))];
	if (graphemes.length === 0) return 0;

	while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === "whitespace") {
		i -= graphemes.pop()?.segment.length || 0;
	}
	if (i === 0 || graphemes.length === 0) return i;

	const kind = getWordNavKind(graphemes[graphemes.length - 1]?.segment || "");
	if (kind === "delimiter" || kind === "cjk") {
		while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === kind) {
			i -= graphemes.pop()?.segment.length || 0;
		}
		return i;
	}

	if (kind === "word") {
		let hasRightWord = false;
		while (graphemes.length > 0) {
			const g = graphemes[graphemes.length - 1]?.segment || "";
			const k = getWordNavKind(g);
			if (k === "word") {
				hasRightWord = true;
				i -= graphemes.pop()?.segment.length || 0;
				continue;
			}
			if (hasRightWord && k === "delimiter" && isWordNavJoiner(g)) {
				const left = graphemes[graphemes.length - 2]?.segment || "";
				if (getWordNavKind(left) === "word") {
					i -= graphemes.pop()?.segment.length || 0;
					continue;
				}
			}
			break;
		}
		return i;
	}

	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	while (!next.done && getWordNavKind(next.value.segment) === "whitespace") {
		i += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return i;

	const firstKind = getWordNavKind(next.value.segment);
	if (firstKind === "delimiter" || firstKind === "cjk") {
		while (!next.done && getWordNavKind(next.value.segment) === firstKind) {
			i += next.value.segment.length;
			next = iterator.next();
		}
		return i;
	}

	if (firstKind === "word") {
		let hasLeftWord = false;
		while (!next.done) {
			const segment = next.value.segment;
			const k = getWordNavKind(segment);
			if (k === "word") {
				hasLeftWord = true;
				i += segment.length;
				next = iterator.next();
				continue;
			}
			if (hasLeftWord && k === "delimiter" && isWordNavJoiner(segment)) {
				const lookahead = iterator.next();
				if (!lookahead.done && getWordNavKind(lookahead.value.segment) === "word") {
					i += segment.length;
					next = lookahead;
					continue;
				}
			}
			break;
		}
		return i;
	}

	return i + next.value.segment.length;
}

export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

let globalTight = false;

export function setTuiTight(tight: boolean): void {
	globalTight = tight;
}

export function isTuiTight(): boolean {
	return globalTight;
}

export function getPaddingX(basePadding: number): number {
	return globalTight ? Math.max(0, basePadding - 1) : basePadding;
}
