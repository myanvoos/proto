import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type ComputerAction,
	type ComputerSafetyCheck,
	type Context,
	EventStream,
	isApiKeyResolver,
	type Model,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	streamSimple,
	stripSchemaDescriptions,
	type ToolCallProviderMetadata,
	type ToolChoice,
	type ToolResultMessage,
	type ToolResultProviderMetadata,
	type TSchema,
	toolWireSchema,
	validateToolArguments,
} from "@oh-my-pi/pi-ai";
import {
	type Dialect,
	encodeInbandToolHistory,
	renderInbandToolPrompt,
	renderToolExamples,
	wrapInbandToolStream,
} from "@oh-my-pi/pi-ai/dialect";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	type CursorExecResolvedCarrier,
	copyCursorExecResolved,
	kCursorExecResolved,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonyDetection,
	type HarmonyRecoveredToolCall,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	signalListLabel,
} from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { INTENT_FIELD, logger, sanitizeText, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { agentPauseGate } from "./pause";
import { type AgentRunCoverage, type AgentRunSummary, ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	PiGenAIAttr,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	type Span,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "./telemetry";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentPreModelCallResult,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentTurnEndContext,
	AsideMessage,
	BeforeToolCallResult,
	CommittableAsideMessage,
	SoftToolRequirement,
	SteeringInterruptSource,
	SteeringQueueState,
	StreamFn,
} from "./types";
import { ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD, isSoftToolRequirement } from "./types";
import { yieldIfDue } from "./utils/yield";

export const STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL = "stream_interrupted_after_content";

const ABORTED: unique symbol = Symbol("agent-loop-aborted");

const MAX_PAUSED_TURN_CONTINUATIONS = 8;

const MAX_SOFT_TOOL_ESCALATIONS = 3;

function hardToolChoiceBlocks(choice: ToolChoice | undefined, requiredTool: string): boolean {
	if (choice === undefined) return false;
	if (typeof choice === "string") return choice === "none";
	if (choice.type === "computer") return requiredTool !== "computer";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

export interface ToolScopedAbortReason {
	readonly kind: "tool-scoped-abort";
	readonly message: string;
	readonly toolCallMessages: Record<string, string>;
	readonly defaultToolCallMessage: string;
}

export function createToolScopedAbortReason(
	message: string,
	toolCallMessages: Record<string, string>,
	defaultToolCallMessage: string,
): ToolScopedAbortReason {
	return { kind: "tool-scoped-abort", message, toolCallMessages, defaultToolCallMessage };
}

export const TERMINAL_TOOL_RESULT_ABORT_REASON = Symbol.for("pi-agent-core.terminal-tool-result");

const STEERING_INTERRUPT_POLL_MS = 250;

class HarmonyLeakInterruption extends Error {
	constructor(
		readonly detection: HarmonyDetection,
		readonly removed: string,
		readonly recovered?: HarmonyRecoveredToolCall,
	) {
		super(`Detected GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`);
		this.name = "HarmonyLeakInterruption";
	}
}
export function resolveOwnedDialectFromEnv(value: string | undefined): Dialect | undefined {
	switch (value) {
		case "1":
		case "true":
			return "glm";
		case "glm":
		case "hermes":
		case "kimi":
		case "xml":
		case "anthropic":
		case "deepseek":
		case "harmony":
		case "qwen3":
		case "gemini":
		case "gemma":
		case "minimax":
			return value;
		default:
			return undefined;
	}
}

type AssistantContentBlock = AssistantMessage["content"][number];
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;

function snapshotComputerSafetyChecks(value: unknown): ComputerSafetyCheck[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const checks: ComputerSafetyCheck[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const check = raw as Record<string, unknown>;
		if (typeof check.id !== "string" || check.id.length === 0) return undefined;
		if (check.code !== undefined && check.code !== null && typeof check.code !== "string") return undefined;
		if (check.message !== undefined && check.message !== null && typeof check.message !== "string") return undefined;
		checks.push({
			id: check.id,
			...(check.code !== undefined ? { code: check.code as string | null } : {}),
			...(check.message !== undefined ? { message: check.message as string | null } : {}),
		});
	}
	return checks;
}

function isFiniteCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasValidComputerKeys(value: unknown, optional: boolean): boolean {
	return (
		(optional && value === undefined) ||
		value === null ||
		(Array.isArray(value) && value.every(key => typeof key === "string"))
	);
}

function snapshotComputerAction(value: unknown): ComputerAction | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const action = value as Record<string, unknown>;
	switch (action.type) {
		case "click":
			if (
				!(["left", "right", "wheel", "back", "forward"] as unknown[]).includes(action.button) ||
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "double_click":
			if (
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!hasValidComputerKeys(action.keys, false)
			)
				return undefined;
			break;
		case "drag":
			if (
				!Array.isArray(action.path) ||
				!action.path.every(
					point =>
						point &&
						typeof point === "object" &&
						isFiniteCoordinate((point as Record<string, unknown>).x) &&
						isFiniteCoordinate((point as Record<string, unknown>).y),
				) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "keypress":
			if (!Array.isArray(action.keys) || !action.keys.every(key => typeof key === "string")) return undefined;
			break;
		case "move":
			if (!isFiniteCoordinate(action.x) || !isFiniteCoordinate(action.y) || !hasValidComputerKeys(action.keys, true))
				return undefined;
			break;
		case "screenshot":
		case "wait":
			break;
		case "scroll":
			if (
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!isFiniteCoordinate(action.scroll_x) ||
				!isFiniteCoordinate(action.scroll_y) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "type":
			if (typeof action.text !== "string") return undefined;
			break;
		default:
			return undefined;
	}
	return structuredCloneJSON(action) as ComputerAction;
}

function snapshotToolCallProviderMetadata(value: unknown): ToolCallProviderMetadata | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const metadata = value as Record<string, unknown>;
	if (
		metadata.type !== "computer" ||
		typeof metadata.providerItemId !== "string" ||
		metadata.providerItemId.length === 0
	)
		return undefined;
	if (!Array.isArray(metadata.actions) || metadata.actions.length === 0) return undefined;
	const actions = metadata.actions.map(snapshotComputerAction);
	if (actions.some(action => action === undefined)) return undefined;
	const pendingSafetyChecks = snapshotComputerSafetyChecks(metadata.pendingSafetyChecks);
	if (!pendingSafetyChecks) return undefined;
	return {
		type: "computer",
		providerItemId: metadata.providerItemId,
		actions: actions as ComputerAction[],
		pendingSafetyChecks,
	};
}

function snapshotToolResultProviderMetadata(value: unknown): {
	metadata?: ToolResultProviderMetadata;
	malformed: boolean;
} {
	if (value === undefined) return { malformed: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { malformed: true };
	const metadata = value as Record<string, unknown>;
	if (
		metadata.type !== "computer" ||
		!metadata.screenshot ||
		typeof metadata.screenshot !== "object" ||
		Array.isArray(metadata.screenshot)
	) {
		return { malformed: true };
	}
	const screenshot = metadata.screenshot as Record<string, unknown>;
	const hasImageUrl = Object.hasOwn(screenshot, "image_url");
	const hasFileId = Object.hasOwn(screenshot, "file_id");
	if (screenshot.type !== "computer_screenshot" || hasImageUrl === hasFileId) return { malformed: true };
	if (hasImageUrl && (typeof screenshot.image_url !== "string" || screenshot.image_url.length === 0))
		return { malformed: true };
	if (hasFileId && (typeof screenshot.file_id !== "string" || screenshot.file_id.length === 0))
		return { malformed: true };
	const acknowledgedSafetyChecks = snapshotComputerSafetyChecks(metadata.acknowledgedSafetyChecks);
	if (!acknowledgedSafetyChecks) return { malformed: true };
	return {
		malformed: false,
		metadata: {
			type: "computer",
			screenshot: hasImageUrl
				? { type: "computer_screenshot", image_url: screenshot.image_url as string }
				: { type: "computer_screenshot", file_id: screenshot.file_id as string },
			acknowledgedSafetyChecks,
		},
	};
}

function snapshotAssistantContentBlock(block: AssistantContentBlock): AssistantContentBlock {
	switch (block.type) {
		case "text":
		case "image":
			return { ...block };
		case "thinking":
			return { ...block };
		case "redactedThinking":
			return { ...block };
		case "anthropicServerTool":
			return { ...block, block: structuredCloneJSON(block.block) };
		case "fallback":
			return { ...block, from: { ...block.from }, to: { ...block.to } };
		case "toolCall": {
			const snap = {
				...block,
				arguments: structuredCloneJSON(block.arguments),
				providerMetadata: snapshotToolCallProviderMetadata(block.providerMetadata),
			};

			copyCursorExecResolved(snap, block);
			return snap;
		}
	}
}

function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map(snapshotAssistantContentBlock),
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		disabledFeatures: message.disabledFeatures ? [...message.disabledFeatures] : undefined,
		toolCallAbortMessages: message.toolCallAbortMessages ? { ...message.toolCallAbortMessages } : undefined,
	};
}

function snapshotAssistantMessageEvent(
	event: AssistantMessageEvent,
	partialSnapshot?: AssistantMessage,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial) };
		case "text_start":
		case "text_delta":
		case "text_end":
		case "image_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial) };
		case "toolcall_end":
			return {
				...event,
				toolCall: snapshotAssistantContentBlock(event.toolCall) as AssistantToolCallBlock,
				partial: partialSnapshot ?? snapshotAssistantMessage(event.partial),
			};
		case "done":
			return { ...event, message: snapshotAssistantMessage(event.message) };
		case "error":
			return { ...event, error: snapshotAssistantMessage(event.error) };
	}
}

