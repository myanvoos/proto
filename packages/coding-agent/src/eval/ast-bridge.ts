import * as path from "node:path";
import {
	type AstFindResult,
	type AstReplaceResult,
	astEdit,
	astGrep,
	blockRangeAt,
	type SummaryResult,
	summarizeCode,
} from "@oh-my-pi/pi-natives";
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

export const EVAL_AST_BRIDGE_NAME = "__ast__";

export type EvalAstSymbols = SummaryResult;

export interface EvalAstBlockRange {
	start: number;
	end: number;
}

export interface EvalAstBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

const PARSE_SUSPECT_FILE_CAP = 200;

/** Identifier-ish literals a pattern must contain, with metavariables removed. */
function patternLiterals(patterns: string[]): string[] {
	const literals = new Set<string>();
	for (const pattern of patterns) {
		for (const token of pattern.replace(/\$+\w*/gu, " ").match(/[A-Za-z_]\w{2,}/gu) ?? []) {
			literals.add(token);
		}
	}
	return [...literals];
}

/**
 * Files whose syntax tree had errors are skipped entirely, so a rename can miss
 * real call sites. Name the skipped files that still contain the pattern text:
 * that turns "23 files were skipped" into the two worth opening by hand.
 */
async function parseSuspects(parseErrors: string[] | undefined, patterns: string[], root: string): Promise<string[]> {
	if (!parseErrors?.length) return [];
	const literals = patternLiterals(patterns);
	if (literals.length === 0) return [];
	const suspects: string[] = [];
	for (const entry of parseErrors.slice(0, PARSE_SUSPECT_FILE_CAP)) {
		const relative = entry.split(": ", 1)[0];
		if (!relative) continue;
		try {
			const text = await Bun.file(path.isAbsolute(relative) ? relative : path.join(root, relative)).text();
			if (literals.some(literal => text.includes(literal))) suspects.push(relative);
		} catch {
			// Unreadable here just means we cannot vouch for it; the file still
			// shows up in the skipped list the caller already gets.
		}
	}
	return suspects;
}
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalCount(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${key} must be an integer >= 1`);
	}
	return value;
}

function patternList(record: Record<string, unknown>): string[] {
	const value = record.patterns;
	if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== "string")) {
		throw new Error("ast grep expects { patterns: string[] } with at least one pattern");
	}
	return value as string[];
}
export type EvalAstParseAnnotations = { parseSuspects: string[] };
export type EvalAstResult =
	| EvalAstBlockRange
	| SummaryResult
	| (AstFindResult & EvalAstParseAnnotations)
	| (AstReplaceResult & EvalAstParseAnnotations)
	| null;

export async function runEvalAst(args: unknown, _options: EvalAstBridgeOptions): Promise<EvalAstResult> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		throw new Error("ast bridge expects an object payload");
	}
	const record = args as Record<string, unknown>;
	if (record.op === "symbols") {
		const symbolsCode = record.code;
		const symbolsPath = record.path;
		const symbolsLang = record.lang;
		if (typeof symbolsCode !== "string") {
			throw new Error("symbols expects { code: string } and optional path/lang: string");
		}
		return summarizeCode({
			code: symbolsCode,
			...(typeof symbolsPath === "string" && symbolsPath.length > 0 ? { path: symbolsPath } : {}),
			...(typeof symbolsLang === "string" && symbolsLang.length > 0 ? { lang: symbolsLang } : {}),
		});
	}
	if (record.op === "grep") {
		const patterns = patternList(record);
		const searchRoot = optionalString(record, "path") ?? process.cwd();
		const found = await astGrep({
			patterns,
			includeMeta: true,
			...(optionalString(record, "lang") ? { lang: optionalString(record, "lang")! } : {}),
			...(optionalString(record, "path") ? { path: optionalString(record, "path")! } : {}),
			...(optionalString(record, "glob") ? { glob: optionalString(record, "glob")! } : {}),
			...(optionalCount(record, "limit") !== undefined ? { limit: optionalCount(record, "limit")! } : {}),
		});
		return { ...found, parseSuspects: await parseSuspects(found.parseErrors, patterns, searchRoot) };
	}
	if (record.op === "edit") {
		const rewrites = record.rewrites;
		if (!rewrites || typeof rewrites !== "object" || Array.isArray(rewrites)) {
			throw new Error("ast edit expects { rewrites: Record<string, string> }");
		}
		const entries = Object.entries(rewrites as Record<string, unknown>);
		if (entries.length === 0 || entries.some(([, value]) => typeof value !== "string")) {
			throw new Error("ast edit rewrites must map each pattern to a replacement string");
		}
		// Always a dry run: the kernel applies the returned edits through its own
		// audited writes so mutation notes and the stale-write guard still fire.
		const editRoot = optionalString(record, "path") ?? process.cwd();
		const replaced = await astEdit({
			rewrites: Object.fromEntries(entries) as Record<string, string>,
			dryRun: true,
			...(optionalString(record, "lang") ? { lang: optionalString(record, "lang")! } : {}),
			...(optionalString(record, "path") ? { path: optionalString(record, "path")! } : {}),
			...(optionalString(record, "glob") ? { glob: optionalString(record, "glob")! } : {}),
			...(optionalCount(record, "maxFiles") !== undefined ? { maxFiles: optionalCount(record, "maxFiles")! } : {}),
		});
		return {
			...replaced,
			parseSuspects: await parseSuspects(
				replaced.parseErrors,
				entries.map(([pattern]) => pattern),
				editRoot,
			),
		};
	}
	if (record.op !== "block_range") {
		throw new Error(`unknown ast bridge op: ${String(record.op)}`);
	}
	const { code, line } = record;
	const path = record.path;
	if (typeof code !== "string" || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
		throw new Error("block_range expects { code: string, line: number >= 1 } and optional path: string");
	}
	const range = blockRangeAt({
		code,
		line,
		...(typeof path === "string" && path.length > 0 ? { path } : {}),
	});
	return range ? { start: range.startLine, end: range.endLine } : null;
}
