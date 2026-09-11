import { sanitizeText } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	Lexer,
	Marked,
	type Token,
	Tokenizer,
	type TokenizerAndRendererExtension,
	type Tokens,
} from "@oh-my-pi/pi-utils/marked";
import { latexToBlock } from "../latex-block";
import { inlineMathSpanEnd, isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import type {
	Component,
	NativeScrollbackCommittedRows,
	NativeScrollbackReplay,
	NativeScrollbackWidthEpoch,
} from "../tui";
import {
	applyBackgroundToLine,
	Ellipsis,
	encodeTextSized,
	getPaddingX,
	getSegmenter,
	getWidthConfigEpoch,
	isOsc66Line,
	padding,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

const OSC8_ST_PREFIX_REGEX = /(\x1b\]8;[^\x07\x1b]*)\x1b\\/g;

function normalizeOsc8Terminators(text: string): string {
	return text.replace(OSC8_ST_PREFIX_REGEX, "$1\x07");
}

function normalizeMarkdownSource(text: string): string {
	return normalizeOsc8Terminators(sanitizeText(text));
}

const MARKDOWN_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}[ \t]+\S/;
const FENCED_SOURCE_INTRO = /\b(?:code|example|markdown|output|snippet|source)\s*:?\s*$/i;
const PLAIN_STREAM_APPEND = /^[A-Za-z0-9 .,!?;:'"()-]+$/u;

function isGfmTableDelimiter(line: string, headerLine: string | undefined): boolean {
	if (!headerLine || !line.includes("|") || !headerLine.includes("|")) return false;
	const delimiterCells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	const headerCells = headerLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return (
		delimiterCells.length >= 2 &&
		headerCells.length === delimiterCells.length &&
		delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell.trim())) &&
		headerCells.every(cell => cell.trim().length > 0)
	);
}

interface FenceRepairResult {
	text: string;
	hasPendingFenceRepair: boolean;
}

function repairOrphanClosingFence(text: string): FenceRepairResult {
	const lines = text.split("\n");
	let open: { index: number; marker: string; info: string } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const match = MARKDOWN_FENCE_LINE.exec(lines[index]!);
		if (!match) continue;
		const marker = match[1]!;
		const info = match[2]!.trim();
		if (!open) {
			open = { index, marker, info };
			continue;
		}
		if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") {
			open = undefined;
		}
	}
	if (open === undefined) return { text, hasPendingFenceRepair: false };
	if (open.info !== "") return { text, hasPendingFenceRepair: false };

	let previous = "";
	for (let index = open.index - 1; index >= 0; index--) {
		previous = lines[index]!.trim();
		if (previous) break;
	}
	if (!previous || previous.endsWith(":") || FENCED_SOURCE_INTRO.test(previous)) {
		return { text, hasPendingFenceRepair: false };
	}

	let hasHeading = false;
	let hasTableDelimiter = false;
	for (let index = open.index + 1; index < lines.length; index++) {
		const line = lines[index]!;
		hasHeading ||= MARKDOWN_HEADING_LINE.test(line);
		hasTableDelimiter ||= isGfmTableDelimiter(line, lines[index - 1]);
		if (hasHeading && hasTableDelimiter) {
			lines.splice(open.index, 1);
			return { text: lines.join("\n"), hasPendingFenceRepair: true };
		}
	}
	return { text, hasPendingFenceRepair: true };
}

function hasFenceLine(text: string): boolean {
	for (const line of text.split("\n")) {
		if (MARKDOWN_FENCE_LINE.test(line)) return true;
	}
	return false;
}

