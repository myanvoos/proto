import {
	AfterAgentResponseRequestResponseSchema,
	AfterAgentThoughtRequestResponseSchema,
	BeforeSubmitPromptRequestResponseSchema,
	type ExecuteHookRequest,
	type ExecuteHookResponse,
	ExecuteHookResponseSchema,
	type ExecuteHookResult,
	ExecuteHookResultSchema,
	type McpStateExecResult,
	McpStateExecResultSchema,
	McpStateServerSchema,
	McpStateSuccessSchema,
	type McpToolDefinition,
	PiBashExecErrorSchema,
	type PiBashExecResult,
	PiBashExecResultSchema,
	PiBashExecSuccessSchema,
	PiEditExecErrorSchema,
	PiEditExecRejectedSchema,
	type PiEditExecResult,
	PiEditExecResultSchema,
	PiEditExecSuccessSchema,
	PiFindExecErrorSchema,
	type PiFindExecResult,
	PiFindExecResultSchema,
	PiFindExecSuccessSchema,
	PiGrepExecErrorSchema,
	type PiGrepExecResult,
	PiGrepExecResultSchema,
	PiGrepExecSuccessSchema,
	PiLsExecErrorSchema,
	type PiLsExecResult,
	PiLsExecResultSchema,
	PiLsExecSuccessSchema,
	PiReadExecErrorSchema,
	type PiReadExecResult,
	PiReadExecResultSchema,
	PiReadExecSuccessSchema,
	type PiTruncation,
	PiTruncationSchema,
	PiWriteExecErrorSchema,
	PiWriteExecRejectedSchema,
	type PiWriteExecResult,
	PiWriteExecResultSchema,
	PiWriteExecSuccessSchema,
	PostToolUseFailureRequestResponseSchema,
	PostToolUseRequestResponseSchema,
	PreCompactRequestResponseSchema,
	PreToolUseRequestResponseSchema,
	StopRequestResponseSchema,
	SubagentStartRequestResponseSchema,
	SubagentStopRequestResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { ToolResultMessage } from "../../types";

export {
	cursorEditOwnedReadPath,
	cursorRawReadPath,
	omitUndefinedArgs,
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadDisplayPath,
	piReadPath,
	piReadPathHasRange,
	piTimeout,
} from "../cursor-pi-args";

export function piOutputText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function bagValue(bag: unknown, key: string): unknown {
	if (!bag || typeof bag !== "object" || !(key in bag)) return undefined;
	return Reflect.get(bag, key);
}

function detailCount(toolResult: ToolResultMessage, key: string): number | undefined {
	const value = bagValue(toolResult.details, key);
	return positiveCount(value);
}

function positiveCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resultLimitReached(toolResult: ToolResultMessage): number | undefined {
	const flat = detailCount(toolResult, "resultLimitReached");
	if (flat !== undefined) return flat;
	const limits = bagValue(bagValue(toolResult.details, "meta"), "limits");
	return positiveCount(bagValue(bagValue(limits, "resultLimit"), "reached"));
}

export function piTruncation(toolResult: ToolResultMessage): PiTruncation | undefined {
	const direct = bagValue(toolResult.details, "truncation");

	const truncation = direct !== undefined ? direct : bagValue(bagValue(toolResult.details, "meta"), "truncation");
	if (truncation === undefined || truncation === null) return undefined;

	const flag = bagValue(truncation, "truncated");
	if (flag !== undefined && flag !== true) return undefined;
	const truncatedBy = bagValue(truncation, "truncatedBy");
	const totalLines = bagValue(truncation, "totalLines");
	const outputLines = bagValue(truncation, "outputLines");
	const outputBytes = bagValue(truncation, "outputBytes");
	return create(PiTruncationSchema, {
		truncated: true,
		truncatedBy: typeof truncatedBy === "string" ? truncatedBy : "",
		totalLines: typeof totalLines === "number" ? totalLines : 0,
		outputLines: typeof outputLines === "number" ? outputLines : 0,
		outputBytes: typeof outputBytes === "number" ? outputBytes : 0,
		firstLineExceedsLimit: bagValue(truncation, "firstLineExceedsLimit") === true,
		lastLinePartial: bagValue(truncation, "lastLinePartial") === true,
	});
}

export function buildPiReadResult(toolResult: ToolResultMessage): PiReadExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiReadError(text || "Read failed");
	return create(PiReadExecResultSchema, {
		result: {
			case: "success",
			value: create(PiReadExecSuccessSchema, { output: text, truncation: piTruncation(toolResult) }),
		},
	});
}

