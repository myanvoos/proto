import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { supportsAllTurnsReasoningContext, supportsCodexReasoningSummary } from "@oh-my-pi/pi-catalog/identity";
import { requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { $env } from "@oh-my-pi/pi-utils";
import type { Model } from "../../types";
import { mapOpenAIReasoningEffort } from "../openai-shared";

export type CodexReasoningContext = "auto" | "current_turn" | "all_turns";

type CodexCallerEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_BY_NAME: Record<CodexCallerEffort, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary?: "auto" | "concise" | "detailed";
	context?: CodexReasoningContext;

	mode?: "pro";
}

export interface CodexRequestOptions {
	reasoningEffort?: CodexCallerEffort | "none";

	reasoningOff?: boolean;
	reasoningSummary?: ReasoningConfig["summary"] | null;

	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];

	responsesLite?: boolean;
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
	action?: unknown;
	actions?: unknown;
	pending_safety_checks?: unknown;
	acknowledged_safety_checks?: unknown;

	tools?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;

	stream_options?: { reasoning_summary_delivery: "sequential_cutoff" };

	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	client_metadata?: Record<string, string>;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	[key: string]: unknown;
}

export function resolveCodexResponsesLite(
	model: Model<"openai-codex-responses">,
	requested: boolean | undefined,
): boolean {
	if (requested !== undefined) return requested;
	const env = $env.PI_CODEX_RESPONSES_LITE?.trim().toLowerCase();
	if (env === "1" || env === "true") return true;
	if (env === "0" || env === "false") return false;
	return model.useResponsesLite === true;
}

function concurrentSummariesEnabled(): boolean {
	const env = $env.PI_CODEX_CONCURRENT_SUMMARIES?.trim().toLowerCase();
	return env === "1" || env === "true";
}

function mapCodexWireEffort(
	model: Model<"openai-codex-responses">,
	effort: CodexCallerEffort,
): ReasoningConfig["effort"] {
	const mapped = mapOpenAIReasoningEffort(model, model.compat, requireSupportedEffort(model, EFFORT_BY_NAME[effort]));
	switch (mapped) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return mapped;
		default:
			throw new Error(
				`Effort map for ${model.provider}/${model.id} produced invalid Codex reasoning effort "${mapped}"`,
			);
	}
}

function getReasoningConfig(
	model: Model<"openai-codex-responses">,
	effort: NonNullable<CodexRequestOptions["reasoningEffort"]>,
	options: CodexRequestOptions,
): ReasoningConfig {
	const config: ReasoningConfig = {
		effort: effort === "none" ? "none" : mapCodexWireEffort(model, effort),
	};

	if (options.reasoningSummary !== null && supportsCodexReasoningSummary(model.id)) {
		config.summary = options.reasoningSummary ?? "auto";
	}
	return config;
}