function hasFenceLineAtAppendBoundary(source: string, suffix: string): boolean {
	const linePrefix = source.slice(source.lastIndexOf("\n") + 1);
	if (!/^ {0,3}[`~]{0,2}$/.test(linePrefix)) return false;
	return hasFenceLine(linePrefix + suffix);
}

function hasReferenceDefinitionAtAppendBoundary(source: string, suffix: string): boolean {
	const linePrefix = source.slice(source.lastIndexOf("\n") + 1);
	if (!linePrefix || !suffix) return false;
	const firstLineEnd = suffix.indexOf("\n");
	const firstSuffixLine = firstLineEnd < 0 ? suffix : suffix.slice(0, firstLineEnd);
	return HAS_REF_DEF.test(linePrefix + firstSuffixLine);
}

function normalizeHtmlEntitiesForTerminal(raw: string): string {
	if (!raw.includes("&")) return raw;
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}

interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}

interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}

function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;

const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;

function htmlTagName(tag: string): string {
	const match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
	return match ? match[1].toLowerCase() : "";
}

function htmlOlStart(tag: string): number {
	const match = /\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i.exec(tag);
	if (!match) return 1;
	return Number(match[1] ?? match[2] ?? match[3]);
}

function appendHtmlLineBreak(output: string, force: boolean = false): string {
	const trimmed = output.replace(/[ \t]+$/u, "");
	return !force && trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function htmlListIndent(state: HtmlNormalizationState): string {
	return "  ".repeat(Math.max(0, state.lists.length - 1));
}

function appendHtmlListBreak(output: string, state: HtmlNormalizationState): string {
	const indent = htmlListIndent(state);
	return output.endsWith(`${indent}\n`) ? output : appendHtmlLineBreak(output);
}

function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}

function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}

function normalizeHtmlForTerminal(
	raw: string,
	state: HtmlNormalizationState = createHtmlNormalizationState(),
	codeHook?: (text: string) => string,
): string {
	let output = "";
	let lastIndex = 0;
	let inCode = false;
	const withoutComments = raw.replace(HTML_COMMENT_REGEX, "");

	for (const match of withoutComments.matchAll(HTML_TAG_REGEX)) {
		const tag = match[0];
		const index = match.index ?? 0;
		const textBeforeTag = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex, index));
		const name = htmlTagName(tag);

		const isInlineTag = name === "span" || name === "text";
		if (isInlineTag || inCode || textBeforeTag.trim() !== "") {
			output += inCode && codeHook ? codeHook(textBeforeTag) : textBeforeTag;
			markCurrentHtmlItemContent(state, textBeforeTag);
		}
		lastIndex = index + tag.length;

		const isClosing = /^<\//.test(tag);
		const isSelfClosing = /\/\s*>$/.test(tag);

		switch (name) {
			case "span":
			case "text":
				break;
			case "code":
				if (isClosing) inCode = false;
				else if (!isSelfClosing) inCode = true;
				break;
			case "br":
			case "hr":
				output = appendHtmlLineBreak(output, true);
				break;
			case "p":
			case "blockquote":
				if (isClosing) {
					output = appendHtmlLineBreak(output);
				} else if (output.trim() !== "" && !output.endsWith("\n") && !isAtEmptyHtmlListItem(state)) {
					output = appendHtmlLineBreak(output);
				}
				break;
			case "ol":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ol", next: htmlOlStart(tag) });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "ul":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ul", next: 1 });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "li": {
				if (isClosing) {
					output = appendHtmlLineBreak(output);
					break;
				}
				if (state.openItems.length > 0) {
					const itemOpenIndex = state.openItems.length - 1;
					if (state.openItems[itemOpenIndex]) output = appendHtmlListBreak(output, state);
					state.openItems[itemOpenIndex] = true;
					state.itemHasContent[itemOpenIndex] = false;
				} else if (output.trim() !== "" && !output.endsWith("\n")) {
					output = appendHtmlLineBreak(output);
				}
				const list = state.lists[state.lists.length - 1];
				const indent = htmlListIndent(state);
				if (list?.type === "ol") {
					output += `${indent}${list.next}. `;
					list.next++;
				} else {
					output += `${indent}• `;
				}
				break;
			}
			default:
				output += tag;
				break;
		}
	}

	const remainingText = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex));
	markCurrentHtmlItemContent(state, remainingText);
	return output + (inCode && codeHook ? codeHook(remainingText) : remainingText);
}

function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

const TREE_GUIDE_CONTINUATION: Record<string, string> = {
	"│": "│",
	"┃": "┃",
	"║": "║",
	"├": "│",
	"┣": "┃",
	"╠": "║",
	"└": " ",
	"┗": " ",
	"╚": " ",
	"╰": " ",
	"─": " ",
	"━": " ",
	"═": " ",
	" ": " ",
};

const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;

const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;

const MIN_TREE_CONTENT_WIDTH = 8;

const SGR_SEQUENCE_STICKY = /\x1b\[[0-9;:]*m/y;
const SGR_SEQUENCE_GLOBAL = /\x1b\[[0-9;:]*m/g;

function compactSgrCarry(carry: string): string {
	const shortReset = carry.lastIndexOf("\x1b[m");
	const longReset = carry.lastIndexOf("\x1b[0m");
	const cut = Math.max(shortReset === -1 ? -1 : shortReset + 3, longReset === -1 ? -1 : longReset + 4);
	return cut === -1 ? carry : carry.slice(cut);
}

interface TreeGuidePrefix {
	end: number;

	codes: string;

	guides: string;
}

function matchTreeGuidePrefix(line: string): TreeGuidePrefix | undefined {
	let codes = "";
	let guides = "";
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			SGR_SEQUENCE_STICKY.lastIndex = i;
			const match = SGR_SEQUENCE_STICKY.exec(line);
			if (!match) break;
			codes += match[0];
			i = SGR_SEQUENCE_STICKY.lastIndex;
			continue;
		}
		const char = line[i]!;
		if (!(char in TREE_GUIDE_CONTINUATION)) break;
		guides += char;
		i++;
	}
	if (i >= line.length || !TREE_BRANCH_CONNECTOR_RE.test(guides)) return undefined;
	return { end: i, codes, guides };
}

function hangWrapTreeGuideLines(text: string, width: number): string[] | undefined {
	if (width < MIN_TREE_CONTENT_WIDTH || !TREE_GUIDE_ANCHOR_RE.test(text)) return undefined;

	const sourceLines = text.split("\n");
	const hangs = (line: string): TreeGuidePrefix | undefined => {
		if (visibleWidth(line) <= width) return undefined;
		const prefix = matchTreeGuidePrefix(line);
		if (!prefix) return undefined;
		if (width - visibleWidth(prefix.guides) < MIN_TREE_CONTENT_WIDTH) return undefined;
		return prefix;
	};
	if (!sourceLines.some(line => hangs(line) !== undefined)) return undefined;

	const out: string[] = [];
	let carry = "";
	for (const line of sourceLines) {
		const prefix = hangs(line);
		if (!prefix) {
			out.push(carry ? carry + line : line);
			carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
			continue;
		}

		const activeCodes = carry + prefix.codes;
		const rows = wrapTextWithAnsi(activeCodes + line.slice(prefix.end), width - visibleWidth(prefix.guides));
		let hang = "";
		for (const guide of prefix.guides) hang += TREE_GUIDE_CONTINUATION[guide] ?? " ";
		const hangShortfall = visibleWidth(prefix.guides) - visibleWidth(hang);
		if (hangShortfall > 0) hang += padding(hangShortfall);
		out.push(carry + line.slice(0, prefix.end) + rows[0]!.slice(activeCodes.length));
		for (let i = 1; i < rows.length; i++) {
			out.push(activeCodes + hang + rows[i]!);
		}
		carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
	}
	return out;
}

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

function getHrChar(char: string, hrChar: string): string {
	const isAscii = hrChar === "-";
	switch (char) {
		case "=":
			return "=";
		case "═":
			return isAscii ? "=" : "═";
		case "━":
			return isAscii ? "-" : "━";
		case "─":
			return isAscii ? "-" : "─";
		case "–":
			return isAscii ? "-" : "–";
		case "—":
			return isAscii ? "-" : "—";
		default:
			return hrChar;
	}
}

const customHrExtension: TokenizerAndRendererExtension = {
	name: "customHr",
	level: "block",
	start(src) {
		const match = CUSTOM_HR_START_REGEX.exec(src);
		if (!match) return undefined;
		let idx = match.index;
		if (src[idx] === "\n") {
			idx += 1;
		}
		return idx;
	},
	tokenizer(src) {
		const match = CUSTOM_HR_TOKENIZER_REGEX.exec(src);
		if (match) {
			return {
				type: "hr",
				raw: match[0],
			};
		}
		return undefined;
	},
	renderer() {
		return "";
	},
};

export function mathStartIndex(src: string): number | undefined {
	let best = src.indexOf("$");
	const paren = src.indexOf("\\(");
	if (paren !== -1 && (best === -1 || paren < best)) best = paren;
	const bracket = src.indexOf("\\[");
	if (bracket !== -1 && (best === -1 || bracket < best)) best = bracket;
	return best === -1 ? undefined : best;
}

const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start(src) {
		return mathStartIndex(src);
	},
	tokenizer(src) {
		if (src.startsWith("$$")) {
			const end = src.indexOf("$$", 2);
			if (end !== -1 && src.slice(2, end).trim().length > 0) {
				return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			}
			return undefined;
		}
		if (src.startsWith("\\[")) {
			const end = src.indexOf("\\]", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			return undefined;
		}
		if (src.startsWith("\\(")) {
			const end = src.indexOf("\\)", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: false };
			return undefined;
		}
		if (src.charCodeAt(0) === 0x24) {
			const end = inlineMathSpanEnd(src, 0);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 1), text: src.slice(1, end), display: false };
		}
		return undefined;
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/;
const MATH_BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/;
const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	start(src) {
		if (!src.includes("$$") && !src.includes("\\[")) return undefined;
		const m = MATH_BLOCK_START.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		const m = MATH_BLOCK_DOLLAR.exec(src) ?? MATH_BLOCK_BRACKET.exec(src);
		if (!m || m[1].trim().length === 0) return undefined;
		return { type: "math", raw: m[0], text: m[1], display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	if (!src.includes("\\begin{")) return null;
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1;
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;

	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src[blockEnd] === " " || src[blockEnd] === "\t") blockEnd++;
	if (src[blockEnd] === "\n") blockEnd++;

	let start = beginLineStart;
	if (start > 0 && src[start - 1] === "\n") {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(src) {
		const r = bareMathEnvBlock(src);
		return r ? r[0] : undefined;
	},
	tokenizer(src) {
		const r = bareMathEnvBlock(src);
		if (r?.[0] !== 0) return undefined;
		const raw = src.slice(0, r[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		if (text.trim().length === 0) return undefined;
		return { type: "math", raw, text, display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

const AUTOLINK_SCHEME_REGEX = /^(?:www\.|https?:\/\/|ftp:\/\/)/i;

function isAutolinkSchemeAt(src: string, i: number): boolean {
	const c = src.charCodeAt(i) | 32;
	if (c === 119) {
		return (
			(src.charCodeAt(i + 1) | 32) === 119 && (src.charCodeAt(i + 2) | 32) === 119 && src.charCodeAt(i + 3) === 46
		);
	}
	if (c === 104) {
		if (
			(src.charCodeAt(i + 1) | 32) !== 116 ||
			(src.charCodeAt(i + 2) | 32) !== 116 ||
			(src.charCodeAt(i + 3) | 32) !== 112
		) {
			return false;
		}
		let j = i + 4;
		if ((src.charCodeAt(j) | 32) === 115) j++;
		return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
	}
	if (c === 102) {
		return (
			(src.charCodeAt(i + 1) | 32) === 116 &&
			(src.charCodeAt(i + 2) | 32) === 112 &&
			src.charCodeAt(i + 3) === 58 &&
			src.charCodeAt(i + 4) === 47 &&
			src.charCodeAt(i + 5) === 47
		);
	}
	return false;
}

export function autolinkSchemeScanIndex(src: string): number | undefined {
	if (!src.includes("://") && !/[wW][wW][wW]\./.test(src)) return undefined;
	for (let i = 0; i < src.length; i++) {
		const c = src.charCodeAt(i) | 32;
		if ((c === 119 || c === 104 || c === 102) && isAutolinkSchemeAt(src, i)) return i;
	}
	return undefined;
}
const VALID_AUTOLINK_LEFT_BOUNDARY = /[\s*_~(]/;
const boundedAutolinkExtension: TokenizerAndRendererExtension = {
	name: "boundedAutolink",
	level: "inline",
	start(src) {
		return autolinkSchemeScanIndex(src);
	},
	tokenizer(src, tokens) {
		const match = AUTOLINK_SCHEME_REGEX.exec(src);
		if (!match) return undefined;
		const prevChar = tokens.at(-1)?.raw?.at(-1);

		if (prevChar === undefined || VALID_AUTOLINK_LEFT_BOUNDARY.test(prevChar)) return undefined;

		const raw = match[0];
		return { type: "text", raw, text: raw };
	},
};
markdownParser.use({
	extensions: [customHrExtension, mathBlockExtension, mathEnvBlockExtension, mathExtension, boundedAutolinkExtension],
});

const URL_GATE_EMAIL_SCAN_LIMIT = 320;

export function urlTokenPossible(src: string): boolean {
	if (isAutolinkSchemeAt(src, 0)) return true;
	let i = 0;
	while (i < URL_GATE_EMAIL_SCAN_LIMIT) {
		const c = src.charCodeAt(i);
		const isLocalChar =
			(c >= 97 && c <= 122) ||
			(c >= 65 && c <= 90) ||
			(c >= 48 && c <= 57) ||
			c === 46 ||
			c === 95 ||
			c === 43 ||
			c === 45;
		if (!isLocalChar) break;
		i++;
	}
	if (i === 0) return false;
	if (i >= URL_GATE_EMAIL_SCAN_LIMIT) return true;
	return src.charCodeAt(i) === 64;
}

function lheadingPossible(src: string): boolean {
	let i = src.indexOf("\n");
	while (i !== -1) {
		let j = i + 1;
		const limit = j + 3;
		while (j < limit && src.charCodeAt(j) === 0x20) j++;
		const c = src.charCodeAt(j);
		if (c === 0x3d || c === 0x2d) return true;
		i = src.indexOf("\n", j);
	}
	return false;
}

markdownParser.use({
	tokenizer: {
		url(src: string): Tokens.Link | undefined | false {
			return urlTokenPossible(src) ? false : undefined;
		},
		lheading(src: string): Tokens.Heading | undefined | false {
			return lheadingPossible(src) ? false : undefined;
		},
	},
});

class AnchoredAtZero extends RegExp {
	override exec(str: string): RegExpExecArray | null {
		this.lastIndex = 0;
		return super.exec(str);
	}
	override test(str: string): boolean {
		this.lastIndex = 0;
		return super.test(str);
	}
}

for (const table of [Lexer.rules.block.normal, Lexer.rules.block.gfm]) {
	for (const name of ["hr", "lheading", "table", "html"] as const) {
		const rule = table[name];
		if (rule.flags === "" && rule.source.startsWith("^")) {
			table[name] = new AnchoredAtZero(rule.source, "y");
		}
	}
}

const RENDER_CACHE_MAX = 256;
const RENDER_CACHE_MAX_SIZE = 4 * 1024 * 1024;
const RENDER_CACHE_MAX_ENTRY_SIZE = 256 * 1024;
const INCREMENTAL_FRAGMENT_CACHE_MAX_SIZE = RENDER_CACHE_MAX_SIZE;
const EMPTY_RENDER_LINES: readonly string[] = [];

interface RenderedLine {
	text: string;
	literalCode?: true;
}

interface RenderedListItemLine extends RenderedLine {
	nested: boolean;
}

interface MutableListParagraphCapture {
	raw: string;
	text: string;
	lineStart: number;
	lineCount: number;
}

function renderedLine(text: string, literalCode?: boolean): RenderedLine {
	return literalCode ? { text, literalCode: true } : { text };
}

interface RenderCacheEntry {
	lines: readonly string[];
	tables: readonly RenderedTableLayout[];
}

// Append renders keep the wrapped rows for each source-offset token. The raw/type checks
// make a fragment reusable only while the lexer still describes the same leaf block.
interface IncrementalTokenFragment {
	kind: "token";
	revision: number;
	transient: boolean;
	frozen: boolean;
	type: string;
	nextTokenType: string | undefined;
	raw: string;
	wrappedLines: readonly RenderedLine[];
	tables: readonly TableRenderSpec[];
	contentLines?: readonly string[];
	hasSpecialLine: boolean;
	startsWithEmptyLine: boolean;
	// Plain paragraphs can be extended without rebuilding their settled wrapped rows.
	plainText?: string;
	plainContentLineCount?: number;
	listItemCount?: number;
	listLastItemRaw?: string;
	listLastItemLineCount?: number;
	listLastParagraphRaw?: string;
	listLastParagraphText?: string;
	listLastParagraphLineStart?: number;
	listLastParagraphLineCount?: number;
}

type IncrementalRenderFragment = IncrementalTokenFragment;

const renderCache = new LRUCache<string, RenderCacheEntry>({
	max: RENDER_CACHE_MAX,
	maxSize: RENDER_CACHE_MAX_SIZE,
	maxEntrySize: RENDER_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: renderCacheEntrySize,
});

function renderedLinesCacheSize(lines: readonly string[]): number {
	let size = lines.length;
	for (let i = 0; i < lines.length; i++) size += lines[i]!.length;
	return Math.max(1, size);
}

function renderCacheEntrySize(entry: RenderCacheEntry): number {
	let size = renderedLinesCacheSize(entry.lines);
	for (const table of entry.tables) size += table.key.length + table.columnWidths.length + 4;
	return size;
}

const HAS_REF_DEF = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/m;

const LIST_MARKER_RE = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))/;

function listMayContinueAt(text: string, tailStart: number, listRaw: string): boolean {
	const marker = LIST_MARKER_RE.exec(listRaw);
	if (marker === null) return true;
	const n = text.length;
	let i = tailStart;

	while (i < n && i - tailStart < 3 && text.charCodeAt(i) === 0x20) i++;
	if (i >= n) return true;
	const bullet = marker[1];
	if (bullet !== undefined) {
		if (text[i] !== bullet) return false;
		i++;
	} else {
		let digits = 0;
		while (i < n && digits < 10) {
			const c = text.charCodeAt(i);
			if (c < 0x30 || c > 0x39) break;
			digits++;
			i++;
		}
		if (digits === 0 || digits > 9) return false;
		if (i >= n) return true;
		if (text[i] !== marker[2]) return false;
		i++;
	}

	if (i >= n) return true;
	const after = text.charCodeAt(i);
	return after === 0x20 || after === 0x09 || after === 0x0a;
}

const NO_BLOCK_BOUNDARY = { end: 0, count: 0 } as const;

function stableBlockBoundary(text: string, base: number, tokens: Token[]): { end: number; count: number } {
	let pos = base;
	let end = 0;
	let count = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i].raw;
		const tokenEnd = pos + raw.length;
		if (raw.endsWith("\n\n")) {
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (prev === undefined || prev.type !== "list" || !listMayContinueAt(text, tokenEnd, prev.raw)) {
				end = tokenEnd;
				count = i + 1;
			}
		}
		pos = tokenEnd;
	}
	if (count === 0 || end >= text.length) return NO_BLOCK_BOUNDARY;
	const next = text.charCodeAt(end);
	if (next === 0x20 || next === 0x0a) return NO_BLOCK_BOUNDARY;
	return { end, count };
}

const LEX_WINDOW_BYTES = 2 * 1024;

const WINDOWED_LEX_MIN_BYTES = 16 * 1024;

function lexWindowed(text: string): Token[] {
	const lexer = new Lexer(markdownParser.defaults);
	let offset = 0;
	while (offset < text.length) {
		let segment = "";
		const nextBlank = text.indexOf("\n\n", offset);
		if (nextBlank === -1) {
			segment = text.slice(offset);
		} else {
			const minSize = Math.max(LEX_WINDOW_BYTES, nextBlank + 2 - offset);
			for (let size = minSize; segment.length === 0; size *= 2) {
				if (offset + size >= text.length) {
					segment = text.slice(offset);
					break;
				}
				const probe = new Lexer(markdownParser.defaults);
				probe.blockTokens(text.slice(offset, offset + size), probe.tokens);
				const boundary = stableBlockBoundary(text, offset, probe.tokens);
				if (boundary.count > 0) segment = text.slice(offset, boundary.end);
			}
		}
		lexer.blockTokens(segment, lexer.tokens);
		offset += segment.length;
	}
	for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
	lexer.inlineQueue = [];
	return lexer.tokens;
}

function lexDocument(text: string, allowWindowed: boolean): Token[] {
	if (!allowWindowed || text.length < WINDOWED_LEX_MIN_BYTES || text.includes("\r")) return markdownParser.lexer(text);
	return lexWindowed(text);
}

export function clearRenderCache(): void {
	renderCache.clear();
}

const themeObjectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: object): number {
	let id = themeObjectIds.get(o);
	if (id === undefined) {
		id = nextObjectId++;
		themeObjectIds.set(o, id);
	}
	return id;
}

export interface DefaultTextStyle {
	color?: (text: string) => string;

	bgColor?: (text: string) => string;

	bold?: boolean;

	italic?: boolean;

	strikethrough?: boolean;

	underline?: boolean;
}

export interface HighlightStreamSession {
	push(chunk: string): string;
}

export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	codeBlockFence?: (lang: string | undefined, pos: "open" | "close") => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];

	createHighlightStream?: (lang?: string) => HighlightStreamSession | null;

	resolveMermaidAscii?: (source: string, maxWidth?: number) => string | null;
	symbols: SymbolTheme;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

interface RenderableListItem {
	raw?: string;
	tokens?: Token[];
}

type ListToken = Token & { items: RenderableListItem[]; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableToken = Token & { header: TableCellToken[]; rows: TableCellToken[][]; raw?: string };

function formatHyperlink(text: string, target: string): string {
	if (!TERMINAL.hyperlinks || !target) {
		return text;
	}

	const safeTarget = target.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safeTarget) {
		return text;
	}

	return `\x1b]8;;${safeTarget}\x07${text}\x1b]8;;\x07`;
}

function isAsciiTextSizingPayload(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
	let out = "";
	let asciiRun = "";
	const flushAscii = () => {
		if (asciiRun === "") return;
		out += encodeTextSized(asciiRun, { scale });
		asciiRun = "";
	};

	for (const { segment } of getSegmenter().segment(text)) {
		if (isAsciiTextSizingPayload(segment)) {
			asciiRun += segment;
			continue;
		}
		flushAscii();
		out += encodeTextSized(segment, { scale, widthCells: visibleWidth(segment) });
	}
	flushAscii();
	return out;
}

const MATH_NEWLINES = /\n+/g;

function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}

function soleDisplayMath(tokens?: Token[]): (Token & { text: string }) | null {
	if (!tokens) return null;
	let math: (Token & { text: string; display: boolean }) | null = null;
	for (const token of tokens) {
		if (isMathToken(token) && token.display) {
			if (math) return null;
			math = token;
		} else if (!(token.type === "text" && typeof token.text === "string" && token.text.trim() === "")) {
			return null;
		}
	}
	return math;
}

function plainInlineTokens(tokens: Token[]): string {
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += renderMathToken(token.text);
			continue;
		}
		switch (token.type) {
			case "text":
				result += token.tokens && token.tokens.length > 0 ? plainInlineTokens(token.tokens) : token.text;
				break;
			case "strong":
			case "em":
			case "del":
			case "link":
				result += plainInlineTokens(token.tokens || []);
				break;
			case "codespan":
				result += token.text;
				break;
			default:
				if ("text" in token && typeof token.text === "string") result += token.text;
				break;
		}
	}
	return result;
}

function inlineHtmlTag(token: Token): { name: string; closing: boolean } | null {
	if ((token as { type: string }).type !== "html") return null;
	const raw = (token as { raw?: unknown }).raw;
	if (typeof raw !== "string") return null;
	const name = htmlTagName(raw);
	if (!name) return null;
	return { name, closing: /^<\s*\//.test(raw) };
}

function collapseInlineHtml(tokens: Token[]): Token[] {
	let hasCode = false;
	for (const token of tokens) {
		if (inlineHtmlTag(token)?.name === "code") {
			hasCode = true;
			break;
		}
	}
	if (!hasCode) return tokens;

	const out: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tag = inlineHtmlTag(tokens[i]);
		if (tag?.name === "code") {
			if (tag.closing) continue;
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const close = inlineHtmlTag(tokens[j]);
				if (close?.name === "code" && close.closing) break;
			}
			if (j >= tokens.length) continue;
			const text = normalizeHtmlEntitiesForTerminal(plainInlineTokens(tokens.slice(i + 1, j)));
			out.push({ type: "codespan", raw: text, text } as Token);
			i = j;
			continue;
		}
		out.push(tokens[i]);
	}
	return out;
}

const DEFAULT_COLOR_SWATCH_GLYPH = "■";

const HEX_COLOR_REGEX =
	/(?<![\w#&])#(?![0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;
const HEX_COLOR_EXACT_REGEX = /^#([0-9a-fA-F]{3,8})$/;

function classifyHexColor(hex: string, strict: boolean): boolean {
	const n = hex.length;
	if (n !== 3 && n !== 6 && n !== 8) return false;
	if (strict && n === 3 && !/[a-fA-F]/.test(hex)) return false;
	return true;
}

function colorSwatch(hex: string, glyph: string): string {
	const ansi = Bun.color(`#${hex}`, TERMINAL.trueColor ? "ansi-16m" : "ansi-256");

	return ansi ? `${ansi}${glyph}\x1b[39m ` : "";
}