export function buildPiReadError(error: string): PiReadExecResult {
	return create(PiReadExecResultSchema, {
		result: { case: "error", value: create(PiReadExecErrorSchema, { error }) },
	});
}

export function buildPiBashResult(toolResult: ToolResultMessage): PiBashExecResult {
	const text = piOutputText(toolResult);
	const truncation = piTruncation(toolResult);
	if (toolResult.isError) {
		return create(PiBashExecResultSchema, {
			result: {
				case: "error",
				value: create(PiBashExecErrorSchema, { error: text || "Command failed", truncation }),
			},
		});
	}
	return create(PiBashExecResultSchema, {
		result: {
			case: "success",
			value: create(PiBashExecSuccessSchema, { output: text, truncation }),
		},
	});
}

export function buildPiBashError(error: string): PiBashExecResult {
	return create(PiBashExecResultSchema, {
		result: { case: "error", value: create(PiBashExecErrorSchema, { error }) },
	});
}

export function buildPiEditResult(toolResult: ToolResultMessage): PiEditExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiEditError(text || "Edit failed");
	const diff = bagValue(toolResult.details, "diff");
	const patch = bagValue(toolResult.details, "patch");
	return create(PiEditExecResultSchema, {
		result: {
			case: "success",
			value: create(PiEditExecSuccessSchema, {
				output: text,
				diff: typeof diff === "string" ? diff : "",
				patch: typeof patch === "string" ? patch : "",
				firstChangedLine: detailCount(toolResult, "firstChangedLine"),
			}),
		},
	});
}

export function buildPiEditError(error: string): PiEditExecResult {
	return create(PiEditExecResultSchema, {
		result: { case: "error", value: create(PiEditExecErrorSchema, { error }) },
	});
}

export function buildPiEditRejected(reason: string): PiEditExecResult {
	return create(PiEditExecResultSchema, {
		result: { case: "rejected", value: create(PiEditExecRejectedSchema, { reason }) },
	});
}

export function buildPiWriteResult(toolResult: ToolResultMessage): PiWriteExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiWriteError(text || "Write failed");
	return create(PiWriteExecResultSchema, {
		result: { case: "success", value: create(PiWriteExecSuccessSchema, { output: text }) },
	});
}

export function buildPiWriteError(error: string): PiWriteExecResult {
	return create(PiWriteExecResultSchema, {
		result: { case: "error", value: create(PiWriteExecErrorSchema, { error }) },
	});
}

export function buildPiWriteRejected(reason: string): PiWriteExecResult {
	return create(PiWriteExecResultSchema, {
		result: { case: "rejected", value: create(PiWriteExecRejectedSchema, { reason }) },
	});
}

export function buildPiGrepResult(toolResult: ToolResultMessage): PiGrepExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiGrepError(text || "Grep failed");
	const matchLimitReached = detailCount(toolResult, "perFileLimitReached");
	return create(PiGrepExecResultSchema, {
		result: {
			case: "success",
			value: create(PiGrepExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult) ?? grepInternalCapTruncation(toolResult, text, matchLimitReached),
				matchLimitReached,
				linesTruncated: bagValue(toolResult.details, "linesTruncated") === true,
			}),
		},
	});
}