const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

function hasSubstantiveToolResultContent(content: AgentToolResult["content"]): boolean {
	for (const block of content) {
		if (block.type === "image") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

function coerceToolResult(raw: unknown): { result: AgentToolResult<unknown>; malformed: boolean } {
	const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const rawContent = rawObj?.content;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	const providerMetadataResult = snapshotToolResultProviderMetadata(
		rawObj && "providerMetadata" in rawObj ? rawObj.providerMetadata : undefined,
	);
	const providerMetadata = providerMetadataResult.metadata;

	const explicitError = Boolean(rawObj && "isError" in rawObj && rawObj.isError);

	const useless = Boolean(rawObj && "useless" in rawObj && rawObj.useless);

	if (!Array.isArray(rawContent)) {
		return {
			result: {
				content: [{ type: "text", text: "Tool returned an invalid result: missing content array." }],
				details,
				isError: true,
			},
			malformed: true,
		};
	}

	const content: AgentToolResult["content"] = [];
	let invalidBlocks = 0;
	for (const block of rawContent) {
		if (!block || typeof block !== "object" || !("type" in block)) {
			invalidBlocks++;
			continue;
		}
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			content.push({ type: "text", text: sanitizeText((block as { text: string }).text) });
		} else if (
			block.type === "image" &&
			typeof (block as { data?: unknown }).data === "string" &&
			typeof (block as { mimeType?: unknown }).mimeType === "string"
		) {
			content.push(block as { type: "image"; data: string; mimeType: string });
		} else {
			invalidBlocks++;
		}
	}
	if (invalidBlocks > 0) {
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${invalidBlocks} content block${invalidBlocks === 1 ? "" : "s"} had an unsupported shape.`,
		});
	}
	if (providerMetadataResult.malformed) {
		content.push({
			type: "text",
			text: "Tool returned an invalid result: computer providerMetadata had an unsupported shape.",
		});
	}
	const isError = explicitError || invalidBlocks > 0 || providerMetadataResult.malformed;

	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	return {
		result: {
			content,
			details,
			providerMetadata,
			...(isError ? { isError: true } : {}),
			...(useless && !isError ? { useless: true } : {}),
		},
		malformed: invalidBlocks > 0 || providerMetadataResult.malformed,
	};
}

export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};
		for (const prompt of prompts) {
			(prompt as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
		}

		stream.push({ type: "agent_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, prompts);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context, messages: [...context.messages] };

		stream.push({ type: "agent_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

function buildAgentEndEvent(
	messages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): Extract<AgentEvent, { type: "agent_end" }> {
	if (!telemetry) return { type: "agent_end", messages };
	const snapshot = telemetry.collector.snapshot({ stepCount });
	if (telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	return { type: "agent_end", messages, telemetry: snapshot.summary, coverage: snapshot.coverage };
}

async function emitTurnEnd(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	currentContext: AgentContext,
	message: AgentMessage,
	toolResults: ToolResultMessage[],
	config: AgentLoopConfig,
	signal?: AbortSignal,
	context?: Omit<AgentTurnEndContext, "message" | "toolResults">,
	runHookOnAbortedMessage = false,
): Promise<void> {
	stream.push({ type: "turn_end", message, toolResults });
	const isAbortedOrError =
		message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
	if (signal?.aborted || (isAbortedOrError && !runHookOnAbortedMessage)) return;
	await config.onTurnEnd?.(currentContext.messages, signal, { message, toolResults, willContinue: false, ...context });
}

function createGateStopMessage(model: Model, reason: string | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: reason ?? "Stopped before model call",
		timestamp: Date.now(),
	};
}

export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

export function agentLoopDetailed(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoop(prompts, context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

export function agentLoopContinueDetailed(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoopContinue(context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

function createDetailedCapture(config: AgentLoopConfig): {
	readonly config: AgentLoopConfig;
	readonly detailed: (stream: EventStream<AgentEvent, AgentMessage[]>) => Promise<AgentLoopDetailedResult>;
} {
	let captured: { summary: AgentRunSummary; coverage: AgentRunCoverage } | undefined;
	const userHook = config.telemetry?.onRunEnd;
	const wired: AgentLoopConfig = {
		...config,
		telemetry: {
			...(config.telemetry ?? {}),
			onRunEnd: (summary, coverage) => {
				captured = { summary, coverage };
				userHook?.(summary, coverage);
			},
		},
	};
	return {
		config: wired,
		detailed: async stream => {
			const messages = await stream.result();
			return {
				messages,
				telemetry: captured?.summary,
				coverage: captured?.coverage,
			};
		},
	};
}

export function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let hasThinking = false;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "thinking") {
				hasThinking = true;
				break;
			}
		}
		if (hasThinking) break;
	}
	if (!hasThinking) return messages;

	return messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		const filtered = message.content.filter(block => block.type !== "thinking");
		return filtered.length === message.content.length ? message : { ...message, content: filtered };
	});
}

const INTENT_FIELD_DESCRIPTION = "concise intent";
const INTENT_SCHEMA_UNION_KEYS = ["anyOf", "oneOf"] as const;

function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const hasOwnProperties =
		propertiesValue !== null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue);

	if (!hasOwnProperties) {
		for (const key of INTENT_SCHEMA_UNION_KEYS) {
			const variants = schemaRecord[key];
			if (!Array.isArray(variants)) continue;
			return {
				...schemaRecord,
				[key]: variants.map(variant => injectIntentIntoSchema(variant, mode, describeIntent)),
			};
		}
	}

	const properties = hasOwnProperties ? (propertiesValue as Record<string, unknown>) : {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: [...required, INTENT_FIELD] } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: describeIntent
				? { type: "string", description: INTENT_FIELD_DESCRIPTION }
				: { type: "string" },
			...properties,
		},
		...(mode === "require" ? { required: [...required, INTENT_FIELD] } : {}),
	};
}

export interface NormalizeToolsOptions {
	injectIntent: boolean;

	pruneDescriptions?: boolean;
}

export function normalizeTools(tools: AgentContext["tools"], options: NormalizeToolsOptions): Context["tools"] {
	const pruneDescriptions = options.pruneDescriptions === true;
	const injectIntent = options.injectIntent && Bun.env.PI_NO_INTENT !== "1";
	return tools?.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		const doInjectIntent = injectIntent && intentMode !== "omit";

		if (pruneDescriptions) {
			let parameters = stripSchemaDescriptions(toolWireSchema(t)) as TSchema;
			if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode, false) as TSchema;
			return { ...t, parameters, description: "" };
		}
		let parameters = toolWireSchema(t) as TSchema;
		if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
		const description = t.description ?? "";
		const examplesBlock = renderToolExamples({ ...t, parameters }, doInjectIntent ? INTENT_FIELD : undefined);
		const finalDescription = examplesBlock ? `${description}\n\n${examplesBlock}` : description;
		return { ...t, parameters, description: finalDescription };
	});
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
	initialMessages: AgentMessage[] = [],
): Promise<void> {
	const telemetry = resolveTelemetry(config.telemetry, config.sessionId);
	const invokeAgentSpan = startInvokeAgentSpan(telemetry, config.model);
	const stepCounter = { count: 0 };
	let caughtError: unknown;
	try {
		await runInActiveSpan(invokeAgentSpan, () =>
			runLoopBody(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				telemetry,
				invokeAgentSpan,
				stepCounter,
				initialMessages,
				streamFn,
			),
		);
	} catch (err) {
		caughtError = err;
		throw err;
	} finally {
		finishInvokeAgentSpan(telemetry, invokeAgentSpan, {
			stepCount: stepCounter.count,
			errorObject: caughtError,
		});
	}
}

interface StepCounter {
	count: number;
}

function isDeadlineExceeded(deadline: number | undefined): boolean {
	return deadline !== undefined && Date.now() >= deadline;
}

function endAgentStream(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	newMessages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): void {
	stream.push(buildAgentEndEvent(newMessages, telemetry, stepCount));
	stream.end(newMessages);
}
function emitInputMessages(stream: EventStream<AgentEvent, AgentMessage[]>, messages: readonly AgentMessage[]): void {
	for (const message of messages) {
		stream.push({ type: "message_start", message });
		stream.push({ type: "message_end", message });
	}
}

function resolveAsides(entries: AsideMessage[] | undefined): AgentMessage[] {
	if (!entries || entries.length === 0) return [];
	const out: AgentMessage[] = [];
	try {
		for (const entry of entries) {
			const message = typeof entry === "function" ? entry() : entry;
			if (message) out.push(message);
		}
	} catch (error) {
		discardAsides(out, error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
	return out;
}

function discardAsides(messages: readonly AgentMessage[], error: Error): void {
	for (const message of messages) {
		(message as CommittableAsideMessage)[ASIDE_MESSAGE_DISCARD]?.(error);
	}
}

async function runLoopBody(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	initialMessages: AgentMessage[],
	streamFn?: StreamFn,
): Promise<void> {
	let deadlineTimer: Timer | undefined;
	if (config.deadline !== undefined) {
		const deadlineAbortController = new AbortController();
		const deadlineReason = new DOMException("Deadline exceeded", "TimeoutError");
		const delay = config.deadline - Date.now();
		if (delay <= 0) {
			deadlineAbortController.abort(deadlineReason);
		} else {
			deadlineTimer = setTimeout(() => {
				deadlineAbortController.abort(deadlineReason);
			}, delay);
		}
		signal = signal ? AbortSignal.any([signal, deadlineAbortController.signal]) : deadlineAbortController.signal;
	}

	const softRequirementState = config.softToolRequirementState ?? { escalations: 0 };
	let preserveSoftRequirementState = false;

	let pendingMessages: AgentMessage[] = [];
	try {
		let messagesToEmit = [...initialMessages];
		if (isDeadlineExceeded(config.deadline)) {
			emitInputMessages(stream, messagesToEmit);
			endAgentStream(stream, newMessages, telemetry, stepCounter.count);
			return;
		}

		try {
			pendingMessages = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
		} catch (error) {
			stream.push({ type: "turn_start" });
			emitInputMessages(stream, messagesToEmit);
			throw error;
		}
		let harmonyRetryAttempt = 0;
		let harmonyTruncateResumeCount = 0;
		let pausedTurnContinuations = 0;

		let hostToolChoice: ToolChoice | undefined;
		let softRequiredTool: string | undefined;
		let softSatisfies: SoftToolRequirement["satisfies"];
		let directiveResolvedForTurn = false;
		let turnOpen = false;

		while (true) {
			let hasMoreToolCalls = true;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (isDeadlineExceeded(config.deadline)) {
					emitInputMessages(stream, messagesToEmit);
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}

				await yieldIfDue();

				if (agentPauseGate.paused) await agentPauseGate.waitUntilResumed(signal);

				const turnMessages = messagesToEmit;
				messagesToEmit = [];
				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						currentContext.messages.push(message);
						newMessages.push(message);
						turnMessages.push(message);
						(message as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
					}
					pendingMessages = [];
				}

				let preparedProviderCall: PreparedProviderCall;
				let gateResult: AgentPreModelCallResult;
				try {
					if (config.syncContextBeforeModelCall) {
						await config.syncContextBeforeModelCall(currentContext, signal);
					}

					if (!directiveResolvedForTurn) {
						const directive = signal?.aborted ? undefined : config.getToolChoice?.();
						const softReq = isSoftToolRequirement(directive) ? directive : undefined;
						hostToolChoice = directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
						softRequiredTool = softReq?.toolName;
						softSatisfies = softReq?.satisfies;
						const softRequirementId = softRequirementState.id;
						if (softReq !== undefined) {
							if (softReq.id !== softRequirementId) {
								softRequirementState.id = softReq.id;
								softRequirementState.forcedToolChoice = undefined;
								softRequirementState.escalations = 0;
								for (const reminder of softReq.reminder) {
									currentContext.messages.push(reminder);
									newMessages.push(reminder);
									turnMessages.push(reminder);
								}
							}
						} else {
							softRequirementState.id = undefined;
							softRequirementState.forcedToolChoice = undefined;
							softRequirementState.escalations = 0;
						}
						directiveResolvedForTurn = true;
					}

					preparedProviderCall = await prepareProviderCall(currentContext, config, signal);
					gateResult = (await config.beforeModelCall?.(preparedProviderCall.context, signal)) || undefined;
				} catch (error) {
					if (!turnOpen) {
						stream.push({ type: "turn_start" });
						emitInputMessages(stream, turnMessages);
						turnOpen = true;
					}
					throw error;
				}
				if (config.beforeModelCall && signal?.aborted) {
					gateResult = { stop: true };
				}
				if (gateResult?.stop) {
					if (gateResult.reason) {
						logger.debug("Agent loop stopped before the model call", { reason: gateResult.reason });
					}
					if (!turnOpen && !signal?.aborted) {
						try {
							config.onToolChoiceRejected?.();
						} catch (error) {
							stream.push({ type: "turn_start" });
							emitInputMessages(stream, turnMessages);
							turnOpen = true;
							throw error;
						}
					}
					emitInputMessages(stream, turnMessages);
					if (turnOpen) {
						const stopMessage = createGateStopMessage(preparedProviderCall.model, gateResult.reason);
						currentContext.messages.push(stopMessage);
						newMessages.push(stopMessage);
						stream.push({ type: "message_start", message: stopMessage });
						stream.push({ type: "message_end", message: stopMessage });
						await emitTurnEnd(
							stream,
							currentContext,
							stopMessage,
							[],
							config,
							signal,
							{ willContinue: false },
							true,
						);
						turnOpen = false;
					}
					preserveSoftRequirementState = !signal?.aborted;
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}

				if (!turnOpen) {
					stream.push({ type: "turn_start" });
					emitInputMessages(stream, turnMessages);
					turnOpen = true;
				}

				let recovered: HarmonyRecoveredToolCall | undefined;
				let message: AssistantMessage;
				try {
					message = await streamAssistantResponse(
						currentContext,
						config,
						signal,
						stream,
						telemetry,
						invokeAgentSpan,
						stepCounter,
						streamFn,
						harmonyRetryAttempt,
						hostToolChoice,
						softRequirementState.forcedToolChoice,
						preparedProviderCall,
					);
					harmonyRetryAttempt = 0;
					harmonyTruncateResumeCount = 0;
				} catch (err) {
					if (!(err instanceof HarmonyLeakInterruption)) throw err;
					if (err.recovered) {
						if (harmonyTruncateResumeCount >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak recurred after truncate-and-resume recovery (${signalListLabel(err.detection.signals)}).`,
							);
						}
						harmonyTruncateResumeCount++;
						recovered = err.recovered;
						message = recovered.message;
						await emitHarmonyAudit(config, err, "truncate_resume", harmonyRetryAttempt);

						harmonyRetryAttempt = 0;
					} else {
						if (harmonyRetryAttempt >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak persisted after ${harmonyRetryAttempt} retries (${signalListLabel(err.detection.signals)}).`,
							);
						}
						await emitHarmonyAudit(config, err, "abort_retry", harmonyRetryAttempt);
						harmonyRetryAttempt++;
						continue;
					}
				}
				if (recovered) {
					message = snapshotAssistantMessage(message);
					currentContext.messages.push(message);
					stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
					stream.push({ type: "message_end", message: snapshotAssistantMessage(message) });
				}
				newMessages.push(message);

				softRequirementState.forcedToolChoice = undefined;

				directiveResolvedForTurn = false;

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

					const toolCalls = message.content.filter(
						(c): c is ToolCallContent =>
							c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
					);

					const scopedAbort = toolScopedAbortReason(signal);
					const toolCallAbortMessages =
						message.toolCallAbortMessages ??
						(scopedAbort ? buildToolCallAbortMessages(message, scopedAbort) : undefined);
					const toolResults: ToolResultMessage[] = [];
					for (const toolCall of toolCalls) {
						const errorMessage = toolCallAbortMessages?.[toolCall.id] ?? message.errorMessage;
						const result = createAbortedToolResult(toolCall, stream, message.stopReason, errorMessage);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);

						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: message.stopReason === "aborted" ? "aborted" : "error",
						});
					}
					await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, { willContinue: false });
					turnOpen = false;

					stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count));
					stream.end(newMessages);
					return;
				}

				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

				const toolCalls = message.content.filter(
					(c): c is ToolCallContent =>
						c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
				);
				const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
				hasMoreToolCalls = runnableStop && toolCalls.length > 0;

				const deadlinePassed = isDeadlineExceeded(config.deadline);
				if (hasMoreToolCalls && deadlinePassed) {
					hasMoreToolCalls = false;
				}

				const calledOnlyRequiredTool =
					softRequiredTool !== undefined &&
					toolCalls.length > 0 &&
					toolCalls.every(toolCall => softSatisfies?.(toolCall) ?? toolCall.name === softRequiredTool);
				const softGateActive =
					softRequiredTool !== undefined && !hardToolChoiceBlocks(config.toolChoice, softRequiredTool);
				const softNonCompliant = softGateActive && !calledOnlyRequiredTool;

				const toolResults: ToolResultMessage[] = [];
				if (softNonCompliant && softRequiredTool !== undefined) {
					if (softRequirementState.escalations >= MAX_SOFT_TOOL_ESCALATIONS) {
						throw new Error(
							`Soft tool requirement '${softRequiredTool}' was not satisfied after ${MAX_SOFT_TOOL_ESCALATIONS} forced turns; aborting to avoid an unbounded force loop.`,
						);
					}

					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(
							toolCall,
							stream,
							"skipped",
							`Not executed: call the \`${softRequiredTool}\` tool to resolve the pending action before using other tools.`,
						);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: "skipped",
						});
					}
					softRequirementState.forcedToolChoice = { type: "tool", name: softRequiredTool };
					softRequirementState.escalations++;
					hasMoreToolCalls = true;
				} else if (hasMoreToolCalls) {
					const executionResult = await executeToolCalls(
						currentContext,
						message,
						signal,
						stream,
						config,
						telemetry,
						invokeAgentSpan,
					);

					toolResults.push(...executionResult.toolResults);

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				} else if (toolCalls.length > 0) {
					const skipReason = deadlinePassed ? "aborted" : message.stopReason === "length" ? "length" : "skipped";
					const skipErrMsg = deadlinePassed ? "Deadline exceeded" : undefined;
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(toolCall, stream, skipReason, skipErrMsg);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: deadlinePassed ? "aborted" : "skipped",
						});
					}
					if (message.stopReason === "length" && toolResults.length > 0 && !deadlinePassed) {
						hasMoreToolCalls = true;
					}
				}

				if (signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON) {
					hasMoreToolCalls = false;
				}

				if (toolCalls.length > 0) {
					pausedTurnContinuations = 0;
				} else if (
					!hasMoreToolCalls &&
					message.stopReason === "stop" &&
					message.stopDetails?.type === "pause_turn" &&
					pausedTurnContinuations < MAX_PAUSED_TURN_CONTINUATIONS
				) {
					pausedTurnContinuations++;
					hasMoreToolCalls = true;
				}

				await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, {
					willContinue: hasMoreToolCalls && !isDeadlineExceeded(config.deadline),
				});
				turnOpen = false;

				if (isDeadlineExceeded(config.deadline)) {
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}

				const steering = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
				if (hasMoreToolCalls) {
					const asides = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
					pendingMessages = asides.length > 0 ? [...steering, ...asides] : steering;
				} else {
					pendingMessages = steering;
				}
			}

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}

			await config.onBeforeYield?.();

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}

			const lateSteering = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
			const asideMessages = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
			const followUpMessages = signal?.aborted ? [] : (await config.getFollowUpMessages?.(signal)) || [];
			if (lateSteering.length > 0 || asideMessages.length > 0 || followUpMessages.length > 0) {
				pendingMessages = [...lateSteering, ...asideMessages, ...followUpMessages];
				continue;
			}

			break;
		}

		endAgentStream(stream, newMessages, telemetry, stepCounter.count);
	} finally {
		discardAsides(pendingMessages, new Error("Aside message was not committed before the agent loop ended"));
		if (!preserveSoftRequirementState) {
			softRequirementState.id = undefined;
			softRequirementState.forcedToolChoice = undefined;
			softRequirementState.escalations = 0;
		}
		if (deadlineTimer) {
			clearTimeout(deadlineTimer);
		}
	}
}

