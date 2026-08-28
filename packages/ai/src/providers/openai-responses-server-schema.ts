import { type } from "@oh-my-pi/omptype";
import type {
	EasyInputMessage,
	ResponseCreateParams,
	ResponseFunctionToolCall,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	Tool as ResponsesTool,
} from "./openai-responses-wire";

const inputTextSchema = type({
	type: "'input_text'",
	text: "string",
});

const plainTextSchema = type({
	type: "'text'",
	text: "string",
});

const inputImageBlockSchema = type({
	type: "'input_image'",
	"detail?": "'auto' | 'low' | 'high' | 'original'",
	"image_url?": "string",
	"file_id?": "string",
}).narrow((v, ctx) => {
	return (
		typeof v.image_url === "string" ||
		typeof v.file_id === "string" ||
		ctx.mustBe("at least one of `image_url` or `file_id` for input_image")
	);
});

const inputFileBlockSchema = type({
	type: "'input_file'",
	"file_id?": "string",
	"filename?": "string",
	"file_data?": "string",
	"file_url?": "string",
});

const outputTextSchema = type({
	type: "'output_text'",
	text: "string",
});

const outputRefusalSchema = type({
	type: "'refusal'",
	refusal: "string",
});

const summaryTextSchema = type({
	type: "'summary_text'",
	text: "string",
});

const reasoningTextSchema = type({
	type: "'reasoning_text'",
	text: "string",
});

const inputContentBlockSchema = inputTextSchema.or(plainTextSchema).or(inputImageBlockSchema).or(inputFileBlockSchema);

const outputContentBlockSchema = outputTextSchema.or(plainTextSchema).or(outputRefusalSchema);

const userMessageItemSchema = type({
	"type?": "'message'",
	role: "'user' | 'developer'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const systemMessageItemSchema = type({
	"type?": "'message'",
	role: "'system'",
	"content?": type("string").or(inputContentBlockSchema.array()),
});

const assistantMessageItemSchema = type({
	"type?": "'message'",
	"id?": "string",
	role: "'assistant'",
	"content?": type("string").or(outputContentBlockSchema.array()),
	"status?": "'in_progress' | 'completed' | 'incomplete'",
	"phase?": "'commentary' | 'final_answer' | null",
});

const reasoningItemSchema = type({
	type: "'reasoning'",
	"id?": "string",
	"summary?": summaryTextSchema.array(),
	"content?": reasoningTextSchema.array(),
});

const functionCallItemSchema = type({
	type: "'function_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",
	"arguments?": "string",
});

const functionCallOutputItemSchema = type({
	type: "'function_call_output'",
	call_id: "string >= 1",

	"output?": type("string").or(outputContentBlockSchema.array()),
});

const customToolCallItemSchema = type({
	type: "'custom_tool_call'",
	"id?": "string",
	call_id: "string >= 1",
	name: "string >= 1",

	input: "string",
});

const customToolCallOutputItemSchema = type({
	type: "'custom_tool_call_output'",
	call_id: "string >= 1",
	output: "string",
});

const computerSafetyCheckSchema = type({
	id: "string >= 1",
	"code?": "string | null",
	"message?": "string | null",
});

const computerCoordinate = type("0 <= number.integer <= 2147483647");
const computerScrollDelta = type("-2147483648 <= number.integer <= 2147483647");

const computerClickActionSchema = type({
	type: "'click'",
	button: "'left' | 'right' | 'wheel' | 'back' | 'forward'",
	x: computerCoordinate,
	y: computerCoordinate,
	"keys?": "string[] | null",
});

const computerDoubleClickActionSchema = type({
	type: "'double_click'",
	x: computerCoordinate,
	y: computerCoordinate,
	keys: "string[] | null",
});

const computerDragActionSchema = type({
	type: "'drag'",
	path: type({ x: computerCoordinate, y: computerCoordinate }).array(),
	"keys?": "string[] | null",
});

const computerKeypressActionSchema = type({ type: "'keypress'", keys: "string[]" });
const computerMoveActionSchema = type({
	type: "'move'",
	x: computerCoordinate,
	y: computerCoordinate,
	"keys?": "string[] | null",
});
const computerScreenshotActionSchema = type({ type: "'screenshot'" });
const computerScrollActionSchema = type({
	type: "'scroll'",
	x: computerCoordinate,
	y: computerCoordinate,
	scroll_x: computerScrollDelta,
	scroll_y: computerScrollDelta,
	"keys?": "string[] | null",
});
const computerTypeActionSchema = type({ type: "'type'", text: "string" });
const computerWaitActionSchema = type({ type: "'wait'" });

const computerActionSchema = computerClickActionSchema
	.or(computerDoubleClickActionSchema)
	.or(computerDragActionSchema)
	.or(computerKeypressActionSchema)
	.or(computerMoveActionSchema)
	.or(computerScreenshotActionSchema)
	.or(computerScrollActionSchema)
	.or(computerTypeActionSchema)
	.or(computerWaitActionSchema);

const computerCallItemSchema = type({
	type: "'computer_call'",
	id: "string >= 1",
	call_id: "string >= 1",
	"action?": computerActionSchema,
	"actions?": computerActionSchema.array(),
	pending_safety_checks: computerSafetyCheckSchema.array(),
	status: "'in_progress' | 'completed' | 'incomplete'",
}).narrow((v, ctx) => v.action !== undefined || v.actions !== undefined || ctx.mustBe("`action` or `actions`"));

const computerScreenshotImageUrlSchema = type({
	type: "'computer_screenshot'",
	image_url: "string",
});