function renderTextWithSwatches(text: string, applySegment: (t: string) => string, glyph: string): string {
	if (!text.includes("#")) return applySegment(text);
	HEX_COLOR_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	for (;;) {
		const match = HEX_COLOR_REGEX.exec(text);
		if (match === null) break;
		if (!classifyHexColor(match[1], true)) continue;
		const swatch = colorSwatch(match[1], glyph);
		if (!swatch) continue;
		if (match.index > last) result += applySegment(text.slice(last, match.index));
		result += swatch + applySegment(match[0]);
		last = match.index + match[0].length;
	}
	if (last === 0) return applySegment(text);
	if (last < text.length) result += applySegment(text.slice(last));
	return result;
}

function codespanSwatch(code: string, glyph: string): string {
	const match = HEX_COLOR_EXACT_REGEX.exec(code.trim());
	if (!match || !classifyHexColor(match[1], false)) return "";
	return colorSwatch(match[1], glyph);
}

interface RenderSignature {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	themeId: number;
	defaultTextStyleId: number;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
	bgColorProbe: string;
	headingProbe: string;
	themeRevision: string;
}

interface StreamPrefixLineCache extends RenderSignature {
	text: string;
	tokenCount: number;
	lines: string[];
	tables: readonly TableRenderSpec[];
}
interface StreamingHighlightCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	lines: readonly string[];
	stream: HighlightStreamSession;
}

interface NormalizedTextCache {
	source: string;
	text: string;
	repairFences: boolean;
	hasPendingFenceRepair: boolean;
	hasReferenceDefinition: boolean;
}

function splitPushedHighlightLines(pushed: string): string[] {
	const lines = pushed.split("\n");
	lines.pop();
	return lines;
}

interface TableLayoutLock {
	availableWidth: number;
	columnWidths: readonly number[];
}

interface TableRenderSpec extends TableLayoutLock {
	key: string;
	lineCount: number;
	startRow: number;
	endRow: number;
}

interface RenderedTableLayout extends TableLayoutLock {
	key: string;
	startRow: number;
	endRow: number;
}

export class Markdown
	implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay, NativeScrollbackWidthEpoch
{
	#text: string;
	#paddingX: number;
	#paddingY: number;
	#defaultTextStyle?: DefaultTextStyle;
	#theme: MarkdownTheme;
	#defaultStylePrefix?: string;
	#cacheRenderedOutput: boolean;

	#codeBlockIndent: number;

	#cachedText?: string;
	#cachedWidth?: number;
	#cachedWidthConfigEpoch?: number;
	#cachedLines?: readonly string[];
	#transientRenderCache = false;
	#normalizedTextCache?: NormalizedTextCache;
	#appendOnlySinceRender = false;

	#streamPrefixText?: string;
	#streamTokens?: Token[];
	#streamPrefixTokenCount = 0;
	#streamPrefixLineCache?: StreamPrefixLineCache;
	#streamLexedText?: string;

	#lastRenderSettledRows = 0;

	#settledExposedText?: string;

	#lastRenderedText?: string;
	#lastRenderedTransientRenderCache = false;
	#lastRenderedHasMutableTrailingRow = false;
	#widthEpochBoundaries = new WeakMap<
		object,
		{ text: string; transientRenderCache: boolean; hasMutableTrailingRow: boolean }
	>();

