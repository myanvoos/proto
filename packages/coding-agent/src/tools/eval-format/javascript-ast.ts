import { codeOutline, supportsLanguage } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
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

function toOutlineNode(entry: {
	kind: string;
	modifier?: string | null;
	name?: string | null;
	detail?: string | null;
	doc?: string | null;
	notes?: Array<string> | null;
	asks?: Array<string> | null;
	line: number;
	children: Array<Record<string, unknown>> | null;
}): OutlineNode {
	const node: OutlineNode = {
		kind: entry.kind,
		line: entry.line,
		children: (entry.children ?? []).map(child => toOutlineNode(child as Parameters<typeof toOutlineNode>[0])),
	};
	if (entry.modifier) node.modifier = entry.modifier;
	if (entry.name) node.name = entry.name;
	if (entry.detail) node.detail = entry.detail;
	if (entry.doc) node.doc = entry.doc;
	if (entry.notes && entry.notes.length > 0) node.notes = entry.notes;
	if (entry.asks && entry.asks.length > 0) node.questions = entry.asks;
	return node;
}

function parseOutline(source: string): OutlineNode[] | null {
	if (!supportsLanguage("js")) return null;
	const result = codeOutline({ code: source, lang: "js" });
	if (!result.parsed) return null;
	return result.entries.map(toOutlineNode);
}

const outlineMemo = new Map<string, OutlineNode[] | null>();

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
	if (outlineMemo.size > 8) outlineMemo.clear();
	outlineMemo.set(source, result);
	return result;
}

export function renderJavaScriptAstLines(source: string, theme: Theme, width: number): string[] | null {
	const entries = parseMemoized(source);
	if (!entries || entries.length === 0) return null;
	const root: OutlineNode = { kind: "Module", line: 1, children: entries };
	return renderOutlineLines(root, theme, width, { headerKinds: JS_HEADER_KINDS, augKinds: JS_AUG_KINDS });
}