const computerScreenshotFileIdSchema = type({
	type: "'computer_screenshot'",
	file_id: "string",
});

const computerCallOutputItemSchema = type({
	type: "'computer_call_output'",
	"id?": "string | null",
	call_id: "string >= 1",
	output: computerScreenshotImageUrlSchema.or(computerScreenshotFileIdSchema),
	"acknowledged_safety_checks?": computerSafetyCheckSchema.array().or(type("null")),
	"status?": "'in_progress' | 'completed' | 'incomplete' | 'failed' | null",
});

const BRIDGED_INPUT_ITEM_TYPES: Record<string, true> = {
	message: true,
	reasoning: true,
	function_call: true,
	function_call_output: true,
	custom_tool_call: true,
	custom_tool_call_output: true,
	computer_call: true,
	computer_call_output: true,
};

const unbridgedInputItemSchema = type({ type: "string" }).narrow((value, ctx) =>
	value.type in BRIDGED_INPUT_ITEM_TYPES ? ctx.mustBe("a valid bridged Responses input item") : true,
);

export const inputItemSchema = userMessageItemSchema
	.or(systemMessageItemSchema)
	.or(assistantMessageItemSchema)
	.or(reasoningItemSchema)
	.or(functionCallItemSchema)
	.or(functionCallOutputItemSchema)
	.or(customToolCallItemSchema)
	.or(customToolCallOutputItemSchema)
	.or(computerCallItemSchema)
	.or(computerCallOutputItemSchema)

	.or(unbridgedInputItemSchema);

export type OpenAIResponsesUserItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesSystemItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesAssistantItem = EasyInputMessage | ResponseOutputMessage;
export type OpenAIResponsesReasoningItem = ResponseReasoningItem;
export type OpenAIResponsesFunctionCallItem = ResponseFunctionToolCall;
export type OpenAIResponsesFunctionCallOutputItem = ResponseInputItem.FunctionCallOutput;

export type OpenAIResponsesCustomToolCallItem = typeof customToolCallItemSchema.infer;
export type OpenAIResponsesCustomToolCallOutputItem = typeof customToolCallOutputItemSchema.infer;
export type OpenAIResponsesComputerCallItem = typeof computerCallItemSchema.infer;
export type OpenAIResponsesComputerCallOutputItem = typeof computerCallOutputItemSchema.infer;
export type OpenAIResponsesInputImageBlock = typeof inputImageBlockSchema.infer;
export type OpenAIResponsesInputFileBlock = typeof inputFileBlockSchema.infer;
export type OpenAIResponsesOutputRefusalBlock = typeof outputRefusalSchema.infer;

export const toolSchema = type({
	type: "'function'",
	name: "string >= 1",
	"description?": "string",
	"parameters?": type({ "[string]": "unknown" }),
	"strict?": "boolean",
});

const computerToolSchema = type({ type: "'computer'" });

const BRIDGED_TOOL_TYPES: Record<string, true> = { function: true, computer: true };

const builtinToolSchema = type({ type: "string" }).narrow((value, ctx) =>
	value.type in BRIDGED_TOOL_TYPES ? ctx.mustBe("a valid bridged Responses tool") : true,
);

const hostedToolType = type(
	"'web_search_preview' | 'file_search' | 'computer' | 'computer_use_preview' | 'code_interpreter' | 'image_generation' | 'mcp'",
);

const allowedToolEntrySchema = type({
	type: "string",
	"name?": "string",
});

export const toolChoiceSchema = type("'auto' | 'none' | 'required'")
	.or(
		type({
			type: "'function'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: "'custom'",
			name: "string >= 1",
		}),
	)
	.or(
		type({
			type: hostedToolType,
		}),
	)
	.or(
		type({
			type: "'allowed_tools'",
			mode: "'auto' | 'required'",
			tools: allowedToolEntrySchema.array(),
		}),
	);

export const reasoningConfigSchema = type({
	"effort?": "string",

	"summary?": "'auto' | 'concise' | 'detailed' | 'none'",
});

export const stopSchema = type("string | string[] | null");

export const openaiResponsesRequestSchema = type({
	model: "string >= 1",
	"input?": type("string").or(inputItemSchema.array()),
	"instructions?": "string | null",
	"tools?": toolSchema.or(computerToolSchema).or(builtinToolSchema).array(),
	"tool_choice?": toolChoiceSchema,
	"max_output_tokens?": "number",
	"temperature?": "number",
	"top_p?": "number",
	"stop?": stopSchema,
	"stream?": "boolean",
	"reasoning?": reasoningConfigSchema,
	"store?": "boolean",
	"previous_response_id?": "string",
	"parallel_tool_calls?": "boolean",
	"prompt_cache_key?": "string",
	"metadata?": "unknown",
	"user?": "string",
	"service_tier?": "string",
	"presence_penalty?": "number",
	"frequency_penalty?": "number",

	"background?": "unknown",
	"include?": "string[] | null",
	"prompt?": "unknown",
	"safety_identifier?": "unknown",
	"text?": "unknown",
	"top_logprobs?": "unknown",
	"truncation?": "unknown",
});

export type OpenAIResponsesRequest = ResponseCreateParams;
export type OpenAIResponsesInputItem = ResponseInputItem;
export type OpenAIResponsesTool = ResponsesTool;
export type OpenAIResponsesToolChoice = NonNullable<ResponseCreateParams["tool_choice"]>;
export type OpenAIResponsesInputContent = ResponseInputContent;
export type OpenAIResponsesOutputContent = ResponseOutputMessage["content"][number];