	#renderingFrozenPrefix = false;
	#streamingHighlightCache?: StreamingHighlightCache;
	#activeRenderSignature?: RenderSignature;
	#activeRenderFragmentRevision?: number;
	#renderFragmentCacheSignature?: string;
	#renderFragmentCacheRevision = 0;
	// This is intentionally per Markdown instance: settled-prefix rows remain owned by
	// #streamPrefixLineCache, while this cache covers the mutable suffix only.
	#incrementalTokenFragments = new Map<number, IncrementalRenderFragment>();
	#incrementalTokenFragmentsSize = 0;
	#renderWrappedLinesScratch: RenderedLine[] = [];
	#renderContentLinesScratch: string[] = [];
	#renderTokenSegmentsScratch: Array<{
		start: number;
		end: number;
		fragment?: IncrementalTokenFragment;
		sourceOffset: number;
		storeFragment: boolean;
	}> = [];
	#lastRenderedListLastItemLineCount = 0;
	#lastRenderedListMutableParagraphLineStart = -1;
	#lastRenderedListMutableParagraphLineCount = 0;

	#tableLayoutWidth?: number;
	#lockedTableLayouts = new Map<string, TableLayoutLock>();
	#lastRenderedTableLayouts: RenderedTableLayout[] = [];
	#activeTableRenderSpecs?: TableRenderSpec[];

	#ignoreTight = false;

	#widthEpochRevision = 0;

	setIgnoreTight(ignore: boolean): this {
		if (this.#ignoreTight !== ignore) {
			this.#clearTableLayouts();
			this.#widthEpochRevision++;
		}
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	compact(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedWidthConfigEpoch = undefined;
		this.#cachedLines = undefined;
		this.#normalizedTextCache = undefined;
		this.#appendOnlySinceRender = false;
		this.#streamPrefixText = undefined;
		this.#streamTokens = undefined;
		this.#streamPrefixTokenCount = 0;
		this.#streamPrefixLineCache = undefined;
		this.#streamLexedText = undefined;
		this.#settledExposedText = undefined;
		this.#streamingHighlightCache = undefined;
		this.#renderFragmentCacheSignature = undefined;
		this.#activeRenderFragmentRevision = undefined;
		this.#clearIncrementalTokenFragments();
		this.#renderWrappedLinesScratch.length = 0;
		this.#renderContentLinesScratch.length = 0;
		this.#renderTokenSegmentsScratch.length = 0;
	}

	getText(): string {
		return this.#text;
	}

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		codeBlockIndent: number = 2,
		cacheRenderedOutput = true,
	) {
		this.#text = normalizeMarkdownSource(text);
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#defaultTextStyle = defaultTextStyle;
		this.#cacheRenderedOutput = cacheRenderedOutput;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
	}

	setText(text: string): boolean {
		text = normalizeMarkdownSource(text);

		if (text === this.#text) return false;
		const appended = text.startsWith(this.#text);
		if (!appended) {
			this.#clearIncrementalTokenFragments();
			this.#clearTableLayouts();
			this.#normalizedTextCache = undefined;
		}
		this.#appendOnlySinceRender = appended;
		this.#text = text;
		if (!text.trim()) {
			this.#streamPrefixText = undefined;
			this.#streamTokens = undefined;
			this.#streamPrefixTokenCount = 0;
			this.#streamPrefixLineCache = undefined;
			this.#streamLexedText = undefined;
			this.#settledExposedText = undefined;
		}
		this.#widthEpochRevision++;
		this.invalidate();
		return true;
	}

	getNativeScrollbackWidthEpochRevision(): number {
		return this.#widthEpochRevision;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedWidthConfigEpoch = undefined;
		this.#cachedLines = undefined;
	}
	get transientRenderCache(): boolean {
		return this.#transientRenderCache;
	}

	set transientRenderCache(value: boolean) {
		const next = value === true;
		if (this.#transientRenderCache === next) return;
		this.#transientRenderCache = next;
		this.#widthEpochRevision++;
		this.invalidate();
	}

	getLastRenderSettledRows(): number {
		return this.#lastRenderSettledRows;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		if (this.#lastRenderedText === undefined) return undefined;
		const marker = {};
		this.#widthEpochBoundaries.set(marker, {
			text: this.#lastRenderedText,
			transientRenderCache: this.#lastRenderedTransientRenderCache,
			hasMutableTrailingRow: this.#lastRenderedHasMutableTrailingRow,
		});
		return marker;
	}

	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null || this.#cachedWidth === undefined) return undefined;
		const captured = this.#widthEpochBoundaries.get(boundary);
		if (captured === undefined) return undefined;
		const snapshot = new Markdown(
			captured.text,
			this.#paddingX,
			this.#paddingY,
			this.#theme,
			this.#defaultTextStyle,
			this.#codeBlockIndent,
			this.#cacheRenderedOutput,
		);
		snapshot.#ignoreTight = this.#ignoreTight;
		snapshot.#transientRenderCache = captured.transientRenderCache;
		return Math.max(
			0,
			snapshot.render(this.#cachedWidth).length - this.#paddingY - (captured.hasMutableTrailingRow ? 1 : 0),
		);
	}

	getNativeScrollbackWidthEpochRows(): number | undefined {
		return this.#cachedLines === undefined ? undefined : this.#widthEpochRows(this.#cachedLines.length);
	}

	isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		return this.#widthEpochBoundaries.get(boundary)?.hasMutableTrailingRow !== true;
	}

	#widthEpochRows(renderedRows: number): number {
		return Math.max(0, renderedRows - this.#paddingY - (this.#transientRenderCache ? 1 : 0));
	}

	#recordLastRenderedState(hasContentRows: boolean): void {
		this.#lastRenderedText = this.#text;
		this.#lastRenderedTransientRenderCache = this.#transientRenderCache;
		this.#lastRenderedHasMutableTrailingRow = this.#transientRenderCache && hasContentRows;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		const committed = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		let changed = false;
		for (const table of this.#lastRenderedTableLayouts) {
			if (table.startRow >= committed || this.#lockedTableLayouts.has(table.key)) continue;
			this.#lockedTableLayouts.set(table.key, {
				availableWidth: table.availableWidth,
				columnWidths: table.columnWidths.slice(),
			});
			changed = true;
		}
		if (changed) {
			this.#clearIncrementalTokenFragments();
			this.invalidate();
		}
	}

	prepareNativeScrollbackReplay(): void {
		this.#clearTableLayouts();
		this.#tableLayoutWidth = undefined;
		this.invalidate();
	}

	#clearTableLayouts(): void {
		this.#lockedTableLayouts.clear();
		this.#lastRenderedTableLayouts = [];
		this.#activeTableRenderSpecs = undefined;
		this.#clearIncrementalTokenFragments();

		this.#streamPrefixLineCache = undefined;
	}

	#invalidateStreamingState(): void {
		this.#streamPrefixText = undefined;
		this.#streamTokens = undefined;
		this.#streamPrefixTokenCount = 0;
		this.#streamPrefixLineCache = undefined;
		this.#streamLexedText = undefined;
		this.#clearIncrementalTokenFragments();
	}

	#normalizedTextForRender(): string {
		const repairFences = !this.transientRenderCache;
		const cache = this.#normalizedTextCache;
		if (cache?.source === this.#text && cache.repairFences === repairFences) {
			if (cache.hasPendingFenceRepair) this.#invalidateStreamingState();
			return cache.text;
		}

		if (cache?.repairFences === repairFences && this.#text.startsWith(cache.source)) {
			if (cache.hasPendingFenceRepair) this.#invalidateStreamingState();
			// A balanced prefix cannot be changed by ordinary appended text. Re-run the
			// repair only when the suffix can introduce or complete a fence line.
			const suffix = this.#text.slice(cache.source.length);
			const normalizedSuffix = replaceTabs(suffix);
			if (
				!repairFences ||
				(!cache.hasPendingFenceRepair &&
					!hasFenceLine(normalizedSuffix) &&
					!hasFenceLineAtAppendBoundary(cache.source, normalizedSuffix))
			) {
				const normalizedText = cache.text + normalizedSuffix;
				this.#normalizedTextCache = {
					source: this.#text,
					text: normalizedText,
					repairFences,
					hasPendingFenceRepair: false,
					hasReferenceDefinition:
						cache.hasReferenceDefinition ||
						HAS_REF_DEF.test(normalizedSuffix) ||
						hasReferenceDefinitionAtAppendBoundary(cache.source, normalizedSuffix),
				};
				return normalizedText;
			}
		}

		const replaced = replaceTabs(this.#text);
		if (!repairFences) {
			this.#normalizedTextCache = {
				source: this.#text,
				text: replaced,
				repairFences: false,
				hasPendingFenceRepair: false,
				hasReferenceDefinition: HAS_REF_DEF.test(replaced),
			};
			return replaced;
		}

		const repaired = repairOrphanClosingFence(replaced);
		this.#normalizedTextCache = {
			source: this.#text,
			text: repaired.text,
			repairFences: true,
			hasPendingFenceRepair: repaired.hasPendingFenceRepair,
			hasReferenceDefinition: HAS_REF_DEF.test(repaired.text),
		};
		return repaired.text;
	}

	#tryAppendPlainListToken(text: string, refDefText: string, streamTokens: Token[] | undefined): boolean {
		const prefix = this.#streamPrefixText;
		const previousText = this.#streamLexedText;
		if (
			prefix === undefined ||
			previousText === undefined ||
			streamTokens === undefined ||
			!previousText.startsWith(prefix) ||
			!text.startsWith(previousText)
		) {
			return false;
		}
		const previousMutableText = previousText.slice(prefix.length);
		if (!refDefText.startsWith(previousMutableText)) return false;
		const appendedText = text.slice(previousText.length);
		if (!appendedText || !PLAIN_STREAM_APPEND.test(appendedText)) return false;

		const list = streamTokens.at(-1);
		if (list?.type !== "list" || !list.items || list.items.length === 0) return false;
		const lastItem = list.items.at(-1);
		const finalToken = lastItem?.tokens?.at(-1);
		if (
			lastItem?.raw === undefined ||
			finalToken?.type !== "paragraph" ||
			!("raw" in finalToken) ||
			typeof finalToken.raw !== "string"
		) {
			return false;
		}
		const inlineTokens = finalToken.tokens;
		const inlineToken = inlineTokens?.[0];
		if (
			inlineTokens === undefined ||
			inlineTokens.length !== 1 ||
			inlineToken?.type !== "text" ||
			!("raw" in inlineToken) ||
			typeof inlineToken.raw !== "string" ||
			typeof inlineToken.text !== "string"
		) {
			return false;
		}
		if (this.#plainParagraphText(finalToken) !== finalToken.text) return false;
		if (typeof list.raw !== "string") return false;

		list.raw += appendedText;
		lastItem.raw += appendedText;
		finalToken.raw += appendedText;
		finalToken.text += appendedText;
		inlineToken.raw += appendedText;
		inlineToken.text += appendedText;
		this.#streamLexedText = text;
		return true;
	}

	#lexTokens(text: string): Token[] {
		const prefix = this.#streamPrefixText;
		const streamTokens = this.#streamTokens;
		const hasPrefix =
			this.#appendOnlySinceRender &&
			prefix !== undefined &&
			streamTokens !== undefined &&
			text.length > prefix.length &&
			text.startsWith(prefix);
		const refDefText = hasPrefix ? text.slice(prefix.length) : text;
		const hasReferenceDefinition =
			this.#normalizedTextCache?.source === text
				? this.#normalizedTextCache.hasReferenceDefinition
				: HAS_REF_DEF.test(refDefText);
		const canStream = !hasReferenceDefinition && !refDefText.includes("\r");
		if (canStream && hasPrefix) {
			if (this.#tryAppendPlainListToken(text, refDefText, streamTokens)) return streamTokens;
			const tailTokens = lexDocument(refDefText, true);
			const frozen = stableBlockBoundary(text, prefix.length, tailTokens);
			// Keep frozen token indexes stable; only the mutable tail needs replacing or scanning.
			streamTokens.length = this.#streamPrefixTokenCount;
			for (const token of tailTokens) streamTokens.push(token);
			if (frozen.count > 0) {
				this.#streamPrefixText = text.slice(0, frozen.end);
				this.#streamPrefixTokenCount += frozen.count;
			}
			this.#streamLexedText = text;
			return streamTokens;
		}
		const tokens = lexDocument(text, this.transientRenderCache || hasPrefix);
		const frozen = canStream ? stableBlockBoundary(text, 0, tokens) : NO_BLOCK_BOUNDARY;
		if (frozen.count > 0) {
			this.#streamPrefixText = text.slice(0, frozen.end);
			this.#streamTokens = tokens;
			this.#streamPrefixTokenCount = frozen.count;
			this.#streamLexedText = text;
		} else {
			this.#streamPrefixText = undefined;
			this.#streamTokens = undefined;
			this.#streamPrefixTokenCount = 0;
			this.#streamPrefixLineCache = undefined;
			this.#streamLexedText = undefined;
		}
		return tokens;
	}

	render(width: number): readonly string[] {
		if (this.#tableLayoutWidth !== undefined && this.#tableLayoutWidth !== width) {
			this.#clearTableLayouts();
			this.#normalizedTextCache = undefined;
			this.invalidate();
		}
		this.#tableLayoutWidth = width;

		if (
			this.#cachedLines &&
			this.#cachedText === this.#text &&
			this.#cachedWidth === width &&
			this.#cachedWidthConfigEpoch === getWidthConfigEpoch()
		) {
			this.#appendOnlySinceRender = false;
			this.#recordLastRenderedState(this.#cachedLines.length > 0);
			return this.#cachedLines;
		}

		this.#lastRenderSettledRows = 0;

		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);

		if (!this.#text || this.#text.trim() === "") {
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedWidthConfigEpoch = getWidthConfigEpoch();
			this.#cachedLines = EMPTY_RENDER_LINES;
			this.#appendOnlySinceRender = false;
			this.#recordLastRenderedState(false);
			return EMPTY_RENDER_LINES;
		}

		const normalizedText = this.#normalizedTextForRender();
		const signature = this.#renderSignature(width, paddingX);

		let cacheKey: string | undefined;
		if (
			this.#cacheRenderedOutput &&
			!this.transientRenderCache &&
			!this.#appendOnlySinceRender &&
			this.#lockedTableLayouts.size === 0
		) {
			cacheKey = this.#renderCacheKey(normalizedText, signature);
			const cached = renderCache.get(cacheKey);
			if (cached !== undefined) {
				this.#lastRenderedTableLayouts = cached.tables.map(table => ({
					...table,
					columnWidths: table.columnWidths.slice(),
				}));

				this.#cachedText = this.#text;
				this.#cachedWidth = width;
				this.#cachedWidthConfigEpoch = getWidthConfigEpoch();
				this.#cachedLines = cached.lines;
				this.#appendOnlySinceRender = false;
				this.#recordLastRenderedState(cached.lines.length > 0);
				return cached.lines;
			}
		}

		const tokens = this.#lexTokens(normalizedText);
		let contentLines: string[];
		const tableRenderSpecs: TableRenderSpec[] = [];
		this.#activeTableRenderSpecs = tableRenderSpecs;
		this.#activeRenderSignature = signature;
		if (this.#appendOnlySinceRender) {
			const fragmentSignature = this.#renderFragmentPrefix(signature);
			if (this.#renderFragmentCacheSignature !== fragmentSignature) {
				this.#clearIncrementalTokenFragments();
				this.#renderFragmentCacheSignature = fragmentSignature;
				this.#renderFragmentCacheRevision++;
			}
			this.#activeRenderFragmentRevision = this.#renderFragmentCacheRevision;
		}
		try {
			contentLines =
				this.transientRenderCache || this.#appendOnlySinceRender
					? this.#renderStreamingContentLines(tokens, normalizedText, signature, contentWidth)
					: this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature, 0, 0);
		} finally {
			this.#activeRenderSignature = undefined;
			this.#activeRenderFragmentRevision = undefined;
			this.#activeTableRenderSpecs = undefined;
		}
		this.#lastRenderedTableLayouts = this.#resolveRenderedTableLayouts(tableRenderSpecs, signature.paddingY);
		const emptyLines = this.#renderEmptyPaddingLines(signature);

		const rawResult = [...emptyLines, ...contentLines, ...emptyLines];
		const result = rawResult.length > 0 ? rawResult : [""];

		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedWidthConfigEpoch = getWidthConfigEpoch();
		this.#cachedLines = result;

		if (cacheKey !== undefined && this.#cacheRenderedOutput) {
			renderCache.set(cacheKey, {
				lines: result,
				tables: this.#lastRenderedTableLayouts.map(table => ({
					...table,
					columnWidths: table.columnWidths.slice(),
				})),
			});
		}
		this.#appendOnlySinceRender = false;
		this.#recordLastRenderedState(contentLines.length > 0);

		return result;
	}

	#renderSignature(width: number, paddingX: number): RenderSignature {
		const bgColorProbe = this.#defaultTextStyle?.bgColor ? this.#defaultTextStyle.bgColor("\x01") : "";
		const headingProbe = this.#theme.heading("");
		const themeRevision = this.#themeRevision();
		return {
			width,
			paddingX,
			paddingY: this.#paddingY,
			codeBlockIndent: this.#codeBlockIndent,
			themeId: objectId(this.#theme),
			defaultTextStyleId: this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1,
			imageProtocol: TERMINAL.imageProtocol ?? "",
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
			bgColorProbe,
			headingProbe,
			themeRevision,
		};
	}

	#themeRevision(): string {
		const themeCallbacks = [
			this.#theme.heading,
			this.#theme.link,
			this.#theme.linkUrl,
			this.#theme.code,
			this.#theme.codeBlock,
			this.#theme.codeBlockBorder,
			this.#theme.codeBlockFence,
			this.#theme.quote,
			this.#theme.quoteBorder,
			this.#theme.hr,
			this.#theme.listBullet,
			this.#theme.bold,
			this.#theme.italic,
			this.#theme.strikethrough,
			this.#theme.underline,
			this.#theme.highlightCode,
			this.#theme.createHighlightStream,
			this.#theme.resolveMermaidAscii,
		];
		const callbackIds = themeCallbacks
			.map(callback => (typeof callback === "function" ? objectId(callback) : -1))
			.join(",");
		const defaultStyle = this.#defaultTextStyle;
		const defaultCallbacks = [defaultStyle?.color, defaultStyle?.bgColor];
		const defaultCallbackIds = defaultCallbacks
			.map(callback => (typeof callback === "function" ? objectId(callback) : -1))
			.join(",");
		return [
			callbackIds,
			JSON.stringify(this.#theme.symbols),
			defaultCallbackIds,
			defaultStyle?.bold ? 1 : 0,
			defaultStyle?.italic ? 1 : 0,
			defaultStyle?.strikethrough ? 1 : 0,
			defaultStyle?.underline ? 1 : 0,
		].join("|");
	}

	#renderCacheKey(normalizedText: string, signature: RenderSignature): string {
		return `${normalizedText}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}\x00${signature.bgColorProbe}\x00${signature.headingProbe}\x00${signature.themeRevision}\x00${getWidthConfigEpoch()}`;
	}

	#renderFragmentPrefix(signature: RenderSignature): string {
		return [
			signature.width,
			signature.paddingX,
			signature.paddingY,
			signature.codeBlockIndent,
			signature.themeId,
			signature.defaultTextStyleId,
			signature.imageProtocol,
			signature.hyperlinks ? 1 : 0,
			signature.textSizing ? 1 : 0,
			signature.bgColorProbe,
			signature.headingProbe,
			signature.themeRevision,
			getWidthConfigEpoch(),
		]
			.map(value => {
				const text = String(value);
				return `${text.length}:${text}`;
			})
			.join("|");
	}

	#plainParagraphText(token: Token): string | undefined {
		if (token.type !== "paragraph" || this.#defaultTextStyle !== undefined) return undefined;
		const inlineTokens = token.tokens;
		if (inlineTokens === undefined || inlineTokens.length !== 1) return undefined;
		const inlineToken = inlineTokens[0];
		if (inlineToken?.type !== "text" || typeof inlineToken.text !== "string") return undefined;
		const text = inlineToken.text;
		// Entity and swatch parsing can change already-rendered text when an append
		// completes a marker that crossed the previous render boundary.
		if (text.includes("&") || text.includes("#") || text.includes("\x1b") || TREE_GUIDE_ANCHOR_RE.test(text)) {
			return undefined;
		}
		return text;
	}

	#cachedTokenFragment(
		token: Token,
		nextTokenType: string | undefined,
		sourceOffset: number,
	): IncrementalTokenFragment | undefined {
		const revision = this.#activeRenderFragmentRevision;
		if (revision === undefined || this.#normalizedTextCache?.hasReferenceDefinition === true) return undefined;
		if (!("raw" in token) || typeof token.raw !== "string") return undefined;
		const cached = this.#incrementalTokenFragments.get(sourceOffset);
		if (cached?.kind !== "token") return undefined;
		if (cached.revision !== revision || cached.transient !== this.transientRenderCache) return undefined;
		if (cached.frozen !== this.#renderingFrozenPrefix) return undefined;
		if (cached.type !== token.type || cached.nextTokenType !== nextTokenType || cached.raw !== token.raw) {
			return undefined;
		}
		// Refresh insertion order so the bounded map evicts the least recently used
		// fragment rather than simply the oldest source offset.
		this.#incrementalTokenFragments.delete(sourceOffset);
		this.#incrementalTokenFragments.set(sourceOffset, cached);
		return cached;
	}

	#formatPlainContentLine(
		text: string,
		signature: RenderSignature,
		leftMargin: string,
		rightMargin: string,
		bgFn: ((text: string) => string) | undefined,
	): string {
		const lineWithMargins = leftMargin + text + rightMargin;
		if (bgFn) return applyBackgroundToLine(lineWithMargins, signature.width, bgFn);
		const visibleLen = visibleWidth(lineWithMargins);
		const paddingNeeded = Math.max(0, signature.width - visibleLen);
		return lineWithMargins + padding(paddingNeeded);
	}

	#appendListPlainParagraphTail(
		listToken: ListToken,
		sourceOffset: number,
		contentWidth: number,
		signature: RenderSignature,
		cached: IncrementalTokenFragment,
	): IncrementalTokenFragment | undefined {
		if (
			cached.listLastItemLineCount === undefined ||
			cached.listLastParagraphRaw === undefined ||
			cached.listLastParagraphText === undefined ||
			cached.listLastParagraphLineStart === undefined ||
			cached.listLastParagraphLineCount === undefined
		) {
			return undefined;
		}
		const lastItem = listToken.items.at(-1);
		const finalToken = lastItem?.tokens?.at(-1);
		if (
			lastItem?.raw === undefined ||
			finalToken === undefined ||
			finalToken.type !== "paragraph" ||
			!("raw" in finalToken) ||
			typeof finalToken.raw !== "string"
		) {
			return undefined;
		}
		const plainText = this.#plainParagraphText(finalToken);
		if (plainText === undefined || contentWidth < 8) return undefined;
		if (listToken.items.length !== cached.listItemCount) return undefined;
		if (!listToken.raw.startsWith(cached.raw) || !lastItem.raw.startsWith(cached.listLastItemRaw ?? "")) {
			return undefined;
		}
		if (!finalToken.raw.startsWith(cached.listLastParagraphRaw)) return undefined;
		if (plainText.length <= cached.listLastParagraphText.length) return undefined;
		if (cached.listLastParagraphText.includes("\n") || plainText.includes("\n")) return undefined;

		const wrappedLines = cached.wrappedLines as RenderedLine[];
		const contentLines = cached.contentLines as string[] | undefined;
		const oldLastItemLineCount = cached.listLastItemLineCount;
		const oldParagraphLineCount = cached.listLastParagraphLineCount;
		const itemStart = wrappedLines.length - oldLastItemLineCount;
		const paragraphStart = itemStart + cached.listLastParagraphLineStart;
		if (
			itemStart < 0 ||
			paragraphStart < itemStart ||
			oldParagraphLineCount <= 0 ||
			paragraphStart + oldParagraphLineCount !== wrappedLines.length ||
			contentLines === undefined ||
			contentLines.length !== wrappedLines.length
		) {
			return undefined;
		}

		const itemIndex = listToken.items.length - 1;
		const bullet = listToken.ordered ? `${(listToken.start ?? 1) + itemIndex}. ` : "- ";
		const firstPrefix = this.#theme.listBullet(bullet);
		const continuationPrefix = padding(visibleWidth(bullet));
		const firstPrefixWidth = visibleWidth(firstPrefix);
		const continuationPrefixWidth = visibleWidth(continuationPrefix);
		if (firstPrefixWidth >= contentWidth || continuationPrefixWidth >= contentWidth) return undefined;
		const bodyWidth =
			paragraphStart === itemStart ? contentWidth - firstPrefixWidth : contentWidth - continuationPrefixWidth;
		const rowPrefix = (rowIndex: number): string =>
			paragraphStart === itemStart && rowIndex === 0 ? firstPrefix : continuationPrefix;
		const rowBodyWidth = Math.max(1, bodyWidth);

		const rewrapStart = Math.max(0, oldParagraphLineCount - 2);
		let searchFrom = 0;
		let tailStart = -1;
		for (let rowIndex = 0; rowIndex <= rewrapStart; rowIndex++) {
			const renderedRow = wrappedLines[paragraphStart + rowIndex];
			const prefix = rowPrefix(rowIndex);
			if (
				renderedRow === undefined ||
				renderedRow.literalCode ||
				TERMINAL.isImageLine(renderedRow.text) ||
				isOsc66Line(renderedRow.text) ||
				!renderedRow.text.startsWith(prefix)
			) {
				return undefined;
			}
			const body = renderedRow.text.slice(prefix.length);
			if (body === "") return undefined;
			const rowStart = cached.listLastParagraphText.indexOf(body, searchFrom);
			if (rowStart < 0) return undefined;
			if (rowIndex === rewrapStart) tailStart = rowStart;
			searchFrom = rowStart + body.length;
		}
		if (tailStart < 0) return undefined;
		const sourceTail = cached.listLastParagraphText.slice(tailStart);
		if (sourceTail.length > Math.max(1024, rowBodyWidth * 8)) return undefined;
		const appendedText = plainText.slice(cached.listLastParagraphText.length);
		const tailRows = wrapTextWithAnsi(sourceTail + appendedText, rowBodyWidth);
		if (tailRows.length === 0) return undefined;

		const previousFragmentSize = this.#incrementalTokenFragmentSize(sourceOffset, cached);
		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		let rowIndex = paragraphStart + rewrapStart;
		for (let tailIndex = 0; tailIndex < tailRows.length; tailIndex++) {
			let renderedRow = wrappedLines[rowIndex];
			if (renderedRow === undefined) {
				renderedRow = renderedLine("");
				wrappedLines[rowIndex] = renderedRow;
			}
			renderedRow.text = rowPrefix(rewrapStart + tailIndex) + tailRows[tailIndex]!;
			delete renderedRow.literalCode;
			contentLines[rowIndex] = this.#formatPlainContentLine(
				renderedRow.text,
				signature,
				leftMargin,
				rightMargin,
				bgFn,
			);
			rowIndex++;
		}

		const newParagraphLineCount = rewrapStart + tailRows.length;
		const targetLength = paragraphStart + newParagraphLineCount;
		wrappedLines.length = targetLength;
		contentLines.length = targetLength;
		cached.raw = listToken.raw;
		cached.listLastItemRaw = lastItem.raw;
		cached.listLastItemLineCount = cached.listLastItemLineCount - oldParagraphLineCount + newParagraphLineCount;
		cached.listLastParagraphRaw = finalToken.raw;
		cached.listLastParagraphText = plainText;
		cached.listLastParagraphLineCount = newParagraphLineCount;
		this.#incrementalTokenFragmentsSize +=
			this.#incrementalTokenFragmentSize(sourceOffset, cached) - previousFragmentSize;
		return cached;
	}

	#appendListFragment(
		token: Token,
		nextTokenType: string | undefined,
		sourceOffset: number,
		contentWidth: number,
		signature: RenderSignature,
	): IncrementalTokenFragment | undefined {
		if (token.type !== "list") return undefined;
		const revision = this.#activeRenderFragmentRevision;
		if (revision === undefined || this.#normalizedTextCache?.hasReferenceDefinition === true) return undefined;
		const cached = this.#incrementalTokenFragments.get(sourceOffset);
		if (cached?.kind !== "token") return undefined;
		if (cached.revision !== revision || cached.transient !== this.transientRenderCache) return undefined;
		if (cached.frozen !== this.#renderingFrozenPrefix) return undefined;
		if (cached.type !== "list" || cached.nextTokenType !== nextTokenType) return undefined;
		if (
			cached.listItemCount === undefined ||
			cached.listLastItemRaw === undefined ||
			cached.listLastItemLineCount === undefined
		) {
			return undefined;
		}

		const listToken = token as ListToken;
		const lastItem = listToken.items.at(-1);
		if (lastItem?.raw === undefined || listToken.items.length !== cached.listItemCount) return undefined;
		if (!token.raw.startsWith(cached.raw) || !lastItem.raw.startsWith(cached.listLastItemRaw)) return undefined;
		if (lastItem.raw.length <= cached.listLastItemRaw.length) return undefined;
		if (cached.hasSpecialLine) return undefined;
		const appendedParagraph = this.#appendListPlainParagraphTail(
			listToken,
			sourceOffset,
			contentWidth,
			signature,
			cached,
		);
		if (appendedParagraph !== undefined) return appendedParagraph;

		const wrappedLines = cached.wrappedLines as RenderedLine[];
		const contentLines = cached.contentLines as string[] | undefined;
		const oldLastItemLineCount = cached.listLastItemLineCount;
		const lastItemStart = wrappedLines.length - oldLastItemLineCount;
		if (lastItemStart < 0 || contentLines === undefined || contentLines.length !== wrappedLines.length)
			return undefined;

		const renderedLastItem = this.#renderList(listToken, 0, contentWidth, undefined, listToken.items.length - 1);
		if (
			renderedLastItem.some(
				line =>
					line.literalCode ||
					TERMINAL.isImageLine(line.text) ||
					isOsc66Line(line.text) ||
					("nested" in line && line.nested === true),
			)
		) {
			return undefined;
		}

		const previousFragmentSize = this.#incrementalTokenFragmentSize(sourceOffset, cached);
		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		let rowIndex = lastItemStart;
		for (const renderedLastItemLine of renderedLastItem) {
			let renderedRow = wrappedLines[rowIndex];
			if (renderedRow === undefined) {
				renderedRow = renderedLine("");
				wrappedLines[rowIndex] = renderedRow;
			}
			renderedRow.text = renderedLastItemLine.text;
			if (renderedLastItemLine.literalCode) renderedRow.literalCode = true;
			else delete renderedRow.literalCode;
			contentLines[rowIndex] = this.#formatPlainContentLine(
				renderedLastItemLine.text,
				signature,
				leftMargin,
				rightMargin,
				bgFn,
			);
			rowIndex++;
		}
		wrappedLines.length = rowIndex;
		contentLines.length = rowIndex;
		cached.raw = token.raw;
		cached.listLastItemRaw = lastItem.raw;
		cached.listLastItemLineCount = renderedLastItem.length;
		this.#incrementalTokenFragmentsSize +=
			this.#incrementalTokenFragmentSize(sourceOffset, cached) - previousFragmentSize;
		return cached;
	}

	#appendPlainParagraphFragment(
		token: Token,
		nextTokenType: string | undefined,
		sourceOffset: number,
		contentWidth: number,
		signature: RenderSignature,
	): IncrementalTokenFragment | undefined {
		const plainText = this.#plainParagraphText(token);
		if (plainText === undefined) return undefined;

		const revision = this.#activeRenderFragmentRevision;
		if (revision === undefined || this.#normalizedTextCache?.hasReferenceDefinition === true) return undefined;
		const cached = this.#incrementalTokenFragments.get(sourceOffset);
		if (cached?.kind !== "token") return undefined;
		if (cached.revision !== revision || cached.transient !== this.transientRenderCache) return undefined;
		if (cached.frozen !== this.#renderingFrozenPrefix) return undefined;
		if (cached.type !== "paragraph" || cached.nextTokenType !== nextTokenType) return undefined;
		if (cached.plainText === undefined || cached.plainContentLineCount === undefined) return undefined;
		if (!token.raw.startsWith(cached.raw) || !plainText.startsWith(cached.plainText)) return undefined;
		if (plainText.length <= cached.plainText.length) return undefined;
		if (cached.hasSpecialLine) return undefined;
		// Newline handling has stateful whitespace behavior in the native wrapper;
		// leave those appends on the fully-rendered path. Very narrow rows also
		// have grapheme-boundary edge cases that are not worth a speculative fast path.
		if (contentWidth < 8 || cached.plainText.includes("\n")) return undefined;

		const wrappedLines = cached.wrappedLines as RenderedLine[];
		const contentLines = cached.contentLines as string[] | undefined;
		const oldContentCount = cached.plainContentLineCount;
		const spacerCount = wrappedLines.length - oldContentCount;
		if (oldContentCount <= 0 || spacerCount < 0 || spacerCount > 1 || contentLines === undefined) return undefined;
		if (contentLines.length !== wrappedLines.length) return undefined;
		const rewrapStart = Math.max(0, oldContentCount - 2);
		let searchFrom = 0;
		let tailStart = -1;
		for (let rowIndex = 0; rowIndex <= rewrapStart; rowIndex++) {
			const row = wrappedLines[rowIndex];
			if (row === undefined || row.literalCode || row.text === "") return undefined;
			const rowStart = cached.plainText.indexOf(row.text, searchFrom);
			if (rowStart < 0) return undefined;
			if (rowIndex === rewrapStart) tailStart = rowStart;
			searchFrom = rowStart + row.text.length;
		}
		if (tailStart < 0) return undefined;
		// The native wrapper may discard the separator at a line break. Start at
		// the source position of the final two rows so separator whitespace is
		// available when the append changes which row owns it.
		const sourceTail = cached.plainText.slice(tailStart);
		if (sourceTail.length > Math.max(1024, contentWidth * 8)) return undefined;
		const appendedText = plainText.slice(cached.plainText.length);
		const tailRows = wrapTextWithAnsi(sourceTail + appendedText, contentWidth);
		if (tailRows.length === 0) return undefined;

		const previousFragmentSize = this.#incrementalTokenFragmentSize(sourceOffset, cached);
		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const blankLine = spacerCount > 0 ? contentLines[oldContentCount] : undefined;
		let rowIndex = rewrapStart;
		for (const tailRow of tailRows) {
			let renderedRow = wrappedLines[rowIndex];
			if (renderedRow === undefined) {
				renderedRow = renderedLine("");
				wrappedLines[rowIndex] = renderedRow;
			}
			renderedRow.text = tailRow;
			delete renderedRow.literalCode;
			contentLines[rowIndex] = this.#formatPlainContentLine(tailRow, signature, leftMargin, rightMargin, bgFn);
			rowIndex++;
		}

		const newContentCount = rowIndex;
		const targetLength = newContentCount + spacerCount;
		for (let i = 0; i < spacerCount; i++) {
			let renderedRow = wrappedLines[rowIndex];
			if (renderedRow === undefined) {
				renderedRow = renderedLine("");
				wrappedLines[rowIndex] = renderedRow;
			}
			renderedRow.text = "";
			delete renderedRow.literalCode;
			contentLines[rowIndex] =
				blankLine ?? this.#formatPlainContentLine("", signature, leftMargin, rightMargin, bgFn);
			rowIndex++;
		}
		wrappedLines.length = targetLength;
		contentLines.length = targetLength;
		cached.raw = token.raw;
		cached.plainText = plainText;
		cached.plainContentLineCount = newContentCount;
		cached.startsWithEmptyLine = wrappedLines[0]?.text === "";
		this.#incrementalTokenFragmentsSize +=
			this.#incrementalTokenFragmentSize(sourceOffset, cached) - previousFragmentSize;
		return cached;
	}

	#incrementalTokenFragmentSize(sourceOffset: number, fragment: IncrementalRenderFragment): number {
		let size = String(sourceOffset).length + fragment.type.length + (fragment.nextTokenType?.length ?? 0);
		size += fragment.raw.length;
		for (const line of fragment.wrappedLines) size += line.text.length + 1;
		for (const table of fragment.tables) size += table.key.length + table.columnWidths.length + 4;
		if (fragment.contentLines !== undefined) {
			for (const line of fragment.contentLines) size += line.length + 1;
		}
		return Math.max(1, size);
	}

	#clearIncrementalTokenFragments(): void {
		this.#incrementalTokenFragments.clear();
		this.#incrementalTokenFragmentsSize = 0;
	}

	#deleteIncrementalTokenFragment(sourceOffset: number): void {
		const fragment = this.#incrementalTokenFragments.get(sourceOffset);
		if (fragment === undefined) return;
		this.#incrementalTokenFragments.delete(sourceOffset);
		this.#incrementalTokenFragmentsSize = Math.max(
			0,
			this.#incrementalTokenFragmentsSize - this.#incrementalTokenFragmentSize(sourceOffset, fragment),
		);
	}

	#storeTokenFragment(sourceOffset: number, fragment: IncrementalRenderFragment): void {
		const size = this.#incrementalTokenFragmentSize(sourceOffset, fragment);
		this.#deleteIncrementalTokenFragment(sourceOffset);
		if (size > RENDER_CACHE_MAX_ENTRY_SIZE) return;
		while (
			this.#incrementalTokenFragments.size >= RENDER_CACHE_MAX ||
			this.#incrementalTokenFragmentsSize + size > INCREMENTAL_FRAGMENT_CACHE_MAX_SIZE
		) {
			const oldest = this.#incrementalTokenFragments.keys().next();
			if (oldest.done) break;
			this.#deleteIncrementalTokenFragment(oldest.value);
		}
		this.#incrementalTokenFragments.set(sourceOffset, fragment);
		this.#incrementalTokenFragmentsSize += size;
	}

	#renderStreamingContentLines(
		tokens: Token[],
		normalizedText: string,
		signature: RenderSignature,
		contentWidth: number,
	): string[] {
		const frozenText = this.#streamPrefixText;
		const frozenTokenCount = this.#streamPrefixTokenCount;
		if (frozenText === undefined || frozenTokenCount === 0 || !normalizedText.startsWith(frozenText)) {
			return this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature, 0, 0);
		}

		let contentLines: string[] | undefined;
		const reusablePrefix = this.#matchingStreamPrefixLineCache(normalizedText, frozenText, signature);
		let renderedUntil = 0;
		let renderedSourceOffset = 0;
		if (reusablePrefix && reusablePrefix.tokenCount <= frozenTokenCount) {
			contentLines = reusablePrefix.lines;
			if (this.#activeTableRenderSpecs) {
				for (const table of reusablePrefix.tables) this.#activeTableRenderSpecs.push(table);
			}
			renderedUntil = reusablePrefix.tokenCount;
			renderedSourceOffset = reusablePrefix.text.length;
		}

		if (renderedUntil < frozenTokenCount) {
			this.#renderingFrozenPrefix = true;
			try {
				const renderedPrefix = this.#renderContentLines(
					tokens,
					renderedUntil,
					frozenTokenCount,
					contentWidth,
					signature,
					contentLines?.length ?? 0,
					renderedSourceOffset,
				);
				contentLines = contentLines === undefined ? renderedPrefix : contentLines.concat(renderedPrefix);
			} finally {
				this.#renderingFrozenPrefix = false;
			}
			renderedUntil = frozenTokenCount;
		}

		// Keep the frozen prefix array itself. The mutable suffix is appended to a
		// separate result below, so no copy of every settled row is needed per update.
		const frozenLines = contentLines ?? [];
		this.#streamPrefixLineCache = {
			...signature,
			text: frozenText,
			tokenCount: frozenTokenCount,
			lines: frozenLines,
			tables: this.#activeTableRenderSpecs?.slice() ?? [],
		};

		if (this.transientRenderCache && frozenLines.length > 0) {
			if (this.#settledExposedText === undefined || frozenText.startsWith(this.#settledExposedText)) {
				this.#settledExposedText = frozenText;
				this.#lastRenderSettledRows = signature.paddingY + frozenLines.length;
			} else {
				this.#settledExposedText = undefined;
			}
		}

		if (renderedUntil < tokens.length) {
			contentLines = frozenLines.concat(
				this.#renderContentLines(
					tokens,
					renderedUntil,
					tokens.length,
					contentWidth,
					signature,
					frozenLines.length,
					frozenText.length,
				),
			);
		} else {
			contentLines = frozenLines;
		}

		return contentLines;
	}

	#matchingStreamPrefixLineCache(
		normalizedText: string,
		frozenText: string,
		signature: RenderSignature,
	): StreamPrefixLineCache | undefined {
		const cache = this.#streamPrefixLineCache;
		if (!cache) return undefined;
		if (!normalizedText.startsWith(cache.text) || !frozenText.startsWith(cache.text)) return undefined;
		if (cache.width !== signature.width) return undefined;
		if (cache.paddingX !== signature.paddingX) return undefined;
		if (cache.paddingY !== signature.paddingY) return undefined;
		if (cache.codeBlockIndent !== signature.codeBlockIndent) return undefined;
		if (cache.themeId !== signature.themeId) return undefined;
		if (cache.defaultTextStyleId !== signature.defaultTextStyleId) return undefined;
		if (cache.imageProtocol !== signature.imageProtocol) return undefined;
		if (cache.hyperlinks !== signature.hyperlinks) return undefined;
		if (cache.textSizing !== signature.textSizing) return undefined;
		if (cache.bgColorProbe !== signature.bgColorProbe) return undefined;
		if (cache.headingProbe !== signature.headingProbe) return undefined;
		if (cache.themeRevision !== signature.themeRevision) return undefined;
		return cache;
	}

	#renderContentLines(
		tokens: Token[],
		start: number,
		end: number,
		contentWidth: number,
		signature: RenderSignature,
		rowOffset: number,
		startingSourceOffset: number,
	): string[] {
		const wrappedLines = this.#renderWrappedLinesScratch;
		wrappedLines.length = 0;
		const tokenSegments = this.#renderTokenSegmentsScratch;
		tokenSegments.length = 0;
		const canReuseContentLines =
			this.#streamPrefixLineCache !== undefined && startingSourceOffset >= this.#streamPrefixLineCache.text.length;
		const contentLines = canReuseContentLines ? this.#renderContentLinesScratch : [];
		contentLines.length = 0;
		let sourceOffset = startingSourceOffset;
		for (let i = start; i < end; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tableSpecStart = this.#activeTableRenderSpecs?.length ?? 0;
			const tokenWrappedRowStart = wrappedLines.length;
			const tokenRowStart = rowOffset + tokenWrappedRowStart;
			const cachedToken = this.#cachedTokenFragment(token, nextToken?.type, sourceOffset);

			if (cachedToken !== undefined) {
				for (const line of cachedToken.wrappedLines) wrappedLines.push(line);
				for (const table of cachedToken.tables) {
					this.#activeTableRenderSpecs?.push({
						...table,
						startRow: tokenRowStart + table.startRow,
						endRow: tokenRowStart + table.endRow,
						columnWidths: table.columnWidths.slice(),
					});
				}
				tokenSegments.push({
					start: tokenWrappedRowStart,
					end: wrappedLines.length,
					fragment: cachedToken,
					sourceOffset,
					storeFragment: false,
				});
			} else {
				const appendedFragment =
					this.#appendListFragment(token, nextToken?.type, sourceOffset, contentWidth, signature) ??
					this.#appendPlainParagraphFragment(token, nextToken?.type, sourceOffset, contentWidth, signature);
				if (appendedFragment !== undefined) {
					for (const line of appendedFragment.wrappedLines) wrappedLines.push(line);
					tokenSegments.push({
						start: tokenWrappedRowStart,
						end: wrappedLines.length,
						fragment: appendedFragment,
						sourceOffset,
						storeFragment: true,
					});
				} else {
					const renderedTokenLines = this.#renderToken(
						token,
						contentWidth,
						nextToken?.type,
						undefined,
						`offset:${sourceOffset}`,
					);
					const tokenLineOffsets = [0];
					for (const renderedRow of renderedTokenLines) {
						if (
							token.type === "list" ||
							TERMINAL.isImageLine(renderedRow.text) ||
							isOsc66Line(renderedRow.text)
						) {
							wrappedLines.push(renderedRow);
						} else {
							const wrappedRows = wrapTextWithAnsi(renderedRow.text, contentWidth);
							if (wrappedRows.length === 1 && wrappedRows[0] === renderedRow.text) {
								wrappedLines.push(renderedRow);
							} else {
								for (const wrappedLine of wrappedRows) {
									wrappedLines.push(renderedLine(wrappedLine, renderedRow.literalCode));
								}
							}
						}
						tokenLineOffsets.push(wrappedLines.length - tokenWrappedRowStart);
					}
					const tableSpecs = this.#activeTableRenderSpecs;
					if (tableSpecs !== undefined) {
						for (let specIndex = tableSpecStart; specIndex < tableSpecs.length; specIndex++) {
							const spec = tableSpecs[specIndex]!;
							let relativeStart: number;
							let relativeEnd: number;
							if (token.type === "table") {
								relativeStart = 0;
								relativeEnd = Math.min(renderedTokenLines.length, spec.lineCount);
							} else {
								if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
								relativeStart = Math.min(renderedTokenLines.length, spec.startRow);
								relativeEnd = Math.min(renderedTokenLines.length, spec.endRow);
							}
							spec.startRow = tokenRowStart + tokenLineOffsets[relativeStart]!;
							spec.endRow = tokenRowStart + tokenLineOffsets[relativeEnd]!;
						}
					}

					if (
						this.#activeRenderFragmentRevision !== undefined &&
						"raw" in token &&
						typeof token.raw === "string"
					) {
						const tables = (this.#activeTableRenderSpecs?.slice(tableSpecStart) ?? []).map(table => ({
							...table,
							startRow: table.startRow - tokenRowStart,
							endRow: table.endRow - tokenRowStart,
							columnWidths: table.columnWidths.slice(),
						}));
						const fragment: IncrementalTokenFragment = {
							kind: "token",
							revision: this.#activeRenderFragmentRevision,
							transient: this.transientRenderCache,
							frozen: this.#renderingFrozenPrefix,
							type: token.type,
							nextTokenType: nextToken?.type,
							raw: token.raw,
							wrappedLines: wrappedLines.slice(tokenWrappedRowStart),
							tables,
							hasSpecialLine: wrappedLines
								.slice(tokenWrappedRowStart)
								.some(line => TERMINAL.isImageLine(line.text) || isOsc66Line(line.text)),
							startsWithEmptyLine: wrappedLines[tokenWrappedRowStart]?.text === "",
						};
						const plainParagraphText = this.#plainParagraphText(token);
						if (plainParagraphText !== undefined && !fragment.hasSpecialLine) {
							const spacerRows =
								nextToken?.type && nextToken.type !== "list" && nextToken.type !== "space" ? 1 : 0;
							fragment.plainText = plainParagraphText;
							fragment.plainContentLineCount = Math.max(0, fragment.wrappedLines.length - spacerRows);
						}
						if (token.type === "list" && !fragment.hasSpecialLine) {
							const listToken = token as ListToken;
							const lastItem = listToken.items.at(-1);
							if (lastItem?.raw !== undefined && this.#lastRenderedListLastItemLineCount > 0) {
								fragment.listItemCount = listToken.items.length;
								fragment.listLastItemRaw = lastItem.raw;
								fragment.listLastItemLineCount = this.#lastRenderedListLastItemLineCount;
								if (
									this.#lastRenderedListMutableParagraphLineStart >= 0 &&
									this.#lastRenderedListMutableParagraphLineCount > 0
								) {
									const finalToken = lastItem.tokens?.at(-1);
									if (finalToken !== undefined && "raw" in finalToken && typeof finalToken.raw === "string") {
										fragment.listLastParagraphRaw = finalToken.raw;
										fragment.listLastParagraphText = this.#plainParagraphText(finalToken);
										if (fragment.listLastParagraphText !== undefined) {
											fragment.listLastParagraphLineStart = this.#lastRenderedListMutableParagraphLineStart;
											fragment.listLastParagraphLineCount = this.#lastRenderedListMutableParagraphLineCount;
										}
									}
								}
							}
						}
						tokenSegments.push({
							start: tokenWrappedRowStart,
							end: wrappedLines.length,
							fragment,
							sourceOffset,
							storeFragment: true,
						});
					} else {
						tokenSegments.push({
							start: tokenWrappedRowStart,
							end: wrappedLines.length,
							sourceOffset,
							storeFragment: false,
						});
					}
				}
			}
			sourceOffset += token.raw.length;
		}
		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		let previousLineWasOsc66 = false;
		for (const segment of tokenSegments) {
			const fragment = segment.fragment;
			if (
				fragment?.contentLines !== undefined &&
				!fragment.hasSpecialLine &&
				(!previousLineWasOsc66 || !fragment.startsWithEmptyLine)
			) {
				for (const line of fragment.contentLines) contentLines.push(line);
				previousLineWasOsc66 = false;
				continue;
			}

			const contentStart = contentLines.length;
			for (let rowIndex = segment.start; rowIndex < segment.end; rowIndex++) {
				const renderedLine = wrappedLines[rowIndex]!;
				const literalCodeRow = renderedLine.literalCode === true;
				const line = renderedLine.text;

				if (previousLineWasOsc66 && line === "") {
					contentLines.push("");
					previousLineWasOsc66 = false;
					continue;
				}

				if (TERMINAL.isImageLine(line) || isOsc66Line(line)) {
					contentLines.push(line);
					previousLineWasOsc66 = isOsc66Line(line);
					continue;
				}

				previousLineWasOsc66 = false;
				if (literalCodeRow) {
					contentLines.push(line);
					continue;
				}
				const lineWithMargins = leftMargin + line + rightMargin;

				if (bgFn) {
					contentLines.push(applyBackgroundToLine(lineWithMargins, signature.width, bgFn));
				} else {
					const visibleLen = visibleWidth(lineWithMargins);
					const paddingNeeded = Math.max(0, signature.width - visibleLen);
					contentLines.push(lineWithMargins + padding(paddingNeeded));
				}
			}

			if (segment.storeFragment && fragment !== undefined) {
				if (!fragment.hasSpecialLine) fragment.contentLines = contentLines.slice(contentStart);
				this.#storeTokenFragment(segment.sourceOffset, fragment);
			}
		}

		tokenSegments.length = 0;
		wrappedLines.length = 0;
		return contentLines;
	}

	#resolveRenderedTableLayouts(specs: readonly TableRenderSpec[], topPadding: number): RenderedTableLayout[] {
		const layouts: RenderedTableLayout[] = [];
		for (const spec of specs) {
			if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
			layouts.push({
				key: spec.key,
				availableWidth: spec.availableWidth,
				columnWidths: spec.columnWidths.slice(),
				startRow: topPadding + spec.startRow,
				endRow: topPadding + spec.endRow,
			});
		}
		return layouts;
	}

	#codeFenceRow(lang: string | undefined, pos: "open" | "close"): string {
		if (this.#theme.codeBlockFence) return this.#theme.codeBlockFence(lang || undefined, pos);
		return this.#theme.codeBlockBorder(pos === "open" ? `\`\`\`${lang || ""}` : "```");
	}

	#renderCodeBodyLines(token: Token, codeIndent: string): RenderedLine[] {
		const literalCode = this.#codeBlockIndent === 0;
		const bodyLines: RenderedLine[] = [];
		const tokenText = "text" in token && typeof token.text === "string" ? token.text : "";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const addBodyLine = (line: string): void => {
			bodyLines.push(renderedLine(literalCode ? line : codeIndent + line, literalCode));
		};

		const streaming = this.transientRenderCache && !this.#renderingFrozenPrefix;
		if (this.#theme.highlightCode && (!streaming || this.#codeTokenHasClosingFence(token))) {
			const highlightedLines = this.#theme.highlightCode(tokenText, lang);
			for (const hlLine of highlightedLines) {
				addBodyLine(hlLine);
			}
			return bodyLines;
		}

		if (streaming && this.#theme.highlightCode) {
			const lineEnd = tokenText.lastIndexOf("\n");
			const completedLines = lineEnd >= 0 ? this.#highlightStreamingLines(tokenText.slice(0, lineEnd), lang) : null;
			if (completedLines) {
				for (const hlLine of completedLines) {
					addBodyLine(hlLine);
				}
				for (const codeLine of tokenText.slice(lineEnd + 1).split("\n")) {
					addBodyLine(this.#theme.codeBlock(codeLine));
				}
				return bodyLines;
			}
		}

		for (const codeLine of tokenText.split("\n")) {
			addBodyLine(this.#theme.codeBlock(codeLine));
		}
		return bodyLines;
	}

	#codeTokenHasClosingFence(token: Token): boolean {
		const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
		const firstLineEnd = raw.indexOf("\n");
		if (firstLineEnd < 0) return false;
		const openingLine = raw.slice(0, firstLineEnd);
		const openingTrimmed = openingLine.trimStart();
		const openingIndent = openingLine.length - openingTrimmed.length;
		if (openingIndent > 3) return false;
		const fenceChar = openingTrimmed.charAt(0);
		if (fenceChar !== "`" && fenceChar !== "~") return false;
		let fenceLength = 0;
		while (openingTrimmed.charAt(fenceLength) === fenceChar) fenceLength++;
		if (fenceLength < 3) return false;

		let lineStart = firstLineEnd + 1;
		while (lineStart <= raw.length) {
			const lineEnd = raw.indexOf("\n", lineStart);
			const line = lineEnd >= 0 ? raw.slice(lineStart, lineEnd) : raw.slice(lineStart);
			const trimmed = line.trimStart();
			const indent = line.length - trimmed.length;
			let closingLength = 0;
			while (trimmed.charAt(closingLength) === fenceChar) closingLength++;
			if (indent <= 3 && closingLength >= fenceLength && trimmed.slice(closingLength).trim().length === 0) {
				return true;
			}
			if (lineEnd < 0) break;
			lineStart = lineEnd + 1;
		}
		return false;
	}

	#highlightStreamingLines(completedText: string, lang: string | undefined): readonly string[] | null {
		const signature = this.#activeRenderSignature;
		const cache = this.#streamingHighlightCache;
		if (
			signature &&
			cache &&
			completedText.startsWith(cache.text) &&
			(cache.text.length === completedText.length || completedText.charCodeAt(cache.text.length) === 0x0a) &&
			cache.lang === lang &&
			cache.width === signature.width &&
			cache.paddingX === signature.paddingX &&
			cache.paddingY === signature.paddingY &&
			cache.codeBlockIndent === signature.codeBlockIndent &&
			cache.themeId === signature.themeId &&
			cache.defaultTextStyleId === signature.defaultTextStyleId &&
			cache.imageProtocol === signature.imageProtocol &&
			cache.hyperlinks === signature.hyperlinks &&
			cache.textSizing === signature.textSizing &&
			cache.bgColorProbe === signature.bgColorProbe &&
			cache.headingProbe === signature.headingProbe &&
			cache.themeRevision === signature.themeRevision
		) {
			if (completedText.length === cache.text.length) return cache.lines;

			const addedText = completedText.slice(cache.text.length + 1);
			const lines = cache.lines.concat(splitPushedHighlightLines(cache.stream.push(`${addedText}\n`)));
			this.#streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream: cache.stream };
			return lines;
		}

		const stream = this.#createHighlightStream(lang);
		if (!stream) return null;
		const lines = splitPushedHighlightLines(stream.push(`${completedText}\n`));
		if (signature) {
			this.#streamingHighlightCache = { ...signature, lang, text: completedText, lines, stream };
		}
		return lines;
	}

	#createHighlightStream(lang: string | undefined): HighlightStreamSession | null {
		const factory = this.#theme.createHighlightStream;
		if (factory) return factory(lang);
		const highlightCode = this.#theme.highlightCode;
		if (!highlightCode) return null;
		const normalizedLang = lang?.toLowerCase();
		if (normalizedLang !== "diff" && normalizedLang !== "patch" && normalizedLang !== "udiff") return null;
		return {
			push: chunk => {
				const lines = chunk.split("\n");
				const trailing = lines.pop() ?? "";
				let out = "";
				for (const line of lines) out += `${highlightCode(line, lang).join("\n")}\n`;
				return trailing ? out + highlightCode(trailing, lang).join("\n") : out;
			},
		};
	}

	#renderEmptyPaddingLines(signature: RenderSignature): string[] {
		const emptyLine = padding(signature.width);
		const emptyLines: string[] = [];
		const bgFn = this.#defaultTextStyle?.bgColor;
		for (let i = 0; i < signature.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, signature.width, bgFn) : emptyLine;
			emptyLines.push(line);
		}
		return emptyLines;
	}

	#applyDefaultStyle(text: string): string {
		if (!this.#defaultTextStyle) {
			return text;
		}

		let styled = text;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		return styled;
	}

	#getDefaultStylePrefix(): string {
		if (!this.#defaultTextStyle) {
			return "";
		}

		if (this.#defaultStylePrefix !== undefined) {
			return this.#defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.#defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.#defaultStylePrefix;
	}

	#getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	#getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.#applyDefaultStyle(text),
			stylePrefix: this.#getDefaultStylePrefix(),
		};
	}

	#renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		tokenKey = "root",
	): RenderedLine[] {
		const lines: RenderedLine[] = [];

		if (isMathToken(token)) {
			for (const mathLine of latexToBlock(token.text)) lines.push(renderedLine(this.#applyDefaultStyle(mathLine)));
			if (nextTokenType && nextTokenType !== "space") lines.push(renderedLine(""));
			return lines;
		}

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.#renderInlineTokens(token.tokens || [], styleContext);
				const headingPlainText = plainInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1 && TERMINAL.textSizing) {
					const plainWidth = visibleWidth(headingPlainText);
					if (plainWidth > 0 && 2 * plainWidth <= width) {
						const sizedHeading = encodeTextSizedHeading(headingPlainText, 2);
						lines.push(renderedLine(this.#theme.heading(this.#theme.bold(this.#theme.underline(sizedHeading)))));
						lines.push(renderedLine(""));
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(renderedLine(""));
						}
						break;
					}
				}
				if (headingLevel === 1) {
					styledHeading = this.#theme.heading(this.#theme.bold(this.#theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.#theme.heading(this.#theme.bold(headingText));
				} else {
					styledHeading = this.#theme.heading(this.#theme.bold(headingPrefix + headingText));
				}
				lines.push(renderedLine(styledHeading));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "paragraph": {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push(renderedLine(this.#applyDefaultStyle(mathLine)));
					if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") lines.push(renderedLine(""));
					break;
				}
				const paragraphText =
					this.#plainParagraphText(token) ?? this.#renderInlineTokens(token.tokens || [], styleContext);
				for (const paragraphLine of hangWrapTreeGuideLines(paragraphText, width) ?? [paragraphText]) {
					lines.push(renderedLine(paragraphLine));
				}

				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "code": {
				if (token.lang === "mermaid" && this.#theme.resolveMermaidAscii) {
					const ascii = this.#theme.resolveMermaidAscii(token.text, width);
					if (ascii) {
						for (const asciiLine of ascii.split("\n")) {
							lines.push(
								renderedLine(
									visibleWidth(asciiLine) > width
										? truncateToWidth(asciiLine, width, Ellipsis.Omit)
										: asciiLine,
								),
							);
						}
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(renderedLine(""));
						}
						break;
					}
				}

				const codeIndent = padding(this.#codeBlockIndent);
				lines.push(renderedLine(this.#codeFenceRow(token.lang, "open")));
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push(bodyLine);
				}
				lines.push(renderedLine(this.#codeFenceRow(token.lang, "close")));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "list": {
				const listLines = this.#renderList(token as ListToken, 0, width, styleContext);
				for (const line of listLines) lines.push(line);

				break;
			}

			case "table": {
				const tableLines = this.#renderTable(token as TableToken, width, nextTokenType, styleContext, tokenKey);
				for (const tableLine of tableLines) lines.push(renderedLine(tableLine));
				break;
			}

			case "blockquote": {
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: "",
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: RenderedLine[] = [];
				const blockquoteSpecStart = this.#activeTableRenderSpecs?.length ?? 0;

				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const quoteTokenRowStart = renderedQuoteLines.length;
					const quoteSpecStart = this.#activeTableRenderSpecs?.length ?? 0;
					const quoteTokenLines = this.#renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
						`${tokenKey}/quote:${i}`,
					);
					for (const line of quoteTokenLines) renderedQuoteLines.push(line);

					const tableSpecs = this.#activeTableRenderSpecs;
					if (tableSpecs !== undefined) {
						for (let specIndex = quoteSpecStart; specIndex < tableSpecs.length; specIndex++) {
							const spec = tableSpecs[specIndex]!;
							if (spec.startRow < 0) {
								spec.startRow = quoteTokenRowStart;
								spec.endRow = quoteTokenRowStart + Math.min(quoteTokenLines.length, spec.lineCount);
							} else {
								spec.startRow += quoteTokenRowStart;
								spec.endRow += quoteTokenRowStart;
							}
						}
					}
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1]!.text === "") {
					renderedQuoteLines.pop();
				}

				const quoteRowOffsets: number[] = [];
				const borderedQuoteLines = this.#applyQuoteBorder(renderedQuoteLines, width, quoteRowOffsets);
				const tableSpecs = this.#activeTableRenderSpecs;
				if (tableSpecs !== undefined) {
					for (let specIndex = blockquoteSpecStart; specIndex < tableSpecs.length; specIndex++) {
						const spec = tableSpecs[specIndex]!;
						if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
						const relativeStart = Math.min(renderedQuoteLines.length, spec.startRow);
						const relativeEnd = Math.min(renderedQuoteLines.length, spec.endRow);
						spec.startRow = quoteRowOffsets[relativeStart]!;
						spec.endRow = quoteRowOffsets[relativeEnd]!;
					}
				}
				for (const line of borderedQuoteLines) lines.push(line);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "hr": {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw.trim() : "";
				lines.push(renderedLine(this.#renderHrLine(width, raw[0] || "")));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(renderedLine(""));
				}
				break;
			}

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					for (const line of this.#renderHtmlBlock(token.raw, width)) lines.push(line);
				}
				break;

			case "space":
				lines.push(renderedLine(""));
				break;

			default:
				if ("text" in token && typeof token.text === "string") {
					lines.push(renderedLine(token.text));
				}
		}

		return lines;
	}

	#renderHrLine(width: number, sourceChar = ""): string {
		const fillChar = getHrChar(sourceChar, this.#theme.symbols.hrChar);
		return this.#theme.hr(fillChar.repeat(Math.min(width, 80)));
	}

	#applyQuoteBorder(renderedLines: RenderedLine[], width: number, sourceRowOffsets?: number[]): RenderedLine[] {
		const quoteStyle = (text: string) => this.#theme.quote(this.#theme.italic(text));
		const quoteStylePrefix = this.#getStylePrefix(quoteStyle);
		const applyQuoteStyle = (line: string): string => {
			if (!quoteStylePrefix) {
				return quoteStyle(line);
			}
			const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
			return quoteStyle(lineWithReappliedStyle);
		};
		const quoteContentWidth = Math.max(1, width - 2);
		const lines: RenderedLine[] = [];
		sourceRowOffsets?.push(0);
		for (const quoteLine of renderedLines) {
			if (quoteLine.literalCode) {
				const wrappedLiteralRows = wrapTextWithAnsi(quoteLine.text, quoteContentWidth);
				if (wrappedLiteralRows.length === 0) {
					lines.push(renderedLine("", true));
				} else {
					for (const wrappedLine of wrappedLiteralRows) {
						lines.push(renderedLine(wrappedLine, true));
					}
				}
			} else {
				const styledLine = applyQuoteStyle(quoteLine.text);
				for (const wrappedLine of wrapTextWithAnsi(styledLine, quoteContentWidth)) {
					lines.push(renderedLine(this.#theme.quoteBorder(`${this.#theme.symbols.quoteBorder} `) + wrappedLine));
				}
			}
			sourceRowOffsets?.push(lines.length);
		}
		return lines;
	}

	#renderHtmlBlock(raw: string, width: number): RenderedLine[] {
		const lines: RenderedLine[] = [];
		const state = createHtmlNormalizationState();
		const codeHook = (text: string): string => this.#theme.code(text) + this.#getDefaultStylePrefix();
		const flushText = (chunk: string): void => {
			const cleaned = normalizeHtmlForTerminal(chunk, state, codeHook);
			if (cleaned.trim() === "") return;
			for (const line of splitTerminalLines(cleaned)) {
				const trimmed = line.trimEnd();
				lines.push(renderedLine(trimmed.trim() === "" ? "" : this.#applyDefaultStyle(trimmed)));
			}
		};
		let lastIndex = 0;
		BLOCK_HTML_REGEX.lastIndex = 0;
		for (let match = BLOCK_HTML_REGEX.exec(raw); match !== null; match = BLOCK_HTML_REGEX.exec(raw)) {
			flushText(raw.slice(lastIndex, match.index));
			lastIndex = match.index + match[0].length;
			if (match[1] !== undefined) {
				for (const line of this.#renderHtmlBlockquote(match[1], width)) lines.push(line);
			} else {
				lines.push(renderedLine(this.#renderHrLine(width)));
			}
		}
		flushText(raw.slice(lastIndex));
		return lines;
	}

	#renderHtmlBlockquote(inner: string, width: number): RenderedLine[] {
		const cleaned = normalizeHtmlForTerminal(inner, createHtmlNormalizationState(), text => this.#theme.code(text));
		const innerLines = splitTerminalLines(cleaned).map(line => renderedLine(line.trimEnd()));
		while (innerLines.length > 0 && innerLines[innerLines.length - 1].text === "") innerLines.pop();
		return this.#applyQuoteBorder(innerLines, width);
	}

	#renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.#getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => (segment === "" ? "" : applyText(segment))).join("\n");
		};
		const swatchGlyph = this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
		let trimLeadingWhitespace = false;
		const htmlState = createHtmlNormalizationState();
		const markHtmlItemWhenContent = (text: string): void => {
			markCurrentHtmlItemContent(htmlState, text);
		};

		for (const token of collapseInlineHtml(tokens)) {
			if (isMathToken(token)) {
				markHtmlItemWhenContent(token.text);
				result += applyTextWithNewlines(renderMathToken(token.text));
				continue;
			}
			switch (token.type) {
				case "text": {
					const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
					const text = normalizeHtmlEntitiesForTerminal(rawText);
					trimLeadingWhitespace = false;
					markHtmlItemWhenContent(text);
					if (token.tokens) markHtmlItemWhenContent(plainInlineTokens(token.tokens));

					if (token.tokens && token.tokens.length > 0) {
						result += this.#renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += renderTextWithSwatches(text, applyTextWithNewlines, swatchGlyph);
					}
					break;
				}

				case "paragraph":
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					const boldContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan": {
					markHtmlItemWhenContent(token.text);
					result += codespanSwatch(token.text, swatchGlyph) + this.#theme.code(token.text) + stylePrefix;
					break;
				}

				case "link": {
					markHtmlItemWhenContent(token.text);
					const linkText = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLinkText = this.#theme.link(this.#theme.underline(linkText));
					const href = typeof token.href === "string" ? token.href : "";
					const clickableLinkText = formatHyperlink(styledLinkText, href);

					const hrefForComparison = href.startsWith("mailto:") ? href.slice(7) : href;
					if (!href || token.text === href || token.text === hrefForComparison)
						result += clickableLinkText + stylePrefix;
					else {
						const styledLinkUrl = this.#theme.linkUrl(`(${href})`);
						result += `${clickableLinkText} ${formatHyperlink(styledLinkUrl, href)}${stylePrefix}`;
					}
					break;
				}

				case "br":
					result += "\n";
					trimLeadingWhitespace = true;
					break;

				case "del": {
					const delContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						const cleaned = normalizeHtmlForTerminal(token.raw, htmlState);
						result += applyTextWithNewlines(cleaned);
						if (cleaned.endsWith("\n")) {
							trimLeadingWhitespace = true;
						} else if (cleaned.length > 0) {
							trimLeadingWhitespace = false;
						}
					}
					break;

				default:
					if ("text" in token && typeof token.text === "string") {
						const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
						const text = normalizeHtmlEntitiesForTerminal(rawText);
						trimLeadingWhitespace = false;
						markHtmlItemWhenContent(text);
						result += applyTextWithNewlines(text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	#renderList(
		token: ListToken,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
		onlyItemIndex?: number,
	): RenderedLine[] {
		const lines: RenderedLine[] = [];
		const indent = "  ".repeat(depth);

		const startNumber = token.start ?? 1;
		const pushWrapped = (line: RenderedLine, firstPrefix: string, continuationPrefix: string): void => {
			if (line.literalCode) {
				const wrappedLiteralRows = wrapTextWithAnsi(line.text, Math.max(1, width));
				if (wrappedLiteralRows.length === 0) {
					lines.push(renderedLine("", true));
				} else {
					for (const wrappedLine of wrappedLiteralRows) {
						lines.push(renderedLine(wrappedLine, true));
					}
				}
				return;
			}

			const prefixWidth = visibleWidth(firstPrefix);
			if (prefixWidth >= width) {
				lines.push(renderedLine(truncateToWidth(firstPrefix, width, Ellipsis.Omit)));
				for (const wrappedLine of wrapTextWithAnsi(line.text, Math.max(1, width))) {
					lines.push(renderedLine(wrappedLine));
				}
				return;
			}
			const bodyWidth = width - prefixWidth;
			const wrapped = wrapTextWithAnsi(line.text, bodyWidth);
			if (wrapped.length === 0) {
				lines.push(renderedLine(firstPrefix));
				return;
			}
			lines.push(renderedLine(firstPrefix + wrapped[0]));
			for (let lineIndex = 1; lineIndex < wrapped.length; lineIndex++) {
				lines.push(renderedLine(continuationPrefix + wrapped[lineIndex]));
			}
		};

		const firstItemIndex = onlyItemIndex ?? 0;
		const lastItemIndex = onlyItemIndex ?? token.items.length - 1;
		let mutableParagraphLineStart = -1;
		let mutableParagraphLineCount = 0;
		for (let i = firstItemIndex; i <= lastItemIndex; i++) {
			const item = token.items[i];
			const itemLineStart = lines.length;
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			const firstPrefix = indent + this.#theme.listBullet(bullet);

			const continuationIndent = indent + padding(visibleWidth(bullet));
			let mutableParagraphCapture: MutableListParagraphCapture | undefined;
			if (i === lastItemIndex) {
				const finalToken = item.tokens?.at(-1);
				const finalText = finalToken === undefined ? undefined : this.#plainParagraphText(finalToken);
				if (
					finalToken !== undefined &&
					finalText !== undefined &&
					"raw" in finalToken &&
					typeof finalToken.raw === "string"
				) {
					mutableParagraphCapture = { raw: finalToken.raw, text: finalText, lineStart: 0, lineCount: 0 };
				}
			}

			const itemLines = this.#renderListItem(item.tokens || [], depth, width, styleContext, mutableParagraphCapture);

			if (itemLines.length > 0) {
				const firstLine = itemLines[0]!;
				if (mutableParagraphCapture?.lineStart === 0) mutableParagraphLineStart = lines.length - itemLineStart;
				if (firstLine.nested) {
					lines.push(firstLine);
				} else {
					pushWrapped(firstLine, firstPrefix, continuationIndent);
				}

				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j]!;
					if (mutableParagraphCapture?.lineStart === j) mutableParagraphLineStart = lines.length - itemLineStart;
					if (line.nested) {
						lines.push(line);
					} else {
						pushWrapped(line, continuationIndent, continuationIndent);
					}
				}
			} else {
				lines.push(renderedLine(firstPrefix));
			}
			if (i === lastItemIndex) {
				this.#lastRenderedListLastItemLineCount = lines.length - itemLineStart;
				if (mutableParagraphCapture !== undefined && mutableParagraphLineStart >= 0) {
					mutableParagraphLineCount = lines.length - itemLineStart - mutableParagraphLineStart;
				}
			}
		}
		if (token.items.length === 0) this.#lastRenderedListLastItemLineCount = 0;
		this.#lastRenderedListMutableParagraphLineStart = mutableParagraphLineStart;
		this.#lastRenderedListMutableParagraphLineCount = mutableParagraphLineCount;

		return lines;
	}

	#renderListItem(
		tokens: Token[],
		parentDepth: number,
		width: number,
		styleContext?: InlineStyleContext,
		capture?: MutableListParagraphCapture,
	): RenderedListItemLine[] {
		const lines: RenderedListItemLine[] = [];

		for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
			const token = tokens[tokenIndex]!;
			const tokenLineStart = lines.length;
			if (token.type === "list") {
				const nestedLines = this.#renderList(token as ListToken, parentDepth + 1, width, styleContext);
				for (const nestedLine of nestedLines) {
					lines.push({ ...nestedLine, nested: true });
				}
			} else if (token.type === "text") {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					const text =
						token.tokens && token.tokens.length > 0
							? this.#renderInlineTokens(token.tokens, styleContext)
							: token.text || "";
					lines.push({ text, nested: false });
				}
			} else if (token.type === "paragraph") {
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					const paragraphText =
						this.#plainParagraphText(token) ?? this.#renderInlineTokens(token.tokens || [], styleContext);
					lines.push({ text: paragraphText, nested: false });
					if (
						capture !== undefined &&
						tokenIndex === tokens.length - 1 &&
						"raw" in token &&
						typeof token.raw === "string" &&
						token.raw === capture.raw &&
						paragraphText === capture.text
					) {
						capture.lineStart = tokenLineStart;
						capture.lineCount = lines.length - tokenLineStart;
					}
				}
			} else if (token.type === "code") {
				const codeIndent = padding(this.#codeBlockIndent);
				lines.push({ text: this.#codeFenceRow(token.lang, "open"), nested: false });
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push({ ...bodyLine, nested: false });
				}
				lines.push({ text: this.#codeFenceRow(token.lang, "close"), nested: false });
			} else if (isMathToken(token)) {
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				for (const mathLine of latexToBlock(token.text)) lines.push({ text: apply(mathLine), nested: false });
			} else {
				const text = this.#renderInlineTokens([token], styleContext);
				if (text) {
					lines.push({ text, nested: false });
				}
			}
		}

		return lines;
	}

	#getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter(word => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	#terminalLineWidths(text: string): number[] {
		return splitTerminalLines(text).map(line => visibleWidth(line));
	}

	#wrapCellText(text: string, maxWidth: number): string[] {
		const cellWidth = Math.max(1, maxWidth);

		const wrapped = [...wrapTextWithAnsi(text, cellWidth)];
		while (wrapped.length > 1 && wrapped[wrapped.length - 1] === "") {
			wrapped.pop();
		}

		return wrapped.map(line => `${line}\x1b[22m\x1b[23m\x1b[39m`);
	}

	#renderTable(
		token: TableToken,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		tableKey = "table",
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			const fallbackLines = token.raw ? [...wrapTextWithAnsi(token.raw, availableWidth)] : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.#renderInlineTokens(token.header[i].tokens || [], styleContext);
			const headerLineWidths = this.#terminalLineWidths(headerText);
			naturalWidths[i] = Math.max(...headerLineWidths, 0);
			minWordWidths[i] = Math.max(1, this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.#renderInlineTokens(row[i].tokens || [], styleContext);
				const cellLineWidths = this.#terminalLineWidths(cellText);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, ...cellLineWidths);
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map(width => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const lockedLayout = this.#lockedTableLayouts.get(tableKey);
		if (
			lockedLayout !== undefined &&
			lockedLayout.availableWidth === availableWidth &&
			lockedLayout.columnWidths.length === numCols &&
			lockedLayout.columnWidths.every(width => Number.isFinite(width) && width >= 1) &&
			lockedLayout.columnWidths.reduce((total, width) => total + width, borderOverhead) <= availableWidth
		) {
			columnWidths = lockedLayout.columnWidths.slice();
		}

		const t = this.#theme.symbols.table;
		const h = t.horizontal;
		const v = t.vertical;

		const topBorderCells = columnWidths.map(w => h.repeat(w));
		lines.push(`${t.topLeft}${h}${topBorderCells.join(`${h}${t.teeDown}${h}`)}${h}${t.topRight}`);

		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
			return this.#wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map(c => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.#theme.bold(padded);
			});
			lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
		}

		const separatorCells = columnWidths.map(w => h.repeat(w));
		const separatorLine = `${t.teeRight}${h}${separatorCells.join(`${h}${t.cross}${h}`)}${h}${t.teeLeft}`;
		lines.push(separatorLine);

		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
				return this.#wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map(c => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		const bottomBorderCells = columnWidths.map(w => h.repeat(w));
		const bottomBorder = `${t.bottomLeft}${h}${bottomBorderCells.join(`${h}${t.teeUp}${h}`)}${h}${t.bottomRight}`;
		lines.push(bottomBorder);
		this.#activeTableRenderSpecs?.push({
			key: tableKey,
			availableWidth,
			columnWidths: columnWidths.slice(),
			lineCount: lines.length,
			startRow: -1,
			endRow: -1,
		});

		if (nextTokenType && nextTokenType !== "space") {
			lines.push("");
		}
		return lines;
	}
}

export function renderInlineMarkdown(text: string, mdTheme: MarkdownTheme, baseColor?: (t: string) => string): string {
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	const tokens = markdownParser.lexer(normalizeMarkdownSource(text));
	const applyText = baseColor ?? ((t: string) => t);
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		if (token.type === "paragraph" && token.tokens) {
			result += renderInlineTokens(token.tokens, mdTheme, applyText);
		} else if (token.type === "list") {
			result += token.items
				.map((item: Tokens.ListItem, index: number) => {
					const prefix = token.ordered ? `${(token.start || 1) + index}. ` : "• ";
					const content = item.tokens ? renderInlineTokens(item.tokens, mdTheme, applyText) : applyText(item.text);
					return `${applyText(prefix)}${content}`;
				})
				.join(applyText(" "));
		} else if ("text" in token && typeof token.text === "string") {
			result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
		}
	}
	return result;
}

function renderInlineTokens(tokens: Token[], mdTheme: MarkdownTheme, applyText: (t: string) => string): string {
	let result = "";
	const styleReset = applyText("");
	for (const token of collapseInlineHtml(tokens)) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		switch (token.type) {
			case "text":
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(token.tokens, mdTheme, applyText);
				} else {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
			case "strong":
				result += mdTheme.bold(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "em":
				result += mdTheme.italic(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "codespan":
				result += mdTheme.code(token.text) + styleReset;
				break;
			case "del":
				result += mdTheme.strikethrough(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "link": {
				const linkText = renderInlineTokens(token.tokens || [], mdTheme, applyText);
				result += mdTheme.link(mdTheme.underline(linkText)) + styleReset;
				break;
			}
			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					result += applyText(normalizeHtmlForTerminal(token.raw));
				}
				break;
			default:
				if ("text" in token && typeof token.text === "string") {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
		}
	}
	return result;
}
