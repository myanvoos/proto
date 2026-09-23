import type { ProviderInputTransformation, TokenTaskBudget } from "../types";
import { isRecord } from "../utils";

export const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

export type CacheControlEphemeral = {
	type: "ephemeral";
	ttl?: "1h" | "5m";

	scope?: "global";
};

export type Base64ImageSource = {
	type: "base64";
	media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	data: string;
};

export type URLImageSource = { type: "url"; url: string };

export type FileImageSource = { type: "file"; file_id: string };

export type ImageSource = Base64ImageSource | URLImageSource | FileImageSource;

export type TextBlockParam = {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral | null;
};

export type ImageBlockParam = {
	type: "image";
	source: ImageSource;
	cache_control?: CacheControlEphemeral | null;
};

export type ToolUseBlockParam = {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
	cache_control?: CacheControlEphemeral | null;
};

export type ToolResultBlockParam = {
	type: "tool_result";
	tool_use_id: string;
	content?: string | Array<TextBlockParam | ImageBlockParam>;
	is_error?: boolean;
	cache_control?: CacheControlEphemeral | null;
};

export type ServerToolUseBlockParam = {
	type: "server_tool_use";
	id: string;
	name: string;
	input?: Record<string, unknown> | null;
	[key: string]: unknown;
};

export type WebSearchServerToolUseBlockParam = ServerToolUseBlockParam & { name: "web_search" };

export type ToolSearchServerToolUseBlockParam = ServerToolUseBlockParam & {
	name: "tool_search_tool_regex" | "tool_search_tool_bm25";
};

export type WebSearchToolResultBlockParam = {
	type: "web_search_tool_result";
	tool_use_id: string;
	content: unknown;
	[key: string]: unknown;
};

export type ToolSearchToolResultBlockParam = {
	type: "tool_search_tool_result";
	tool_use_id: string;
	content: unknown;
	[key: string]: unknown;
};

export type ToolChangeReferenceParam = {
	type: "tool_reference";
	name: string;
};

export type ToolAdditionBlockParam = {
	type: "tool_addition";
	tool: ToolChangeReferenceParam;
};

export type ToolRemovalBlockParam = {
	type: "tool_removal";
	tool: ToolChangeReferenceParam;
};

export type AnthropicServerToolHistoryBlockParam =
	| WebSearchServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchServerToolUseBlockParam
	| ToolSearchToolResultBlockParam;

export function isAnthropicServerToolHistoryBlock(block: {
	type: string;
	name?: unknown;
	id?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
}): block is AnthropicServerToolHistoryBlockParam {
	if (block.type === "server_tool_use") {
		const supportedName =
			block.name === "web_search" ||
			block.name === "tool_search_tool_regex" ||
			block.name === "tool_search_tool_bm25";
		return supportedName && typeof block.id === "string" && block.id.length > 0;
	}
	if (block.type === "web_search_tool_result" || block.type === "tool_search_tool_result") {
		return typeof block.tool_use_id === "string" && block.tool_use_id.length > 0 && Object.hasOwn(block, "content");
	}
	return false;
}

export type ThinkingBlockParam = {
	type: "thinking";
	thinking: string;
	signature: string;
};

export type RedactedThinkingBlockParam = {
	type: "redacted_thinking";
	data: string;
};

export type FallbackBlockParam = {
	type: "fallback";
	from: { model: string };
	to: { model: string };
};

export const COMPACTION_BETA = "compact-2026-01-12";

export type CompactionBlockParam = {
	type: "compaction";
	content: string;
	encrypted_content?: string | null;
	cache_control?: CacheControlEphemeral | null;
};

export type ContentBlockParam =
	| TextBlockParam
	| ImageBlockParam
	| ToolUseBlockParam
	| ToolResultBlockParam
	| ServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchToolResultBlockParam
	| ToolAdditionBlockParam
	| ToolRemovalBlockParam
	| ThinkingBlockParam
	| RedactedThinkingBlockParam
	| FallbackBlockParam
	| CompactionBlockParam;

export type MessageParam = {
	role: "user" | "assistant" | "system";
	content: string | ContentBlockParam[];
	clear_at?: "never" | "next_user_message";
	output_config?: OutputConfig;
};

export type ToolInputSchema = {
	type: "object";
	properties?: unknown | null;
	required?: string[] | null;
	[k: string]: unknown;
};

export type Tool = {
	name: string;
	description?: string;
	input_schema: ToolInputSchema;
	cache_control?: CacheControlEphemeral | null;

	strict?: boolean;

	eager_input_streaming?: boolean;
	defer_loading?: boolean;
};