function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter(item => item.type !== "item_reference")
		.map(item => {
			if (item.type === "computer_call") return item;
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

const CODEX_ORPHAN_OUTPUT_LIMIT = 16_000;

const CODEX_INTERRUPTED_TOOL_OUTPUT =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

function orphanFunctionOutputToMessage(item: InputItem, callId: string): InputItem {
	const itemRecord = item as unknown as Record<string, unknown>;
	const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
	let text = "";
	try {
		const output = itemRecord.output;
		text = typeof output === "string" ? output : JSON.stringify(output);
	} catch {
		text = String(itemRecord.output ?? "");
	}
	if (text.length > CODEX_ORPHAN_OUTPUT_LIMIT) {
		text = `${text.slice(0, CODEX_ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
	} as InputItem;
}

type ToolCallKind = "function" | "custom" | "computer";

function toolCallKind(type: unknown): ToolCallKind | undefined {
	if (type === "function_call") return "function";
	if (type === "custom_tool_call") return "custom";
	if (type === "computer_call") return "computer";
	return undefined;
}

function toolOutputKind(type: unknown): ToolCallKind | undefined {
	if (type === "function_call_output") return "function";
	if (type === "custom_tool_call_output") return "custom";
	if (type === "computer_call_output") return "computer";
	return undefined;
}

function repairToolCallPairs(input: InputItem[]): InputItem[] {
	const callKinds = new Map<string, ToolCallKind>();
	const outputKinds = new Map<string, ToolCallKind>();
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		if (callId === undefined) continue;
		const callKind = toolCallKind(item.type);
		const outputKind = toolOutputKind(item.type);
		if (callKind) callKinds.set(callId, callKind);
		if (outputKind) outputKinds.set(callId, outputKind);
	}

	const repaired: InputItem[] = [];
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		const callKind = toolCallKind(item.type);
		const outputKind = toolOutputKind(item.type);

		if (outputKind && callId !== undefined && callKinds.get(callId) !== outputKind) {
			repaired.push(orphanFunctionOutputToMessage(item, callId));
			continue;
		}
		if (callKind && callId !== undefined && outputKinds.get(callId) !== callKind) {
			if (callKind === "computer") {
				repaired.push({
					type: "message",
					role: "assistant",
					content: `[Computer call interrupted before a screenshot was recorded; call_id=${callId}]`,
				});
				continue;
			}
			repaired.push(item, {
				type: callKind === "custom" ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output: CODEX_INTERRUPTED_TOOL_OUTPUT,
			});
			continue;
		}
		repaired.push(item);
	}
	return repaired;
}

function stripImageDetails(input: unknown[]): void {
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const content = "content" in item ? item.content : undefined;
		const output = "output" in item ? item.output : undefined;
		for (const collection of [content, output]) {
			if (!Array.isArray(collection)) continue;
			for (const part of collection) {
				if (!part || typeof part !== "object") continue;
				if (!("type" in part) || part.type !== "input_image") continue;
				if ("detail" in part) part.detail = undefined;
			}
		}
	}
}

export interface CodexLiteShapedBody {
	instructions?: unknown;
	tools?: unknown;
	tool_choice?: unknown;
	input?: unknown;
	parallel_tool_calls?: unknown;
}

export function applyCodexResponsesLiteShape(body: CodexLiteShapedBody): void {
	const input = Array.isArray(body.input) ? body.input : [];
	stripImageDetails(input);
	body.parallel_tool_calls = false;
	const declaredTools = Array.isArray(body.tools) ? body.tools : [];
	let additionalTools = declaredTools;
	if (body.tool_choice && typeof body.tool_choice === "object" && "type" in body.tool_choice) {
		const choice = body.tool_choice;
		const selected = declaredTools.find(tool => {
			if (tool === null || typeof tool !== "object" || !("type" in tool)) return false;
			if (choice.type === "computer") return tool.type === "computer";
			return (
				choice.type === "function" &&
				tool.type === "function" &&
				"name" in choice &&
				typeof choice.name === "string" &&
				"name" in tool &&
				tool.name === choice.name
			);
		});
		if (selected) {
			additionalTools = [selected];
			body.tool_choice = "required";
		}
	}
	const prefix: InputItem[] = [{ type: "additional_tools", role: "developer", tools: additionalTools }];
	if (typeof body.instructions === "string" && body.instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: body.instructions }],
		});
	}
	body.input = [...prefix, ...input];
	if (body.tool_choice !== "none" && body.tool_choice !== "required") {
		body.tool_choice = "auto";
	}
	delete body.instructions;
	delete body.tools;
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);
		if (body.input) {
			body.input = repairToolCallPairs(body.input);
		}
	}

	if (prompt?.developerMessages && prompt.developerMessages.length > 0) {
		const developerMessages: InputItem[] = prompt.developerMessages.map(text => ({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text }],
		}));
		const input = Array.isArray(body.input) ? body.input : [];
		body.input = [...developerMessages, ...input];
	}

	let finalInstruction = prompt?.developerMessages.findLast(text => text.trim().length > 0);
	if (finalInstruction === undefined && Array.isArray(body.input)) {
		for (let itemIndex = body.input.length - 1; itemIndex >= 0; itemIndex -= 1) {
			const item = body.input[itemIndex];
			if (item.role !== "developer" || !Array.isArray(item.content)) continue;
			for (let partIndex = item.content.length - 1; partIndex >= 0; partIndex -= 1) {
				const part = item.content[partIndex];
				if (
					part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "input_text" &&
					"text" in part &&
					typeof part.text === "string" &&
					part.text.trim().length > 0
				) {
					finalInstruction = part.text;
					break;
				}
			}
			if (finalInstruction !== undefined) break;
		}
	}
	if (finalInstruction === undefined && typeof body.instructions === "string" && body.instructions.trim().length > 0) {
		finalInstruction = body.instructions;
	}
	if (finalInstruction !== undefined) {
		const input = Array.isArray(body.input) ? body.input : [];
		let hasVisibleInput = false;
		for (const item of input) {
			if (item.role !== "developer") {
				hasVisibleInput = true;
				break;
			}
		}
		if (!hasVisibleInput) {
			body.input = [
				...input,
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: finalInstruction }],
				},
			];
		}
	}

	const responsesLite = resolveCodexResponsesLite(model, options.responsesLite);
	if (responsesLite) {
		applyCodexResponsesLiteShape(body);
	}

	if (options.reasoningOff || options.reasoningEffort !== undefined || responsesLite) {
		const reasoningConfig: Partial<ReasoningConfig> = options.reasoningOff
			? { effort: "none" }
			: options.reasoningEffort !== undefined
				? getReasoningConfig(model, options.reasoningEffort, options)
				: {};
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};

		if (responsesLite) {
			body.reasoning.context = "all_turns";
		} else if (options.reasoningContext !== undefined) {
			if (options.reasoningContext === "all_turns" && !supportsAllTurnsReasoningContext(model.id)) {
				delete body.reasoning.context;
			} else {
				body.reasoning.context = options.reasoningContext;
			}
		}
	} else {
		delete body.reasoning;
	}

	if (model.reasoningMode && !options.reasoningOff) {
		body.reasoning = { ...body.reasoning, mode: model.reasoningMode };
	}

	if (body.reasoning?.summary !== undefined && concurrentSummariesEnabled()) {
		body.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
	} else {
		delete body.stream_options;
	}

	if (options.textVerbosity !== undefined) {
		body.text = {
			...body.text,
			verbosity: options.textVerbosity,
		};
	}

	const include = Array.isArray(options.include) ? [...options.include] : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