function grepInternalCapTruncation(
	toolResult: ToolResultMessage,
	text: string,
	matchLimitReached: number | undefined,
): PiTruncation | undefined {
	if (matchLimitReached !== undefined) return undefined;
	if (bagValue(toolResult.details, "truncated") !== true) return undefined;
	return create(PiTruncationSchema, {
		truncated: true,
		truncatedBy: "matches",
		totalLines: 0,
		outputLines: text ? text.split("\n").length : 0,
		outputBytes: Buffer.byteLength(text, "utf-8"),
		firstLineExceedsLimit: false,
		lastLinePartial: false,
	});
}

export function buildPiGrepError(error: string): PiGrepExecResult {
	return create(PiGrepExecResultSchema, {
		result: { case: "error", value: create(PiGrepExecErrorSchema, { error }) },
	});
}

export function buildPiFindResult(toolResult: ToolResultMessage): PiFindExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiFindError(text || "Find failed");
	return create(PiFindExecResultSchema, {
		result: {
			case: "success",
			value: create(PiFindExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult),
				resultLimitReached: resultLimitReached(toolResult),
			}),
		},
	});
}

export function buildPiFindError(error: string): PiFindExecResult {
	return create(PiFindExecResultSchema, {
		result: { case: "error", value: create(PiFindExecErrorSchema, { error }) },
	});
}

export function buildPiLsResult(toolResult: ToolResultMessage): PiLsExecResult {
	const text = piOutputText(toolResult);
	if (toolResult.isError) return buildPiLsError(text || "Ls failed");
	return create(PiLsExecResultSchema, {
		result: {
			case: "success",
			value: create(PiLsExecSuccessSchema, {
				output: text,
				truncation: piTruncation(toolResult),
				entryLimitReached: resultLimitReached(toolResult),
			}),
		},
	});
}

export function buildPiLsError(error: string): PiLsExecResult {
	return create(PiLsExecResultSchema, {
		result: { case: "error", value: create(PiLsExecErrorSchema, { error }) },
	});
}

export function buildMcpStateResult(
	tools: McpToolDefinition[],
	serverIdentifiers: readonly string[],
): McpStateExecResult {
	const byProvider = new Map<string, McpToolDefinition[]>();
	for (const tool of tools) {
		const identifier = tool.providerIdentifier;
		const existing = byProvider.get(identifier);
		if (existing) existing.push(tool);
		else byProvider.set(identifier, [tool]);
	}

	const wanted = serverIdentifiers.length > 0 ? new Set(serverIdentifiers) : undefined;
	const servers = [];
	for (const [identifier, serverTools] of byProvider) {
		if (wanted && !wanted.has(identifier)) continue;
		servers.push(
			create(McpStateServerSchema, {
				serverName: identifier,
				serverIdentifier: identifier,
				tools: serverTools,
				status: "connected",
			}),
		);
	}

	return create(McpStateExecResultSchema, {
		result: { case: "success", value: create(McpStateSuccessSchema, { servers }) },
	});
}

export function buildNeutralHookResult(request: ExecuteHookRequest | undefined): ExecuteHookResult | null {
	let response: ExecuteHookResponse;
	switch (request?.request.case) {
		case "preCompact":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preCompact", value: create(PreCompactRequestResponseSchema, {}) },
			});
			break;
		case "subagentStart":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStart", value: create(SubagentStartRequestResponseSchema, {}) },
			});
			break;
		case "subagentStop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStop", value: create(SubagentStopRequestResponseSchema, {}) },
			});
			break;
		case "preToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preToolUse", value: create(PreToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUse", value: create(PostToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUseFailure":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUseFailure", value: create(PostToolUseFailureRequestResponseSchema, {}) },
			});
			break;
		case "beforeSubmitPrompt":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "beforeSubmitPrompt", value: create(BeforeSubmitPromptRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentResponse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentResponse", value: create(AfterAgentResponseRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentThought":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentThought", value: create(AfterAgentThoughtRequestResponseSchema, {}) },
			});
			break;
		case "stop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "stop", value: create(StopRequestResponseSchema, {}) },
			});
			break;
		default:
			return null;
	}
	return create(ExecuteHookResultSchema, { response });
}