async function emitHarmonyAudit(
	config: AgentLoopConfig,
	interruption: HarmonyLeakInterruption,
	action: "truncate_resume" | "abort_retry" | "escalated",
	retryN: number,
): Promise<void> {
	await config.onHarmonyLeak?.(
		createHarmonyAuditEvent({
			action,
			detection: interruption.detection,
			model: config.getModel?.() ?? config.model,
			retryN,
			removed: interruption.removed,
		}),
	);
}

interface PreparedProviderCall {
	model: Model;
	context: Context;
	promptToolWireTools: Context["tools"];
	ownedDialect: Dialect | undefined;
}

async function prepareProviderCall(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedProviderCall> {
	const model = config.getModel?.() ?? config.model;
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, model);
	const ownedDialect: Dialect | undefined = config.dialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT);
	const pruneToolDescriptions = !!config.pruneToolDescriptions && !ownedDialect;
	let llmContext: Context;
	if (config.appendOnlyContext) {
		config.appendOnlyContext.syncMessages(normalizedMessages);
		llmContext = config.appendOnlyContext.build(context, {
			intentTracing: !!config.intentTracing,
			pruneToolDescriptions,
		});
	} else {
		llmContext = {
			systemPrompt: context.systemPrompt,
			messages: normalizedMessages,
			tools: normalizeTools(context.tools, {
				injectIntent: !!config.intentTracing,
				pruneDescriptions: pruneToolDescriptions,
			}),
		};
	}
	if (config.transformProviderContext) {
		llmContext = await config.transformProviderContext(llmContext, model);
	}

	let promptToolWireTools: Context["tools"];
	if (ownedDialect && llmContext.tools && llmContext.tools.length > 0) {
		promptToolWireTools = llmContext.tools;
		llmContext = {
			...llmContext,
			systemPrompt: [...(llmContext.systemPrompt ?? []), renderInbandToolPrompt(promptToolWireTools, ownedDialect)],
			messages: encodeInbandToolHistory(llmContext.messages, ownedDialect, promptToolWireTools),
			tools: undefined,
		};
	}
	return { model, context: llmContext, promptToolWireTools, ownedDialect };
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
	harmonyRetryAttempt = 0,
	hostToolChoice?: ToolChoice,
	forcedToolChoice?: ToolChoice,
	prepared?: PreparedProviderCall,
): Promise<AssistantMessage> {
	const providerCall = prepared ?? (await prepareProviderCall(context, config, signal));
	const { model, context: llmContext, promptToolWireTools, ownedDialect } = providerCall;

	const streamFunction = streamFn || streamSimple;

	const dynamicReasoning = config.getReasoning?.();
	const dynamicDisableReasoning = config.getDisableReasoning?.();

	const effectiveServiceTier = config.getServiceTier ? config.getServiceTier(model) : config.serviceTier;
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignal = harmonyAbortController
		? signal
			? AbortSignal.any([signal, harmonyAbortController.signal])
			: harmonyAbortController.signal
		: signal;

	const promptToolAbortController = ownedDialect ? new AbortController() : undefined;
	const providerAbortSignals: AbortSignal[] = [];
	if (requestSignal) providerAbortSignals.push(requestSignal);
	if (promptToolAbortController) providerAbortSignals.push(promptToolAbortController.signal);
	const finalRequestSignal =
		providerAbortSignals.length === 0
			? undefined
			: providerAbortSignals.length === 1
				? providerAbortSignals[0]!
				: AbortSignal.any(providerAbortSignals);
	const requestApiKey = (config.getApiKey ? await config.getApiKey(model) : undefined) ?? config.apiKey;
	const resolvedApiKey = await resolveApiKeyOnce(requestApiKey, finalRequestSignal);
	const apiKey = isApiKeyResolver(requestApiKey) ? seedApiKeyResolver(resolvedApiKey, requestApiKey) : requestApiKey;

	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(model.provider) : config.metadata;
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;

	const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
	const effectiveReasoning = dynamicReasoning ?? config.reasoning;
	const effectiveDisableReasoning = dynamicDisableReasoning ?? config.disableReasoning;

	const effectiveCwd = config.getCwd?.() ?? config.cwd;

	const chatStepNumber = stepCounter.count;
	stepCounter.count += 1;
	const chatSpan = startChatSpan(telemetry, model, {
		parent: invokeAgentSpan,
		stepNumber: chatStepNumber,
		request: {
			maxTokens: config.maxTokens,
			temperature: effectiveTemperature,
			topP: config.topP,
			topK: config.topK,
			presencePenalty: config.presencePenalty,
			serviceTier: effectiveServiceTier,
			reasoningEffort: typeof effectiveReasoning === "string" ? effectiveReasoning : undefined,
			toolChoice: effectiveToolChoice,
			tools: llmContext.tools,
			systemPrompt: llmContext.systemPrompt,
			messages: llmContext.messages,
		},
	});

	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = config.onResponse;
	const captureOnResponse: AgentLoopConfig["onResponse"] = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	const finishChat = async (message: AssistantMessage): Promise<void> => {
		await finishChatSpan(telemetry, chatSpan, message, {
			stepNumber: chatStepNumber,
			serviceTier: effectiveServiceTier,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			let response = await streamFunction(model, llmContext, {
				...config,
				apiKey,
				metadata: resolvedMetadata,
				toolChoice: effectiveToolChoice,
				reasoning: effectiveReasoning,
				disableReasoning: effectiveDisableReasoning,
				temperature: effectiveTemperature,
				serviceTier: effectiveServiceTier,
				cwd: effectiveCwd,
				signal: finalRequestSignal,
				onResponse: captureOnResponse,
			});
			if (promptToolWireTools && ownedDialect) {
				response = wrapInbandToolStream(
					response,
					promptToolWireTools,
					ownedDialect,
					() => promptToolAbortController?.abort(),
					config.abortOnFabricatedToolResult ?? true,
				);
			}

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;
			const completedToolCallIds = new Set<string>();

			const responseIterator = response[Symbol.asyncIterator]();
			const finishAbortedStream = async (): Promise<AssistantMessage> => {
				try {
					const cleanup = responseIterator.return?.();
					if (cleanup) void cleanup.catch(() => {});
				} catch {}
				const aborted = emitAbortedAssistantMessage(
					partialMessage,
					addedPartial,
					completedToolCallIds,
					context,
					config,
					stream,
					requestSignal,
				);
				await finishChat(aborted);
				return aborted;
			};

			let abortRacePromise: Promise<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					return await finishAbortedStream();
				}
				const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
				const onAbort = () => resolve(ABORTED);
				requestSignal.addEventListener("abort", onAbort, { once: true });
				abortRacePromise = promise;
				detachAbortListener = () => requestSignal.removeEventListener("abort", onAbort);
			}

			try {
				while (true) {
					let next: IteratorResult<AssistantMessageEvent>;
					if (abortRacePromise) {
						const result = await Promise.race([responseIterator.next(), abortRacePromise]);
						if (result === ABORTED) {
							return await finishAbortedStream();
						}
						next = result;
					} else {
						next = await responseIterator.next();
					}
					if (next.done) break;

					const event = next.value;
					if (event.type === "done" || event.type === "error") {
						let finalMessage = recoverTransientErrorToolTurn(
							retainCompletedToolCalls(await response.result(), completedToolCallIds),
							context.tools ?? [],
						);
						if (harmonyMitigationEnabled) {
							const detection = detectHarmonyLeakInAssistantMessage(finalMessage);
							if (detection) {
								const recovered = recoverHarmonyToolCall(finalMessage, detection);
								const removed = recovered?.removed ?? extractHarmonyRemoved(finalMessage, detection);
								if (addedPartial) {
									emitDiscardedHarmonyPartial(
										partialMessage,
										stream,
										`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
									);
									context.messages.pop();
									addedPartial = false;
								}
								throw new HarmonyLeakInterruption(detection, removed, recovered);
							}
						}
						finalMessage = snapshotAssistantMessage(finalMessage);

						if (config.transformAssistantMessage) {
							await config.transformAssistantMessage(finalMessage, requestSignal);
						}

						if (finalMessage.content.some(c => c.type === "toolCall")) {
							preparedDispatchByMessage.set(
								finalMessage,
								await prepareToolCallDispatch(finalMessage, context, config, requestSignal),
							);
						}
						if (addedPartial) {
							context.messages[context.messages.length - 1] = finalMessage;
						} else {
							context.messages.push(finalMessage);
						}
						if (!addedPartial) {
							stream.push({ type: "message_start", message: snapshotAssistantMessage(finalMessage) });
						}
						stream.push({ type: "message_end", message: snapshotAssistantMessage(finalMessage) });
						await finishChat(finalMessage);
						return finalMessage;
					}
					if (requestSignal?.aborted) {
						return await finishAbortedStream();
					}

					await yieldIfDue();

					switch (event.type) {
						case "start":
							partialMessage = event.partial;
							if (addedPartial) {
								context.messages[context.messages.length - 1] = partialMessage;
								completedToolCallIds.clear();

								const messageSnapshot = snapshotAssistantMessage(partialMessage);
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							} else {
								context.messages.push(partialMessage);
								addedPartial = true;
								stream.push({ type: "message_start", message: snapshotAssistantMessage(partialMessage) });
							}
							break;

						case "text_start":
						case "text_delta":
						case "text_end":
						case "image_end":
						case "thinking_start":
						case "thinking_delta":
						case "thinking_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							if (partialMessage) {
								if (event.type === "toolcall_end") {
									completedToolCallIds.add(event.toolCall.id);
								}
								partialMessage = event.partial;
								context.messages[context.messages.length - 1] = partialMessage;
								config.onAssistantMessageEvent?.(partialMessage, event);

								const messageSnapshot = snapshotAssistantMessage(partialMessage);
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							}
							break;
					}
				}
			} finally {
				detachAbortListener?.();
			}

			let trailing = await response.result();
			if (harmonyMitigationEnabled) {
				const detection = detectHarmonyLeakInAssistantMessage(trailing);
				if (detection) {
					const recovered = recoverHarmonyToolCall(trailing, detection);
					const removed = recovered?.removed ?? extractHarmonyRemoved(trailing, detection);
					if (addedPartial) {
						emitDiscardedHarmonyPartial(
							partialMessage,
							stream,
							`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
						);
						context.messages.pop();
						addedPartial = false;
					}
					throw new HarmonyLeakInterruption(detection, removed, recovered);
				}
			}
			trailing = snapshotAssistantMessage(trailing);
			if (addedPartial) {
				context.messages[context.messages.length - 1] = trailing;
				stream.push({ type: "message_end", message: snapshotAssistantMessage(trailing) });
			}
			await finishChat(trailing);
			return trailing;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
		throw err;
	}
}

function retainCompletedToolCalls(
	message: AssistantMessage,
	completedToolCallIds: ReadonlySet<string>,
): AssistantMessage {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
	let droppedIncompleteToolCall = false;
	const content = message.content.filter(block => {
		if (block.type !== "toolCall") return true;
		const keep = completedToolCallIds.has(block.id);
		if (!keep) droppedIncompleteToolCall = true;
		return keep;
	});
	if (!droppedIncompleteToolCall) return message;
	return {
		...message,
		content,
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
	};
}

function recoverTransientErrorToolTurn(
	message: AssistantMessage,
	availableTools: ReadonlyArray<Pick<AgentTool, "name" | "customWireName">>,
): AssistantMessage {
	if (message.stopReason !== "error") return message;
	const toolCalls = message.content.filter(block => block.type === "toolCall");
	if (toolCalls.length === 0) return message;
	const stopDetailType = message.stopDetails?.type;
	const stopDetailCategory = message.stopDetails?.category;
	if (
		stopDetailType === "refusal" ||
		stopDetailType === "sensitive" ||
		stopDetailCategory === "refusal" ||
		stopDetailCategory === "sensitive"
	)
		return message;
	const availableToolNames = new Set<string>();
	for (const tool of availableTools) {
		availableToolNames.add(tool.name);
		if (tool.customWireName !== undefined) availableToolNames.add(tool.customWireName);
	}
	if (!toolCalls.every(toolCall => availableToolNames.has(toolCall.name))) return message;
	const errorText = `${message.errorMessage ?? ""}\n${message.stopDetails?.explanation ?? ""}`;
	if (
		!AIError.isStreamReadErrorText(errorText) &&
		!AIError.isStreamEnvelopeErrorText(errorText) &&
		!AIError.isTransientStreamParseError(message.errorMessage) &&
		!AIError.isTransientStreamParseError(message.stopDetails?.explanation)
	)
		return message;
	return {
		...message,
		stopReason: "toolUse",
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
		errorMessage: undefined,
		errorId: undefined,
		errorStatus: undefined,
	};
}

function emitDiscardedHarmonyPartial(
	partialMessage: AssistantMessage | null,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	errorMessage: string,
): void {
	if (!partialMessage) return;
	stream.push({
		type: "message_end",
		message: snapshotAssistantMessage({ ...partialMessage, stopReason: "error", errorMessage }),
	});
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(child => typeof child === "string");
}

function toolScopedAbortReason(signal: AbortSignal | undefined): ToolScopedAbortReason | undefined {
	const reason = signal?.reason;
	if (!reason || typeof reason !== "object") return undefined;
	if (Reflect.get(reason, "kind") !== "tool-scoped-abort") return undefined;
	if (typeof Reflect.get(reason, "message") !== "string") return undefined;
	if (typeof Reflect.get(reason, "defaultToolCallMessage") !== "string") return undefined;
	return isStringRecord(Reflect.get(reason, "toolCallMessages")) ? reason : undefined;
}

function buildToolCallAbortMessages(
	message: AssistantMessage,
	reason: ToolScopedAbortReason,
): Record<string, string> | undefined {
	let hasToolCall = false;
	const messages: Record<string, string> = {};
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		hasToolCall = true;
		messages[block.id] = reason.toolCallMessages[block.id] ?? reason.defaultToolCallMessage;
	}
	return hasToolCall ? messages : undefined;
}

export function abortReasonText(signal: AbortSignal | undefined): string {
	const scopedReason = toolScopedAbortReason(signal);
	if (scopedReason) return scopedReason.message;
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0) {
		return reason.message;
	}
	return "Request was aborted";
}

function emitAbortedAssistantMessage(
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	completedToolCallIds: ReadonlySet<string>,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	requestSignal: AbortSignal | undefined,
): AssistantMessage {
	const model = config.getModel?.() ?? config.model;
	const errorMessage = abortReasonText(requestSignal);
	const errorId =
		errorMessage === "Request was aborted"
			? AIError.create(AIError.Flag.Abort)
			: AIError.classify(requestSignal?.reason) || undefined;
	const base: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage, errorId }
		: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage,
				errorId,
				timestamp: Date.now(),
			};

	const retained = retainCompletedToolCalls(base, completedToolCallIds);
	const scopedAbort = toolScopedAbortReason(requestSignal);
	const toolCallAbortMessages = scopedAbort ? buildToolCallAbortMessages(retained, scopedAbort) : undefined;
	if (toolCallAbortMessages) {
		retained.toolCallAbortMessages = toolCallAbortMessages;
	}
	const abortedMessage = snapshotAssistantMessage(retained);
	if (addedPartial) {
		context.messages[context.messages.length - 1] = abortedMessage;
	} else {
		context.messages.push(abortedMessage);
		stream.push({ type: "message_start", message: snapshotAssistantMessage(abortedMessage) });
	}
	stream.push({ type: "message_end", message: snapshotAssistantMessage(abortedMessage) });
	return abortedMessage;
}