export type ToolChoiceAuto = { type: "auto"; disable_parallel_tool_use?: boolean };
export type ToolChoiceAny = { type: "any"; disable_parallel_tool_use?: boolean };
export type ToolChoiceTool = { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
export type ToolChoiceNone = { type: "none" };

export type ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | ToolChoiceNone;

export type Metadata = { user_id?: string | null };

export type ThinkingBlockBinding = {
	prefix_mismatch_behavior: "drop_block" | "error";
};

export type ThinkingConfigEnabled = {
	type: "enabled";
	budget_tokens: number;

	display?: "summarized" | "omitted";
	block_binding?: ThinkingBlockBinding;
};

export type ThinkingConfigDisabled = { type: "disabled" };

export type ThinkingConfigAdaptive = {
	type: "adaptive";

	display?: "summarized" | "omitted";
	block_binding?: ThinkingBlockBinding;
};

export type ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled | ThinkingConfigAdaptive;

export type OutputConfig = {
	effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;

	task_budget?: TokenTaskBudget | null;
};

export type FallbackParam = {
	model: string;
	max_tokens?: number;
	thinking?: ThinkingConfigParam;
	output_config?: OutputConfig;
	speed?: "fast";
};

export type CompactionEdit = {
	type: "compact_20260112";
	trigger?: { type: "input_tokens"; value: number };
	pause_after_compaction?: boolean;
	instructions?: string;
};

export type ContextManagement = {
	edits: Array<{ type: "clear_thinking_20251015"; keep: "all" } | CompactionEdit>;
};

export type MessageCreateParams = {
	model: string;
	messages: MessageParam[];
	max_tokens: number;
	system?: string | TextBlockParam[];
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: Tool[];
	tool_choice?: ToolChoice;
	metadata?: Metadata;
	thinking?: ThinkingConfigParam;
	output_config?: OutputConfig;

	speed?: "fast";

	context_management?: ContextManagement;

	anthropic_beta?: string[];

	fallbacks?: FallbackParam[];
};

export type MessageCreateParamsStreaming = MessageCreateParams & { stream: true };

export type StopReason =
	| "end_turn"
	| "max_tokens"
	| "stop_sequence"
	| "tool_use"
	| "pause_turn"
	| "refusal"
	| "sensitive"
	| "model_context_window_exceeded"
	| "compaction";

export type CacheCreation = {
	ephemeral_5m_input_tokens?: number | null;
	ephemeral_1h_input_tokens?: number | null;
};

export type ServerToolUsage = {
	web_search_requests?: number | null;
	web_fetch_requests?: number | null;
};

export type UsageIteration = {
	type?: "message" | "fallback_message" | "compaction" | string;
	model?: string | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

export type Usage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: CacheCreation | null;
	server_tool_use?: ServerToolUsage | null;
	iterations?: UsageIteration[] | null;
};

export type InputTransformation = {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
};

export function parseAnthropicInputTransformations(value: unknown): ProviderInputTransformation[] {
	if (!Array.isArray(value)) return [];
	const transformations: ProviderInputTransformation[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.type !== "string") continue;
		transformations.push({ ...entry, type: entry.type });
	}
	return transformations;
}

export type ResponseMessage = {
	id: string;
	type?: "message";
	role?: "assistant";
	model?: string;
	content?: unknown[];
	stop_reason?: StopReason | null;
	stop_sequence?: string | null;
	input_transformations?: InputTransformation[];
	usage: Usage;
};

export type ResponseContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature?: string }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> | null }
	| ServerToolUseBlockParam
	| WebSearchToolResultBlockParam
	| ToolSearchToolResultBlockParam
	| { type: "fallback"; from: { model: string }; to: { model: string } }
	| { type: "compaction"; content?: string | null; encrypted_content?: string | null };

export type ContentBlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "input_json_delta"; partial_json: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "signature_delta"; signature: string }
	| { type: "compaction_delta"; content?: string | null; encrypted_content?: string | null };

export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
};

export type MessageDelta = {
	stop_reason?: StopReason | null;
	stop_sequence?: string | null;
	stop_details?: StopDetails | null;
};

export type RawMessageStartEvent = { type: "message_start"; message: ResponseMessage };
export type RawContentBlockStartEvent = {
	type: "content_block_start";
	index: number;
	content_block: ResponseContentBlock;
};
export type RawContentBlockDeltaEvent = { type: "content_block_delta"; index: number; delta: ContentBlockDelta };
export type RawContentBlockStopEvent = { type: "content_block_stop"; index: number };
export type RawMessageDeltaEvent = {
	type: "message_delta";
	delta: MessageDelta;
	usage: Usage;
	input_transformations?: InputTransformation[];
};
export type RawMessageStopEvent = { type: "message_stop" };

export type RawMessageStreamEvent =
	| RawMessageStartEvent
	| RawContentBlockStartEvent
	| RawContentBlockDeltaEvent
	| RawContentBlockStopEvent
	| RawMessageDeltaEvent
	| RawMessageStopEvent;
