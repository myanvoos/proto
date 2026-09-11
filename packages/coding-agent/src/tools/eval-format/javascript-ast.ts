import { codeOutline, type OutlineEntry, supportsLanguage } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Theme } from "../../modes/theme/theme";
import { type OutlineNode, renderOutlineLines } from "./outline-render";

const JS_HEADER_KINDS = new Set([
	"function",
	"async function",
	"fn",
	"class",
	"method",
	"interface",
	"enum",
	"type",
	"if",
	"else",
	"else if",
	"for",
	"for await",
	"while",
	"do",
	"switch",
	"case",
	"default",
	"try",
	"catch",
	"finally",
]);

const JS_AUG_KINDS = new Set([
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"&&=",
	"||=",
	"??=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	">>>=",
]);

function toOutlineNode(entry: OutlineEntry): OutlineNode {
	const node: OutlineNode = { kind: entry.kind, line: entry.line, children: entry.children.map(toOutlineNode) };
	if (entry.modifier) node.modifier = entry.modifier;
	if (entry.name) node.name = entry.name;
	if (entry.detail) node.detail = entry.detail;
	if (entry.doc) node.doc = entry.doc;
	if (entry.notes.length > 0) node.notes = entry.notes;
	if (entry.asks.length > 0) node.questions = entry.asks;
	return node;
}

function parseOutline(source: string): OutlineNode[] | null {
	if (!supportsLanguage("js")) return null;
	const result = codeOutline({ code: source, lang: "js" });
	if (!result.parsed) return null;
	return result.entries.map(toOutlineNode);
}

const OUTLINE_CACHE_MAX = 512;
const OUTLINE_CACHE_MAX_SIZE = 16 * 1024 * 1024;
const OUTLINE_CACHE_MAX_ENTRY_SIZE = 2 * 1024 * 1024;

function outlineCacheEntrySize(value: OutlineNode[] | null, key: string): number {
	let size = key.length + 1;
	if (value === null) return size;
	const pending = value.slice();
	while (pending.length > 0) {
		const node = pending.pop()!;
		size += 32 + node.kind.length + (node.modifier?.length ?? 0) + (node.name?.length ?? 0);
		size += node.detail?.length ?? 0;
		size += node.doc?.length ?? 0;
		for (const note of node.notes ?? []) size += note.length;
		for (const question of node.questions ?? []) size += question.length;
		for (const child of node.children) pending.push(child);
	}
	return size;
}

const outlineMemo = new LRUCache<string, OutlineNode[] | null>({
	max: OUTLINE_CACHE_MAX,
	maxSize: OUTLINE_CACHE_MAX_SIZE,
	maxEntrySize: OUTLINE_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: outlineCacheEntrySize,
});

function parseMemoized(source: string): OutlineNode[] | null {
	const hit = outlineMemo.get(source);
	if (hit !== undefined) return hit;
	let result: OutlineNode[] | null = null;
	try {
		result = parseOutline(source);
	} catch (error) {
		logger.debug("JS outline parse failed", { error: String(error) });
		result = null;
	}
	outlineMemo.set(source, result);
	return result;
}

export function renderJavaScriptAstLines(source: string, theme: Theme, width: number): string[] | null {
	const entries = parseMemoized(source);
	if (!entries || entries.length === 0) return null;
	const root: OutlineNode = { kind: "Module", line: 1, children: entries };
	return renderOutlineLines(root, theme, width, { headerKinds: JS_HEADER_KINDS, augKinds: JS_AUG_KINDS });
}
