import { blockRangeAt, type SummaryResult, summarizeCode } from "@oh-my-pi/pi-natives";
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

export function runEvalAst(args: unknown, _options: EvalAstBridgeOptions): EvalAstBlockRange | SummaryResult | null {
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