interface PreparedToolCall {
	tool: AgentTool<any> | undefined;

	args: Record<string, unknown>;
	validationErrorMessage?: string;
	blocked?: boolean;
	blockReason?: string;
	prepareError?: unknown;
}

const preparedDispatchByMessage = new WeakMap<AssistantMessage, Map<string, PreparedToolCall>>();

function resolveToolForCall(
	tools: AgentTool<any>[] | undefined,
	toolCall: AgentToolCall,
	resolveFallbackTool: AgentLoopConfig["resolveFallbackTool"],
): AgentTool<any> | undefined {
	return (
		tools?.find(t => t.name === toolCall.name) ??
		tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name) ??
		resolveFallbackTool?.(toolCall.name)
	);
}

async function prepareToolCallDispatch(
	assistantMessage: AssistantMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<Map<string, PreparedToolCall>> {
	const { resolveFallbackTool, intentTracing, beforeToolCall } = config;
	const prepared = new Map<string, PreparedToolCall>();
	for (const toolCall of assistantMessage.content) {
		if (toolCall.type !== "toolCall") continue;
		if ((toolCall as CursorExecResolvedCarrier)[kCursorExecResolved] === true) continue;
		const tool = resolveToolForCall(context.tools, toolCall, resolveFallbackTool);
		const entry: PreparedToolCall = { tool, args: toolCall.arguments as Record<string, unknown> };
		prepared.set(toolCall.id, entry);
		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			} else if (typeof tool?.intent === "function") {
				try {
					const derived = tool.intent(strippedArgs as never)?.trim();
					if (derived) {
						toolCall.intent = derived;
					}
				} catch {}
			}
		}
		const validate = (args: Record<string, unknown>): Record<string, unknown> | undefined => {
			try {
				if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
				return validateToolArguments(tool, { ...toolCall, arguments: args });
			} catch (validationError) {
				if (tool?.lenientArgValidation) {
					const fallback = { ...args };
					delete fallback.__parseError;
					delete fallback.__rawJson;
					return fallback;
				}
				entry.args = "__parseError" in args ? { __parseError: args.__parseError } : args;
				entry.validationErrorMessage =
					validationError instanceof Error ? validationError.message : String(validationError);
				return undefined;
			}
		};
		const effectiveArgs = validate(argsForExecution);
		if (effectiveArgs === undefined) continue;
		entry.args = effectiveArgs;
		if (!beforeToolCall || !tool) continue;
		let beforeResult: BeforeToolCallResult | undefined;
		try {
			beforeResult = await beforeToolCall(
				{ assistantMessage, toolCall, tool, args: effectiveArgs, context },
				signal,
			);
		} catch (e) {
			entry.prepareError = e;
			continue;
		}
		if (beforeResult?.block) {
			entry.blocked = true;
			entry.blockReason = beforeResult.reason;
			continue;
		}
		if (beforeResult?.args !== undefined) {
			const revised = validate(beforeResult.args);
			if (revised === undefined) continue;

			toolCall.arguments = beforeResult.args;
			entry.args = revised;
		}
	}
	return prepared;
}

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
): Promise<{ toolResults: ToolResultMessage[] }> {
	const tools = currentContext.tools;
	const {
		hasSteeringMessages,
		hasIrcInterrupts,
		interruptMode = "immediate",
		getToolContext,
		transformToolCallArguments,
		resolveFallbackTool,
		afterToolCall,
	} = config;
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
	);
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const ircAbortController = new AbortController();

	const steeringSoftController = new AbortController();

	const nonInterruptibleSignal: AbortSignal = signal ?? new AbortController().signal;
	const interruptibleSignal: AbortSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal, ircAbortController.signal])
		: AbortSignal.any([steeringAbortController.signal, ircAbortController.signal]);
	const interruptState: { triggered: boolean; source?: SteeringInterruptSource | "irc" } = { triggered: false };

	const preparedDispatch =
		preparedDispatchByMessage.get(assistantMessage) ??
		(await prepareToolCallDispatch(assistantMessage, currentContext, config, signal));

	const records = toolCalls.map(toolCall => {
		const prepared = preparedDispatch.get(toolCall.id) ?? {
			tool: resolveToolForCall(tools, toolCall, resolveFallbackTool),
			args: toolCall.arguments as Record<string, unknown>,
		};
		const { tool, args } = prepared;
		const interruptibleMode = tool?.interruptible;
		let interruptible = false;
		if (typeof interruptibleMode === "function") {
			try {
				interruptible = interruptibleMode(args);
			} catch {
				interruptible = false;
			}
		} else {
			interruptible = interruptibleMode === true;
		}
		return {
			toolCall,
			tool,
			args,
			interruptible,
			signal: interruptible ? interruptibleSignal : nonInterruptibleSignal,
			started: false,
			result: undefined as AgentToolResult<any> | undefined,
			isError: false,
			skipped: false,
			toolResultMessage: undefined as ToolResultMessage | undefined,
			resultEmitted: false,
			validationErrorMessage: prepared.validationErrorMessage,
			blocked: prepared.blocked === true,
			blockReason: prepared.blockReason,
			prepareError: prepared.prepareError,
		};
	});

	const checkIrcInterrupts = async (): Promise<void> => {
		if (!shouldInterruptImmediately || signal?.aborted || interruptState.triggered) return;
		if (hasIrcInterrupts && (await hasIrcInterrupts())) {
			interruptState.triggered = true;
			interruptState.source = "irc";
			ircAbortController.abort();
			steeringSoftController.abort();
		}
	};

	const checkSteering = async (): Promise<void> => {
		if (!shouldInterruptImmediately || signal?.aborted) {
			return;
		}

		let steeringQueued = false;
		let steeringSource: SteeringInterruptSource | undefined;
		if (hasSteeringMessages) {
			const queuedState = await hasSteeringMessages();
			if (typeof queuedState === "boolean") {
				steeringQueued = queuedState;
				steeringSource = queuedState ? "user" : undefined;
			} else {
				const state: SteeringQueueState = queuedState;
				steeringQueued = state.queued;
				steeringSource = state.source ?? (state.queued ? "unknown" : undefined);
			}
		}
		if (steeringQueued) {
			if (!steeringAbortController.signal.aborted) {
				interruptState.triggered = true;
				interruptState.source = steeringSource ?? "unknown";
				steeringAbortController.abort();
				steeringSoftController.abort();
			}
			return;
		}
		await checkIrcInterrupts();
	};

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			providerMetadata: result.providerMetadata,
			isError,
			...(result.useless && !isError ? { useless: true } : {}),
			timestamp: Date.now(),
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered && (record.interruptible || interruptState.source !== "irc")) {
			record.skipped = true;
			return;
		}

		if (agentPauseGate.paused) await agentPauseGate.waitUntilResumed(record.signal);

		const { toolCall, tool } = record;

		if (record.validationErrorMessage !== undefined) {
			emitToolResult(
				record,
				{
					content: [{ type: "text" as const, text: record.validationErrorMessage }],
					details: { isError: true, error: record.validationErrorMessage },
				},
				true,
			);
			return;
		}
		const effectiveArgs = record.args;
		if (record.signal.aborted) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				status: "aborted",
			});
			emitToolResult(record, createToolSignalAbortedResult(record.signal), true);
			return;
		}
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: effectiveArgs,
			intent: toolCall.intent,
		});

		const toolSpan = startExecuteToolSpan(telemetry, {
			tool,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			args: effectiveArgs,
			parent: invokeAgentSpan,
		});
		if (toolSpan && toolCall.intent) {
			toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
		}

		let result: AgentToolResult<any> = { content: [], details: {} };
		let isError = false;
		let caughtError: unknown;
		let completedToolExecution = false;
		let executionStarted = false;

		await runInActiveSpan(toolSpan, async () => {
			try {
				if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
				if (record.signal.aborted) {
					result = createToolSignalAbortedResult(record.signal);
					isError = true;
					return;
				}

				if (record.prepareError !== undefined) throw record.prepareError;
				if (record.blocked) {
					throw new ToolCallBlockedError(record.blockReason);
				}
				const executionArgs = transformToolCallArguments
					? transformToolCallArguments(effectiveArgs, toolCall.name)
					: effectiveArgs;
				record.args = executionArgs;

				const toolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
							steeringSignal: steeringSoftController.signal,
							providerMetadata: toolCall.providerMetadata,
						})
					: undefined;
				executionStarted = true;
				const rawResult = await tool.execute(
					toolCall.id,
					executionArgs,
					record.signal,
					partialResult => {
						stream.push({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: executionArgs,
							partialResult: coerceToolResult(partialResult).result,
						});
					},
					toolContext,
				);
				completedToolExecution = true;
				const coerced = coerceToolResult(rawResult);
				result = coerced.result;
				if (coerced.malformed || result.isError) isError = true;
			} catch (e) {
				caughtError = e;
				result = {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
				};
				isError = true;
			}

			if (afterToolCall && (!record.signal.aborted || completedToolExecution)) {
				try {
					const after = await afterToolCall(
						{
							assistantMessage,
							toolCall,
							args: record.args,
							result,
							isError,
							context: currentContext,
						},
						record.signal,
					);
					if (after) {
						const coerced = coerceToolResult({
							content: after.content ?? result.content,
							details: after.details ?? result.details,
							isError: after.isError ?? result.isError,
							providerMetadata: after.providerMetadata ?? result.providerMetadata,
							useless: after.useless ?? result.useless,
						});
						result = coerced.result;
						isError = coerced.malformed || (after.isError ?? isError);
					}
				} catch (e) {
					caughtError = e;
					result = {
						content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
						details: {},
					};
					isError = true;
				}
			}
		});

		const interrupted = interruptState.triggered;
		const perToolAborted = record.signal.aborted;
		const abortedDuringExecution = perToolAborted && isError && !completedToolExecution;
		if (interrupted && abortedDuringExecution) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(interruptState.source, executionStarted), true);
		} else {
			emitToolResult(record, result, isError);
		}

		const firstTextBlock = result.content?.[0];
		const errorMessageForSpan =
			caughtError === undefined && isError && firstTextBlock?.type === "text" ? firstTextBlock.text : undefined;
		const status = abortedDuringExecution
			? "aborted"
			: caughtError instanceof ToolCallBlockedError
				? "blocked"
				: isError
					? "error"
					: "ok";
		finishExecuteToolSpan(telemetry, toolSpan, {
			result,
			isError,
			status,
			errorMessage: errorMessageForSpan,
			errorObject: caughtError,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});

		await checkSteering();
	};

	let lastExclusive: Promise<void> = Promise.resolve();
	let sharedTasks: Promise<void>[] = [];
	const tasks: Promise<void>[] = [];

	const watchSteeringWhileRunning =
		shouldInterruptImmediately && (hasSteeringMessages !== undefined || hasIrcInterrupts !== undefined);
	const eventDrivenSteeringWatch =
		watchSteeringWhileRunning && config.waitForSteeringMessages !== undefined && hasSteeringMessages !== undefined;
	const steeringWatchAbortController = new AbortController();
	const steeringWatchSignal = signal
		? AbortSignal.any([signal, steeringWatchAbortController.signal])
		: steeringWatchAbortController.signal;

	const { promise: watchAborted, resolve: resolveWatchAbort } = Promise.withResolvers<void>();
	if (steeringWatchSignal.aborted) {
		resolveWatchAbort();
	} else {
		steeringWatchSignal.addEventListener("abort", () => resolveWatchAbort(), { once: true });
	}
	const watchAbortedFalse = watchAborted.then(() => false);
	const steeringWatchPromise = eventDrivenSteeringWatch
		? (async (): Promise<void> => {
				while (!steeringWatchSignal.aborted) {
					const steeringQueued = config.waitForSteeringMessages?.(steeringWatchSignal).then(
						() => true,
						() => false,
					);
					const steeringChecked = checkSteering().then(
						() => true,
						() => false,
					);
					if (!(await Promise.race([steeringChecked, watchAbortedFalse]))) return;
					if (steeringWatchSignal.aborted || interruptState.triggered) return;
					if (!(await Promise.race([steeringQueued, watchAbortedFalse]))) return;
				}
			})()
		: undefined;

	const steeringWatchTimer =
		watchSteeringWhileRunning && (!eventDrivenSteeringWatch || hasIrcInterrupts !== undefined)
			? setInterval(
					() => void (eventDrivenSteeringWatch ? checkIrcInterrupts() : checkSteering()),
					STEERING_INTERRUPT_POLL_MS,
				)
			: undefined;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrencyMode = record.tool?.concurrency;
		let concurrency: "shared" | "exclusive";
		if (typeof concurrencyMode === "function") {
			try {
				concurrency = concurrencyMode(record.args);
			} catch {
				concurrency = "exclusive";
			}
		} else {
			concurrency = concurrencyMode ?? "shared";
		}
		const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
		const task = start.then(() => runTool(record, index));
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}
	try {
		await Promise.allSettled(tasks);
	} finally {
		steeringWatchAbortController.abort();
		await steeringWatchPromise?.catch(() => undefined);
		clearInterval(steeringWatchTimer);
	}

	await yieldIfDue();

	for (const record of records) {
		if (!record.toolResultMessage) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: record.toolCall.id,
				toolName: record.toolCall.name,
				status: "skipped",
			});
			emitToolResult(record, createSkippedToolResult(interruptState.source, false), true);
		}
	}

	return { toolResults: emittedToolResults };
}

