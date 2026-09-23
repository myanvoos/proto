import { INTENT_FIELD } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Repeats after which the run is stopped outright; 0 disables the ceiling. */
	readonly hardLimit?: number;
}

export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	/** `steer` asks the model to break the loop; `stop` means the run must not continue. */
	readonly severity: "steer" | "stop";
	readonly toolName: string;
	readonly count: number;
	readonly hardLimit: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

export class ToolCallLoopGuard {
	#threshold: number;
	#hardLimit: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		const hardLimit = Math.trunc(options.hardLimit ?? 0);
		this.#hardLimit = hardLimit > 0 ? Math.max(hardLimit, this.#threshold) : 0;
		this.#exemptTools = new Set(options.exemptTools);
	}

	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0 || toolCalls.every(toolCall => this.#exemptTools.has(toolCall.name))) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}

		const canonicalCalls = toolCalls
			.map(toolCall => JSON.stringify([toolCall.name, canonicalizeToolCallValue(toolCall.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		// Reporting only at the threshold left every later repeat unguarded, which is
		// how one bad tool call turned into thousands of provider requests.
		if (this.#count < this.#threshold) return null;
		const reportCall = toolCalls.find(toolCall => !this.#exemptTools.has(toolCall.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			severity: this.#hardLimit > 0 && this.#count >= this.#hardLimit ? "stop" : "steer",
			toolName: reportCall.name,
			count: this.#count,
			hardLimit: this.#hardLimit,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