export interface SyntheticToolResultDetails {
	__synthetic: true;
	source:
		| "assistant_stop_aborted"
		| "assistant_stop_error"
		| "assistant_stop_skipped"
		| "assistant_stop_length"
		| "interrupt_skipped";
	executed: false;
	upstreamError?: string;
}

interface InterruptedToolResultDetails {
	__interrupted: true;
	source: "interrupt_skipped";
	execution: "started";
}

export function isSyntheticToolResultMessage(
	message: AgentMessage | undefined,
): message is ToolResultMessage<SyntheticToolResultDetails> {
	return (
		message?.role === "toolResult" &&
		(message.details as SyntheticToolResultDetails | undefined)?.__synthetic === true
	);
}

function syntheticDetailsFor(
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage: string | undefined,
): SyntheticToolResultDetails {
	const source: SyntheticToolResultDetails["source"] =
		reason === "aborted"
			? "assistant_stop_aborted"
			: reason === "error"
				? "assistant_stop_error"
				: reason === "length"
					? "assistant_stop_length"
					: "assistant_stop_skipped";
	return {
		__synthetic: true,
		source,
		executed: false,
		...(reason === "error" && errorMessage ? { upstreamError: errorMessage } : {}),
	};
}

export function createSyntheticToolResultMessage(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
): ToolResultMessage<SyntheticToolResultDetails> {
	const message =
		reason === "aborted"
			? "Tool execution was aborted"
			: reason === "length"
				? "Tool call was not executed because the assistant hit its output token limit (stop_reason: length) before the arguments could complete; the recorded arguments are truncated and unsafe to run. Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls (e.g. for `write`/`edit`, write the first chunk then append the rest with subsequent `edit` insert ops, or break the file into multiple `write` targets)"
				: reason === "skipped"
					? "Tool call was not executed because the assistant ended its turn"
					: "Tool call was not executed because the provider stream ended with an error before the tool could run";
	const details = syntheticDetailsFor(reason, errorMessage);
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details,
		isError: true,
		timestamp: Date.now(),
	};
}

function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
): ToolResultMessage {
	const toolResultMessage = createSyntheticToolResultMessage(toolCall, reason, errorMessage);
	const result: AgentToolResult<SyntheticToolResultDetails> = {
		content: toolResultMessage.content,
		details: toolResultMessage.details,
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});
	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

function createToolSignalAbortedResult(signal: AbortSignal): AgentToolResult<unknown> {
	const reason = abortReasonText(signal);
	return {
		content: [{ type: "text", text: `Tool was not executed because the run was aborted: ${reason}.` }],
		details: {},
	};
}

function createSkippedToolResult(
	source: SteeringInterruptSource | "irc" | undefined,
	executionStarted: boolean,
): AgentToolResult<SyntheticToolResultDetails | InterruptedToolResultDetails> {
	let reason = "pending steering message";
	let blocker = "queued message";
	if (source === "user") {
		reason = "queued user message";
		blocker = "queued message";
	} else if (source === "agent") {
		reason = "pending parent steering message";
		blocker = "steering message";
	} else if (source === "system") {
		reason = "pending system advisory";
		blocker = "advisory";
	} else if (source === "irc") {
		reason = "pending peer interrupt";
		blocker = "interrupt";
	}
	return {
		content: [
			{
				type: "text",
				text: `Skipped due to ${reason}. Do not count this skipped result as completed work or verification. After the ${blocker} is handled on the next step, retry the skipped tool if it is still needed.`,
			},
		],
		details: executionStarted
			? { __interrupted: true, source: "interrupt_skipped", execution: "started" }
			: { __synthetic: true, source: "interrupt_skipped", executed: false },
	};
}
