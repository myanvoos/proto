import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import {
	$env,
	$flag,
	asRecord,
	fetchWithRetry,
	getInstallId,
	logger,
	parseStreamingJson,
	readSseJson,
	structuredCloneJSON,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey, isOfficialCodexApiUrl } from "../stream";
import type {
	Api,
	AssistantMessage,
	AudioContent,
	CodexCompactionContext,
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	ImageContent,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	Usage,
	VideoContent,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	stripOpenAIResponsesComputerLinkedReasoningIdsForReplay,
} from "../utils";
import { clearStreamingPartialJson, kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { escapeHarmonyControlTokens, isHarmonyDialectModel } from "../utils/harmony-leak";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { getProxyForUrl } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexLiteShapedBody,
	type CodexReasoningContext,
	type CodexRequestOptions,
	type InputItem,
	type RequestBody,
	resolveCodexResponsesLite,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { CodexApiError } from "./openai-codex/response-handler";
import type {
	ResponseComputerToolCall,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
} from "./openai-responses-wire";
import {
	accumulateCustomToolCallInputDelta,
	accumulateToolCallArgumentsDelta,
	appendMessageContentPart,
	appendMessageTextDelta,
	appendReasoningSummaryPart,
	appendReasoningSummaryPartDone,
	appendReasoningSummaryTextDelta,
	appendResponsesImageResult,
	appendResponsesToolResultMessages,
	applyOpenAIServiceTier,
	applyReasoningSummaryDone,
	buildResponsesDeltaInput,
	computerCallMetadata,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createSequentialCutoffSummaryState,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	escapeReplayedControlTokens,
	finalizeCustomToolCallInputDone,
	finalizeMessageText,
	finalizePendingResponsesToolCalls,
	finalizeReasoningThinking,
	finalizeToolCallArgumentsDone,
	getOpenAIPromptCacheKey,
	hasExecutableIncompleteResponsesToolCalls,
	isOpenAIResponsesProgressEvent,
	mapOpenAIResponsesStopReason,
	normalizeOpenAIPromptCacheKey,
	populateResponsesUsageFromResponse,
	promoteResponsesToolUseStopReason,
	type SequentialCutoffSummaryState,
} from "./openai-shared";
import { redactSensitiveInObject, transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | null;

	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;

	responsesLite?: boolean;

	clientMetadata?: Record<string, string>;

	parentTurnId?: string;

	onModerationMetadata?: (metadata: unknown) => void;
}

export interface OpenAICodexCompactionBody extends CodexLiteShapedBody {
	model: string;
	[key: string]: unknown;
}

export interface OpenAICodexCompactionStreamOptions extends OpenAICodexResponsesOptions {
	apiKey: string;
}

export interface OpenAICodexCompatibilityMetadataOptions {
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	requestKind: OpenAICodexRequestKind;
	compaction?: CodexCompactionRequestContext;
	startNewTurn?: boolean;
	turnStartedAtUnixMs?: number;
	clientMetadata?: Readonly<Record<string, string>>;

	parentTurnId?: string;

	includeInstallationHeader?: boolean;
}

export interface OpenAICodexCompatibilityMetadata {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
}

export interface OpenAICodexCompactionResetOptions {
	providerSessionState?: Map<string, ProviderSessionState>;
	sessionId?: string;
	compaction: CodexCompactionContext;
}

export function createOpenAICodexCompactionRequestContext(options: {
	context: CodexCompactionContext | undefined;
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
}): CodexCompactionRequestContext | undefined {
	const context = options.context;
	if (!context) return undefined;
	return {
		operationId: context.operationId,
		trigger: context.trigger,
		reason: context.reason,
		implementation: options.implementation,
		phase: context.phase,
		strategy: context.strategy,
	};
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;

function resolveCodexSseMaxAttempts(value: number | undefined): number {
	if (value === undefined) return CODEX_MAX_RETRIES + 1;
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.trunc(value));
}
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_PING_INTERVAL_MS = Number($env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS || 10_000);
const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS || 60_000);
const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = Number($env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY || 4096);

const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = Number($env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS || 30_000);

const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS || 300_000);

const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS || 300_000);
const CODEX_WEBSOCKET_RETRY_BUDGET = Number($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET || CODEX_MAX_RETRIES);
const CODEX_WEBSOCKET_RETRY_DELAY_MS = Number($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS || CODEX_RETRY_DELAY_MS);
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;
const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";

export type CodexAttestationProvider = () => Promise<string | undefined>;

let codexAttestationProvider: CodexAttestationProvider | undefined;

export function setCodexAttestationProvider(provider: CodexAttestationProvider | undefined): void {
	codexAttestationProvider = provider;
}

export async function getCodexAttestationHeader(accountId: string | undefined): Promise<string | undefined> {
	if (!accountId || !codexAttestationProvider) return undefined;
	try {
		return await codexAttestationProvider();
	} catch {
		return undefined;
	}
}
const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";

const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";

const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";

const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];

const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES = new Set(["response.done", "response.incomplete"]);

const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

function isCodexStreamProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES.has(type);
}

function extractCodexFrameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = (frame as { response?: { id?: unknown } }).response;
	const id = response?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractCodexFrameSequenceNumber(frame: Record<string, unknown>): number | undefined {
	const raw = (frame as { sequence_number?: unknown }).sequence_number;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
}

type CodexWebSocketTimeoutDetails = {
	lastEventAt: number;
	lastEventType?: string;
	lastProgressAt: number;
	lastProgressEventType?: string;
};

function createCodexWebSocketTimeoutMessage(reason: string, details: CodexWebSocketTimeoutDetails): string {
	const now = Date.now();
	const lastEvent = details.lastEventType
		? `${details.lastEventType} ${Math.max(0, now - details.lastEventAt)}ms ago`
		: "none";
	const lastProgress = details.lastProgressEventType
		? `${details.lastProgressEventType} ${Math.max(0, now - details.lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

type CodexTransport = "sse" | "websocket";
type CodexEventItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| ResponseCustomToolCall
	| ResponseComputerToolCall
	| ResponseOutputItem.ImageGenerationCall;
type CodexOutputBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number });

interface CodexResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		orchestration_input_tokens?: number;
		orchestration_input_cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		orchestration_output_tokens?: number;
	};
}

export interface OpenAICodexTurnRequestDiagnostics {
	transport: "sse" | "websocket";
	previousResponseIdPresent: boolean;
	inputItemCount: number;
	inputItemTypes: string[];
	firstInputItemType?: string;
	inputJsonBytes: number;
	promptCacheKey?: string;
	toolsHash?: string;
	optionsHash: string;
	canAppendBeforeRequest: boolean;
}

export interface OpenAICodexTurnUsageDiagnostics {
	rawInputTokens: number;
	rawCachedTokens: number;
	rawUncachedTokens: number;
	rawOutputTokens: number;
	rawTotalTokens?: number;
	rawOrchestrationInputTokens?: number;
	rawOrchestrationCachedTokens?: number;
	rawOrchestrationOutputTokens?: number;
	displayedInputTokens: number;
	displayedOutputTokens: number;
	displayedCacheReadTokens: number;
	displayedCacheWriteTokens: number;
	displayedTotalTokens: number;
	displayedOrchestrationInputTokens: number;
	displayedOrchestrationCacheReadTokens: number;
	displayedOrchestrationOutputTokens: number;
}

export interface OpenAICodexTurnDiagnostics {
	request: OpenAICodexTurnRequestDiagnostics;
	usage?: OpenAICodexTurnUsageDiagnostics;
}

export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	lastTurn?: OpenAICodexTurnDiagnostics;
}

type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexTurnStateCell {
	value?: string;
}

interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
	metadataSessions: Map<string, CodexMetadataSessionState>;
}

export type OpenAICodexRequestKind = "turn" | "prewarm" | "compaction";

interface CodexMetadataSessionState {
	sessionId: string;
	threadId: string;
	windowId: string;
	turnId?: string;
	turnStartedAtUnixMs?: number;
	compactionOperationId?: string;
	reuseTurnForNextRequest?: boolean;
	turnStates: Map<string, CodexTurnStateCell>;
}

interface CodexCompatibilityIdentity {
	installationId: string;
	sessionId: string;
	threadId: string;
	windowId: string;

	turnMetadataHeaderJson?: string;
}

interface CodexRequestMetadata extends CodexCompatibilityIdentity {
	turnId: string;

	turnMetadataJson: string;
	turnMetadataHeaderJson: string;
	clientMetadata: Record<string, string>;
}

const CODEX_RESERVED_METADATA_KEYS: Record<string, true> = {
	installation_id: true,
	[OPENAI_HEADERS.INSTALLATION_ID]: true,
	session_id: true,
	thread_id: true,
	turn_id: true,
	window_id: true,
	[OPENAI_HEADERS.WINDOW_ID]: true,
	[OPENAI_HEADERS.TURN_METADATA]: true,
	[OPENAI_HEADERS.PARENT_THREAD_ID]: true,
	[OPENAI_HEADERS.SUBAGENT]: true,
	request_kind: true,
	compaction: true,

	code_mode_tool_names: true,
	tool_namespaces_info: true,
	turn_started_at_unix_ms: true,
	forked_from_thread_id: true,
	parent_thread_id: true,
	parent_turn_id: true,
	subagent_kind: true,
	thread_source: true,
	sandbox: true,
	workspaces: true,
};

function createCodexMetadataSessionState(sessionId: string): CodexMetadataSessionState {
	return {
		sessionId,
		threadId: crypto.randomUUID(),
		windowId: crypto.randomUUID(),
		turnStates: new Map(),
	};
}

function getOrCreateCodexMetadataSessionState(
	sessionId: string,
	providerState: CodexProviderSessionState | undefined,
): CodexMetadataSessionState {
	if (!providerState) return createCodexMetadataSessionState(sessionId);
	const existing = providerState.metadataSessions.get(sessionId);
	if (existing) return existing;
	const created = createCodexMetadataSessionState(sessionId);
	providerState.metadataSessions.set(sessionId, created);
	return created;
}

function getOrCreateCodexTurnState(
	session: CodexMetadataSessionState,
	compatibilityKey: string | undefined,
): CodexTurnStateCell {
	if (!compatibilityKey) return {};
	const existing = session.turnStates.get(compatibilityKey);
	if (existing) return existing;
	const created: CodexTurnStateCell = {};
	session.turnStates.set(compatibilityKey, created);
	return created;
}

function clearCodexTurnStatesForNewTurn(
	session: CodexMetadataSessionState,
	startNewTurn: boolean,
	compaction: CodexCompactionRequestContext | undefined,
): void {
	if (startNewTurn && compaction?.phase !== "standalone_turn") session.turnStates.clear();
}

function createCodexCompatibilityIdentity(session: CodexMetadataSessionState): CodexCompatibilityIdentity {
	return {
		installationId: getInstallId(),
		sessionId: session.sessionId,
		threadId: session.threadId,
		windowId: session.windowId,
	};
}

function resolveCodexStartNewTurn(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	compaction: CodexCompactionRequestContext | undefined,
	override: boolean | undefined,
): boolean {
	if (requestKind !== "compaction") {
		if (requestKind === "turn") {
			const reuseCompactionTurn = session.reuseTurnForNextRequest === true;
			session.reuseTurnForNextRequest = false;
			session.compactionOperationId = undefined;
			if (reuseCompactionTurn) return false;
		}
		return override ?? requestKind === "turn";
	}
	if (!compaction) return override ?? false;
	const startsNewOperation = session.compactionOperationId !== compaction.operationId;
	if (startsNewOperation) session.reuseTurnForNextRequest = false;
	session.compactionOperationId = compaction.operationId;
	return override ?? (compaction.phase !== "mid_turn" && startsNewOperation);
}

function toAsciiJsonString(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(
		/[\x7f-\uffff]/g,
		char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function createCodexRequestMetadata(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	options: {
		startNewTurn: boolean;
		turnStartedAtUnixMs?: number;
		clientMetadata?: Readonly<Record<string, string>>;
		parentTurnId?: string;
		compaction?: CodexCompactionRequestContext;
		toolNamespacesInfo?: unknown;
	},
): CodexRequestMetadata {
	if (options.startNewTurn || !session.turnId) {
		session.turnId = crypto.randomUUID();
		session.turnStartedAtUnixMs = options.turnStartedAtUnixMs;
	}
	const identity = createCodexCompatibilityIdentity(session);

	const parentTurnId = options.parentTurnId?.trim() ? options.parentTurnId : undefined;
	const extra: Record<string, string> = {};
	const callerMetadata = options.clientMetadata;
	if (callerMetadata) {
		for (const key in callerMetadata) {
			if (!CODEX_RESERVED_METADATA_KEYS[key]) extra[key] = callerMetadata[key];
		}
	}
	const turnMetadata: Record<string, unknown> = {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: session.turnId,
		window_id: identity.windowId,
		request_kind: requestKind,
	};
	if (parentTurnId) turnMetadata.parent_turn_id = parentTurnId;
	if (options.compaction) {
		turnMetadata.compaction = {
			trigger: options.compaction.trigger,
			reason: options.compaction.reason,
			implementation: options.compaction.implementation,
			phase: options.compaction.phase,
			strategy: options.compaction.strategy,
		};
	}
	if (session.turnStartedAtUnixMs !== undefined) {
		turnMetadata.turn_started_at_unix_ms = session.turnStartedAtUnixMs;
	}
	for (const key in extra) turnMetadata[key] = extra[key];

	const turnMetadataHeaderJson = toAsciiJsonString(turnMetadata);
	let turnMetadataJson = turnMetadataHeaderJson;
	if (options.toolNamespacesInfo !== undefined) {
		turnMetadata.tool_namespaces_info = options.toolNamespacesInfo;
		turnMetadataJson = toAsciiJsonString(turnMetadata);
	}
	const clientMetadata: Record<string, string> = {
		[OPENAI_HEADERS.INSTALLATION_ID]: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		[OPENAI_HEADERS.WINDOW_ID]: identity.windowId,
		turn_id: session.turnId,
	};

	if (parentTurnId) clientMetadata.parent_turn_id = parentTurnId;
	clientMetadata[OPENAI_HEADERS.TURN_METADATA] = turnMetadataJson;
	return {
		...identity,
		turnId: session.turnId,
		turnMetadataJson,
		turnMetadataHeaderJson,
		clientMetadata,
	};
}

function applyCodexCompatibilityHeaders(headers: Headers, metadata: CodexCompatibilityIdentity): void {
	headers.set(OPENAI_HEADERS.SCOPED_SESSION_ID, metadata.sessionId);
	headers.set(OPENAI_HEADERS.THREAD_ID, metadata.threadId);
	headers.set(OPENAI_HEADERS.WINDOW_ID, metadata.windowId);
	if (metadata.turnMetadataHeaderJson) {
		headers.set(OPENAI_HEADERS.TURN_METADATA, metadata.turnMetadataHeaderJson);
	} else {
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
}

export function createOpenAICodexCompatibilityMetadata(
	options: OpenAICodexCompatibilityMetadataOptions,
): OpenAICodexCompatibilityMetadata {
	const providerState = getCodexProviderSessionState(options.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId) ?? crypto.randomUUID();
	const session = getOrCreateCodexMetadataSessionState(sessionId, providerState);
	const startNewTurn = resolveCodexStartNewTurn(
		session,
		options.requestKind,
		options.compaction,
		options.startNewTurn,
	);
	clearCodexTurnStatesForNewTurn(session, startNewTurn, options.compaction);
	const metadata = createCodexRequestMetadata(session, options.requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: options.turnStartedAtUnixMs ?? (startNewTurn || !session.turnId ? Date.now() : undefined),
		clientMetadata: options.clientMetadata,
		parentTurnId: options.parentTurnId,
		compaction: options.compaction,
	});
	const headers = new Headers();
	applyCodexCompatibilityHeaders(headers, metadata);
	if (options.includeInstallationHeader) {
		headers.set(OPENAI_HEADERS.INSTALLATION_ID, metadata.installationId);
	}
	return {
		clientMetadata: { ...metadata.clientMetadata },
		headers: Object.fromEntries(headers.entries()),
	};
}

export function resetOpenAICodexHistoryAfterCompaction(options: OpenAICodexCompactionResetOptions): void {
	const providerState = options.providerSessionState?.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (!isCodexProviderSessionState(providerState)) return;
	for (const websocketState of providerState.webSocketSessions.values()) {
		resetCodexWebSocketAppendState(websocketState);
	}
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId);
	if (!sessionId) return;
	const metadataSession = providerState.metadataSessions.get(sessionId);
	if (!metadataSession) return;
	metadataSession.windowId = crypto.randomUUID();
	metadataSession.compactionOperationId = undefined;
	metadataSession.reuseTurnForNextRequest = options.compaction.phase !== "standalone_turn";
}

interface CodexRequestContext {
	apiKey: string;
	accountId?: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	codexClientVersion: string;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	isolatedTransportState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	turnState: CodexTurnStateCell;
	responsesLite: boolean;
	requestMetadata?: CodexRequestMetadata;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
}

interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
	firstEventTimeoutMs: number | undefined;
	websocketIdleTimeoutMs: number | undefined;
	websocketFirstEventTimeoutMs: number | undefined;
}

interface CodexOpenItem {
	item: CodexEventItem;
	block: CodexOutputBlock | null;

	contentIndex: number;
	itemId?: string;
	outputIndex?: number;
}

class CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;

	openItems = new Map<string, CodexOpenItem>();

	openItemsByOutputIndex = new Map<number, CodexOpenItem>();

	currentEntry: CodexOpenItem | null = null;

	currentItem: CodexEventItem | null = null;
	currentBlock: CodexOutputBlock | null = null;
	nativeOutputItems: Array<Record<string, unknown>> = [];

	cutoffSummaries: SequentialCutoffSummaryState = createSequentialCutoffSummaryState();

	pendingSummaryDeltas = new Map<CodexOpenItem, string[]>();
	websocketStreamRetries = 0;
	providerRetryAttempt = 0;
	sawTerminalEvent = false;
	canSafelyReplayWebsocketOverSse = true;
	whitespaceToolCallArgumentsDelta?: CodexWhitespaceToolCallArgumentsDeltaState;
	whitespaceLoopRetries = 0;

	constructor(initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
		websocketState?: CodexWebSocketSessionState;
	}) {
		this.eventStream = initial.eventStream;
		this.requestBodyForState = initial.requestBodyForState;
		this.transport = initial.transport;
		this.websocketState = initial.websocketState;
	}

	resetAccumulators(): void {
		this.openItems.clear();
		this.openItemsByOutputIndex.clear();
		this.currentEntry = null;
		this.currentItem = null;
		this.currentBlock = null;
		this.nativeOutputItems.length = 0;
		this.pendingSummaryDeltas.clear();
		this.cutoffSummaries = createSequentialCutoffSummaryState();
	}

	openItemForEvent(rawEvent: Record<string, unknown>): CodexOpenItem | null {
		const itemId = typeof rawEvent.item_id === "string" ? rawEvent.item_id : "";
		if (itemId) return this.openItems.get(itemId) ?? null;
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		if (outputIndex !== undefined) return this.openItemsByOutputIndex.get(outputIndex) ?? null;
		return this.currentEntry;
	}
	queueSummaryDelta(entry: CodexOpenItem | null | undefined, delta: string): void {
		if (entry?.block?.type !== "thinking" || delta.length === 0) return;
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		pending.push(delta);
		this.pendingSummaryDeltas.set(entry, pending);
	}

	takeSummaryDeltas(entry: CodexOpenItem | null | undefined): string[] {
		if (!entry) return [];
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		this.pendingSummaryDeltas.delete(entry);
		return pending;
	}

	closeOpenItem(entry: CodexOpenItem | null | undefined): void {
		if (!entry) return;
		if (entry.itemId) this.openItems.delete(entry.itemId);
		if (entry.outputIndex !== undefined) this.openItemsByOutputIndex.delete(entry.outputIndex);
		if (this.currentEntry === entry) {
			this.currentEntry = null;
			this.currentItem = null;
			this.currentBlock = null;
		}
	}

	observeWhitespaceToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		delta: string,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		if (!isJsonWhitespaceOnly(delta)) {
			this.whitespaceToolCallArgumentsDelta = undefined;
			return undefined;
		}

		const itemId =
			typeof rawEvent.item_id === "string" && rawEvent.item_id.length > 0
				? rawEvent.item_id
				: (this.currentItem?.id ?? "");
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		const sequenceNumber =
			typeof rawEvent.sequence_number === "number" && Number.isFinite(rawEvent.sequence_number)
				? Math.trunc(rawEvent.sequence_number)
				: undefined;
		let state = this.whitespaceToolCallArgumentsDelta;
		if (!state || state.itemId !== itemId || state.outputIndex !== outputIndex) {
			state = {
				itemId,
				outputIndex,
				consecutiveEvents: 0,
				consecutiveChars: 0,
				firstSequenceNumber: sequenceNumber,
			};
			this.whitespaceToolCallArgumentsDelta = state;
		}

		state.consecutiveEvents += 1;
		state.consecutiveChars += delta.length;
		state.lastSequenceNumber = sequenceNumber;
		if (
			state.consecutiveEvents < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT &&
			state.consecutiveChars < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT
		) {
			return undefined;
		}

		const itemLabel = itemId ? ` for item ${itemId}` : "";
		const sequenceLabel =
			state.firstSequenceNumber === undefined || state.lastSequenceNumber === undefined
				? ""
				: `, sequence ${state.firstSequenceNumber}..${state.lastSequenceNumber}`;
		return {
			message: `Interrupted OpenAI Codex response after ${state.consecutiveEvents} consecutive whitespace-only tool-call argument delta events (${state.consecutiveChars} chars${sequenceLabel})${itemLabel}.`,
		};
	}

	handleToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";

		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;

		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "function_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateToolCallArgumentsDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleToolCallArgumentsDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "function_call" || entry.block?.type !== "toolCall") return;
		const args = (rawEvent as { arguments?: string }).arguments;
		if (typeof args === "string") finalizeToolCallArgumentsDone(entry.block, args);
	}

	handleCustomToolCallInputDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";

		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateCustomToolCallInputDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleCustomToolCallInputDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return;
		const input = (rawEvent as { input?: string }).input;
		if (typeof input === "string") finalizeCustomToolCallInputDone(entry.block, input);
	}

	handleResponseCreated(rawEvent: Record<string, unknown>): void {
		const response = (rawEvent as { response?: { id?: string } }).response;
		const state = this.websocketState;
		if (state && this.transport === "websocket" && typeof response?.id === "string" && response.id.length > 0) {
			state.lastResponseId = response.id;
		}
	}
}

interface CodexWhitespaceToolCallArgumentsDeltaState {
	itemId: string;
	outputIndex?: number;
	consecutiveEvents: number;
	consecutiveChars: number;
	firstSequenceNumber?: number;
	lastSequenceNumber?: number;
}

interface CodexWhitespaceToolCallArgumentsDeltaInterruption {
	message: string;
}

interface CodexStreamFailureContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	options: OpenAICodexResponsesOptions | undefined;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
}

function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		metadataSessions: new Map(),
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
			state.metadataSessions.clear();
		},
	};
	return state;
}

function isCodexProviderSessionState(state: ProviderSessionState | undefined): state is CodexProviderSessionState {
	return (
		state !== undefined &&
		"webSocketSessions" in state &&
		state.webSocketSessions instanceof Map &&
		"webSocketPublicToPrivate" in state &&
		state.webSocketPublicToPrivate instanceof Map &&
		"metadataSessions" in state &&
		state.metadataSessions instanceof Map
	);
}

function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (isCodexProviderSessionState(existing)) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof CodexWebSocketTransportError)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("websocket send failed") ||
		message.includes("websocket ping failed") ||
		message.includes("websocket pong timeout") ||
		message.includes("websocket message queue exceeded") ||
		message.includes("websocket request already in progress") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}
function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

function updateCodexSessionMetadataFromHeaders(
	turnState: CodexTurnStateCell | undefined,
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if ((!turnState && !state) || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const responseTurnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.value === undefined && responseTurnState && responseTurnState.length > 0) {
		turnState.value = responseTurnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (state && modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}

function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

function notifyCodexWebSocketInbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	parsed: Record<string, unknown>,
	text: string,
): void {
	const type = typeof parsed.type === "string" ? parsed.type : null;
	const raw: string[] = [`: ws ← ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: type, data: text, raw });
}

function notifyCodexWebSocketOutbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	request: Record<string, unknown>,
	payload: string,
): void {
	const type = typeof request.type === "string" ? request.type : null;
	const raw: string[] = [`: ws → ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

function notifyCodexWebSocketMalformed(
	observer: ((event: RawSseEvent) => void) | undefined,
	data: unknown,
	error: unknown,
): void {
	const text = typeof data === "string" ? data : "";
	const reason = error instanceof Error ? error.message : String(error);
	const raw: string[] = [`: ws ← (parse-error: ${reason})`];
	if (text) raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: "parse_error", data: text, raw });
}

export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? model.applyPatchToolType === "freeform" : false;
	const mapName = (name: string): Record<string, string> | undefined => {
		const directTool = tools.find(tool => tool.name === name);
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		const offeredTool = customTool ?? directTool;
		if (!offeredTool) return undefined;
		if (offeredTool.native?.type === "computer" && model?.supportsComputerUse === true) {
			return { type: "computer" };
		}
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "computer") {
		const computer = tools.find(tool => tool.native?.type === "computer");
		if (!computer) return undefined;
		return model?.supportsComputerUse === true ? { type: "computer" } : { type: "function", name: computer.name };
	}
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}
function unrollCodexComputerItems(items: ResponseInput, supportsImageDetailOriginal: boolean): ResponseInput {
	const replayItems = stripOpenAIResponsesComputerLinkedReasoningIdsForReplay(items);
	const unrolled: ResponseInput = [];
	for (const item of replayItems) {
		if (item.type === "computer_call") {
			const actions = item.actions ?? (item.action ? [item.action] : []);
			unrolled.push({
				type: "function_call",
				call_id: item.call_id,
				name: "computer",
				arguments: JSON.stringify({ actions }),
				status: item.status,
			});
			continue;
		}
		if (item.type === "computer_call_output") {
			const image =
				typeof item.output.image_url === "string" && item.output.image_url.length > 0
					? ({
							type: "input_image",
							detail: supportsImageDetailOriginal ? "original" : "auto",
							image_url: item.output.image_url,
						} satisfies ResponseInputContent)
					: typeof item.output.file_id === "string" && item.output.file_id.length > 0
						? ({
								type: "input_image",
								detail: supportsImageDetailOriginal ? "original" : "auto",
								file_id: item.output.file_id,
							} satisfies ResponseInputContent)
						: undefined;
			unrolled.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: image ? "(see attached image)" : "",
			});
			if (image) {
				unrolled.push({
					role: "user",
					content: [{ type: "input_text", text: "Attached image from computer tool result:" }, image],
				});
			}
			continue;
		}
		unrolled.push(item);
	}
	return unrolled;
}

function unrollCodexComputerAssistantMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "toolCall" || block.providerMetadata?.type !== "computer") return block;
		changed = true;
		const call: ToolCall = {
			...block,
			arguments: { actions: structuredCloneJSON(block.providerMetadata.actions) },
		};
		delete call.providerMetadata;
		return call;
	});
	return changed ? { ...message, content } : message;
}

function unrollCodexComputerToolResult(message: ToolResultMessage): ToolResultMessage {
	if (message.providerMetadata?.type !== "computer") return message;
	const result: ToolResultMessage = { ...message };
	delete result.providerMetadata;
	return result;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function resolveCodexCostServiceTier(res: unknown, req?: unknown): ServiceTier | "default" | undefined {
	switch (res) {
		case "flex":
			return "flex";
		case "priority":
			return "priority";
		default:
			if (req === "flex" || req === "priority") {
				return req;
			}
			return "default";
	}
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "id">,
	usage: AssistantMessage["usage"],
	resTier: unknown,
	reqTier: unknown,
): void {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier);
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resetOutputState(output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "stop";
	output.stopDetails = undefined;
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const websocketIdleTimeoutMs = options?.streamIdleTimeoutMs ?? CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const websocketFirstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isCodexStreamProgressEvent,
		});
	return {
		requestAbortController,
		requestSignal,
		wrapCodexSseStream,
		firstEventTimeoutMs,
		websocketIdleTimeoutMs,
		websocketFirstEventTimeoutMs,
	};
}

function createCodexRequestContext(
	model: Model<"openai-codex-responses">,
	transformedBody: RequestBody,
	options: OpenAICodexResponsesOptions | undefined,
	contextOptions: {
		isolateCompactionTransport: boolean;
		startNewTurn?: boolean;
		turnStartedAtUnixMs?: number;
	},
): CodexRequestContext {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const accountId = getCodexAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);

	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const requestHeaders = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const isolatedTransportState =
		contextOptions.isolateCompactionTransport && options?.codexCompaction
			? createCodexProviderSessionState()
			: undefined;
	const transportProviderSessionState = isolatedTransportState ?? providerSessionState;
	const responsesLite = resolveCodexResponsesLite(model, options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (sessionKey && publicSessionKey) {
		transportProviderSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const sharedWebsocketState =
		sessionKey && providerSessionState
			? isolatedTransportState
				? providerSessionState.webSocketSessions.get(sessionKey)
				: getCodexWebSocketSessionState(sessionKey, providerSessionState)
			: undefined;
	const websocketState =
		sessionKey && isolatedTransportState
			? getCodexWebSocketSessionState(sessionKey, isolatedTransportState)
			: sharedWebsocketState;
	if (isolatedTransportState && websocketState && sharedWebsocketState) {
		websocketState.disableWebsocket = sharedWebsocketState.disableWebsocket;
		websocketState.modelsEtag = sharedWebsocketState.modelsEtag;
	}
	const metadataSessionId = transportSessionId ?? crypto.randomUUID();
	const metadataSession = getOrCreateCodexMetadataSessionState(metadataSessionId, providerSessionState);
	const compaction = options?.codexCompaction;
	const requestKind: OpenAICodexRequestKind = compaction ? "compaction" : "turn";
	const startNewTurn = resolveCodexStartNewTurn(metadataSession, requestKind, compaction, contextOptions.startNewTurn);
	const standaloneCompaction = compaction?.phase === "standalone_turn";
	clearCodexTurnStatesForNewTurn(metadataSession, startNewTurn, compaction);

	const turnState = standaloneCompaction ? {} : getOrCreateCodexTurnState(metadataSession, sessionKey);
	const requestMetadata = createCodexRequestMetadata(metadataSession, requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: compaction
			? startNewTurn || !metadataSession.turnId
				? Date.now()
				: undefined
			: contextOptions.turnStartedAtUnixMs,
		clientMetadata: transformedBody.client_metadata,
		parentTurnId: options?.parentTurnId,
		compaction,
		toolNamespacesInfo: options?.toolNamespacesInfo,
	});
	transformedBody.client_metadata = requestMetadata.clientMetadata;
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		isolatedTransportState,
		websocketState,
		turnState,
		responsesLite,
		requestMetadata,
		codexClientVersion,
		transformedBody,
		rawRequestDump,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<CodexRequestContext> {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);
	return createCodexRequestContext(model, transformedBody, options, {
		isolateCompactionTransport: true,
		startNewTurn: options?.codexCompaction ? undefined : !isCodexWithinTurnContinuation(context),
		turnStartedAtUnixMs: options?.codexCompaction ? undefined : getCodexTurnStartedAtUnixMs(context),
	});
}

export async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = getOpenAIPromptCacheKey(options),
): Promise<RequestBody> {
	const params: RequestBody = {
		model: model.requestModelId ?? model.id,
		input: convertMessages(model, context),
		stream: true,
		prompt_cache_key: promptCacheKey,
	};

	applyOpenAIServiceTier(params, options?.serviceTier, model);
	if (context.tools && context.tools.length > 0) {
		params.tools = convertOpenAICodexResponsesTools(context.tools, model);
		if (options?.toolChoice) {
			const toolChoice = normalizeCodexToolChoice(options.toolChoice, context.tools, model);
			if (toolChoice) {
				params.tool_choice = toolChoice;
			}
		}
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	if (options?.clientMetadata && Object.keys(options.clientMetadata).length > 0) {
		params.client_metadata = { ...options.clientMetadata };
	}
	const codexOptions: CodexRequestOptions = {
		reasoningEffort: options?.reasoning,
		reasoningOff: options?.forceReasoningOff,
		reasoningSummary: options?.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	return transformRequestBody(params, model, codexOptions, { developerMessages });
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = CODEX_WEBSOCKET_RETRY_BUDGET;
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					model,
					options,
					requestContext,
					requestSetup,
					websocketState,
					websocketRetries,
					options ? event => options.onSseEvent?.(event, model) : undefined,
				);
			} catch (error) {
				if (!(error instanceof CodexWebSocketTransportError)) throw error;
				const fatalWebSocketMessage = error.message.toLowerCase();
				const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
					fatalWebSocketMessage.includes(pattern.toLowerCase()),
				);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback);
				CODEX_DEBUG &&
					logger.debug("[codex] codex websocket fallback", {
						error: error.message,
						retry: websocketRetries,
						retryBudget: websocketRetryBudget,
						activated: activateFallback,
						fatal: isFatal,
					});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	}
	return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
}

function toCodexRequestBody(body: OpenAICodexCompactionBody): RequestBody {
	const request: RequestBody = { model: body.model };
	for (const key in body) {
		if (key !== "model") request[key] = body[key];
	}
	return request;
}

export async function openCodexCompactionEventStream(
	model: Model<"openai-codex-responses">,
	body: OpenAICodexCompactionBody,
	options: OpenAICodexCompactionStreamOptions,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const requestSetup = createRequestSetup(options);
	let requestContext: CodexRequestContext;
	let initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	};
	try {
		requestContext = createCodexRequestContext(model, toCodexRequestBody(body), options, {
			isolateCompactionTransport: false,
		});
		initial = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
	} catch (error) {
		requestSetup.requestAbortController.abort();
		throw error;
	}

	if (requestContext.websocketState) {
		requestContext.websocketState.lastTransport = initial.transport;

		resetCodexWebSocketAppendState(requestContext.websocketState);
	}
	return streamCodexCompactionEvents(model, options, requestSetup, requestContext, initial);
}

async function* streamCodexCompactionEvents(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexCompactionStreamOptions,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
	initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	},
): AsyncGenerator<Record<string, unknown>> {
	let completed = false;
	const websocketState = requestContext.websocketState;
	const previousTurnState = requestContext.turnState.value;
	const previousModelsEtag = websocketState?.modelsEtag;
	try {
		if (initial.transport === "websocket") {
			const bufferedEvents: Array<Record<string, unknown>> = [];
			try {
				for await (const event of initial.eventStream) bufferedEvents.push(event);
			} catch (error) {
				if (options.signal?.aborted || !(error instanceof CodexWebSocketTransportError)) {
					throw error;
				}
				const state = requestContext.websocketState;
				if (state) recordCodexWebSocketFailure(state, true);
				const fallback = await openCodexSseTransport(model, requestContext, requestSetup, options, state);
				if (state) state.lastTransport = fallback.transport;
				yield* drainCodexCompactionEvents(fallback.eventStream, requestContext);
				completed = true;
				return;
			}

			for (const event of bufferedEvents) {
				applyCodexCompactionResponseMetadata(requestContext, event);
				yield event;
			}
		} else {
			yield* drainCodexCompactionEvents(initial.eventStream, requestContext);
		}
		completed = true;
	} finally {
		if (!completed) {
			requestSetup.requestAbortController.abort();
			requestContext.turnState.value = previousTurnState;
			if (websocketState) websocketState.modelsEtag = previousModelsEtag;
		}
	}
}

function applyCodexCompactionResponseMetadata(
	requestContext: CodexRequestContext,
	event: Record<string, unknown>,
): void {
	if (event.type !== "response.metadata") return;
	updateCodexSessionMetadataFromHeaders(
		requestContext.turnState,
		requestContext.websocketState,
		toCodexHeaders(event.headers),
	);
}

async function* drainCodexCompactionEvents(
	events: AsyncGenerator<Record<string, unknown>>,
	requestContext: CodexRequestContext,
): AsyncGenerator<Record<string, unknown>> {
	for await (const event of events) {
		applyCodexCompactionResponseMetadata(requestContext, event);
		yield event;
	}
}
async function openCodexWebSocketTransport(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	websocketState: CodexWebSocketSessionState,
	retry: number,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const canAppendBeforeRequest = websocketState.canAppend === true;
	const chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);

	const websocketClientMetadata = { ...(chainedBody.client_metadata ?? {}) };
	if (requestContext.responsesLite) {
		websocketClientMetadata[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY] = "true";
	}
	if (requestContext.turnState.value) {
		websocketClientMetadata[X_CODEX_TURN_STATE_HEADER] = requestContext.turnState.value;
	}
	let websocketRequest = {
		type: "response.create",
		...chainedBody,
		client_metadata: websocketClientMetadata,
	};
	const replacementWebsocketRequest = await options?.onPayload?.(websocketRequest, model);
	if (replacementWebsocketRequest !== undefined) {
		websocketRequest = replacementWebsocketRequest as typeof websocketRequest;
	}
	recordCodexTurnRequestDiagnostics(websocketState, websocketRequest, "websocket", canAppendBeforeRequest);
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.codexClientVersion,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.turnState,
		requestContext.responsesLite,
		requestContext.requestMetadata,
		await getCodexAttestationHeader(requestContext.accountId),
	);
	const requestBodyForState = structuredCloneJSON(requestContext.transformedBody);

	if (websocketRequest.stream_options === undefined) {
		delete requestBodyForState.stream_options;
	} else {
		requestBodyForState.stream_options = websocketRequest.stream_options;
	}
	requestContext.rawRequestDump.body = websocketRequest;
	CODEX_DEBUG &&
		logger.debug("[codex] codex websocket request", {
			url: toWebSocketUrl(requestContext.url),
			model: requestContext.transformedBody.model,
			reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
			headers: redactHeaders(websocketHeaders),
			sentTurnStateHeader: websocketHeaders.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: websocketHeaders.has(X_MODELS_ETAG_HEADER),
			requestType: websocketRequest.type,
			retry,
			retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
		});
	const websocketConnection = await getOrCreateCodexWebSocketConnection(
		websocketState,
		requestContext.turnState,
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		model.provider,
		requestSetup.requestSignal,
	);
	const eventStream = websocketConnection.streamRequest(
		websocketRequest,
		{
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		},
		requestSetup.requestSignal,
		onSseEvent,
	);
	return {
		eventStream,
		requestBodyForState,
		transport: "websocket",
	};
}

function getCodexTurnStartedAtUnixMs(context: Context): number {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role === "user" && Number.isFinite(message.timestamp)) {
			return Math.trunc(message.timestamp);
		}
	}
	return Date.now();
}

function isCodexWithinTurnContinuation(context: Context): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const role = context.messages[i]?.role;
		if (role === "toolResult") continue;
		return role === "assistant";
	}
	return false;
}

async function openCodexSseTransport(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
	body = requestContext.transformedBody,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const open = async (wireBody: RequestBody) => {
		requestContext.rawRequestDump.body = wireBody;
		return requestSetup.wrapCodexSseStream(
			await openCodexSseEventStream(
				requestContext.url,
				requestContext.requestHeaders,
				requestContext.accountId,
				requestContext.apiKey,
				requestContext.transportSessionId,
				wireBody,
				state,
				requestContext.turnState,
				requestContext.responsesLite,
				requestContext.codexClientVersion,
				requestContext.requestMetadata,
				requestSetup.requestSignal,
				requestSetup.firstEventTimeoutMs,
				options?.codexSseMaxAttempts,
				event => options?.onSseEvent?.(event, model),
				options?.fetch,
			),
		);
	};
	const canAppendBeforeRequest = state?.canAppend === true;
	let wireBody = body;
	const replacementWireBody = await options?.onPayload?.(wireBody, model);
	if (replacementWireBody !== undefined) {
		wireBody = replacementWireBody as RequestBody;
	}
	recordCodexTurnRequestDiagnostics(state, wireBody, "sse", canAppendBeforeRequest);
	return { eventStream: await open(wireBody), requestBodyForState: structuredCloneJSON(wireBody), transport: "sse" };
}

function isJsonWhitespaceOnly(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
			return false;
		}
	}
	return true;
}

function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "" };
	}
	if (item.type === "message") {
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		return { type: "text", text: "", textSignature: encodeTextSignatureV1(item.id, phase) };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			[kStreamingPartialJson]: item.arguments || "",
		};
	}
	if (item.type === "computer_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: "computer",
			arguments: {},
			providerMetadata: computerCallMetadata(item),
			[kStreamingPartialJson]: "",
		};
	}
	if (item.type === "custom_tool_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			[kStreamingPartialJson]: item.input ?? "",
		};
	}
	return null;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

const CODEX_STALE_PREVIOUS_RESPONSE_CODES: Record<string, true> = {
	previous_response_not_found: true,

	codex_previous_response_stale: true,
};

function isCodexStalePreviousResponseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (
		"code" in error &&
		typeof error.code === "string" &&
		Object.hasOwn(CODEX_STALE_PREVIOUS_RESPONSE_CODES, error.code)
	) {
		return true;
	}

	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

async function handleCodexStreamFailure(context: CodexStreamFailureContext, error: unknown): Promise<AssistantMessage> {
	const { output } = context;
	if (context.requestContext.websocketState) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		context.requestContext.websocketState.modelsEtag = undefined;
	}
	const result = await AIError.finalize(error, {
		api: context.model.api,
		provider: context.model.provider,
		model: context.model.id,
		signal: context.options?.signal,
		rawRequestDump: context.requestContext.rawRequestDump,
	});
	output.stopReason = result.stopReason;
	output.errorStatus = result.status;
	output.errorId = result.id;
	output.errorMessage = result.message;
	output.duration = performance.now() - context.startTime;
	if (context.firstTokenTime) {
		output.ttft = context.firstTokenTime - context.startTime;
	}
	return output;
}

class CodexStreamProcessor {
	runtime: CodexStreamRuntime;
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	options: OpenAICodexResponsesOptions | undefined;
	requestSetup: CodexRequestSetup;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;

	constructor(init: {
		runtime: CodexStreamRuntime;
		model: Model<"openai-codex-responses">;
		output: AssistantMessage;
		stream: AssistantMessageEventStream;
		options: OpenAICodexResponsesOptions | undefined;
		requestSetup: CodexRequestSetup;
		requestContext: CodexRequestContext;
		startTime: number;
	}) {
		this.runtime = init.runtime;
		this.model = init.model;
		this.output = init.output;
		this.stream = init.stream;
		this.options = init.options;
		this.requestSetup = init.requestSetup;
		this.requestContext = init.requestContext;
		this.startTime = init.startTime;
	}

	get #sequentialCutoffSummaries(): boolean {
		return this.runtime.requestBodyForState.stream_options?.reasoning_summary_delivery === "sequential_cutoff";
	}

	async process(): Promise<CodexStreamCompletion> {
		const { output, stream } = this;
		stream.push({ type: "start", partial: output });

		while (true) {
			try {
				let firstTokenTime = this.firstTokenTime;
				for await (const rawEvent of this.runtime.eventStream) {
					firstTokenTime = this.#handleStreamEvent(rawEvent, firstTokenTime);
					if (this.runtime.sawTerminalEvent) break;
				}
				return { firstTokenTime };
			} catch (error) {
				const recovered = await this.#recoverStreamError(error);
				if (!recovered) {
					throw error;
				}
				stream.push({ type: "start", partial: output });
			}
		}
	}

	#handleStreamEvent(rawEvent: Record<string, unknown>, firstTokenTime: number | undefined): number | undefined {
		const { output, stream } = this;
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) return firstTokenTime;

		if (eventType === "response.output_item.added") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			if (!firstTokenTime) firstTokenTime = performance.now();
			const item = rawEvent.item as CodexEventItem;
			this.runtime.currentItem = item;
			this.runtime.currentBlock = createOutputBlockForItem(item);
			let contentIndex = -1;
			if (this.runtime.currentBlock) {
				output.content.push(this.runtime.currentBlock);
				contentIndex = output.content.length - 1;
			}

			const itemId = typeof (item as { id?: string }).id === "string" ? (item as { id: string }).id : undefined;
			const outputIndex =
				typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
					? Math.trunc(rawEvent.output_index)
					: undefined;
			const entry: CodexOpenItem = { item, block: this.runtime.currentBlock, contentIndex, itemId, outputIndex };
			this.runtime.currentEntry = entry;
			if (itemId) this.runtime.openItems.set(itemId, entry);
			if (outputIndex !== undefined) this.runtime.openItemsByOutputIndex.set(outputIndex, entry);
			if (!this.runtime.currentBlock) return firstTokenTime;
			stream.push({
				type: getOutputBlockStartEventType(this.runtime.currentBlock),
				contentIndex,
				partial: output,
			});
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.added") {
			if (this.#sequentialCutoffSummaries) return firstTokenTime;
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "reasoning") {
				appendReasoningSummaryPart(
					entry.item,
					(rawEvent as { part: ResponseReasoningItem["summary"][number] }).part,
				);
			}
			return firstTokenTime;
		}
		if (eventType === "response.reasoning_summary_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (this.#sequentialCutoffSummaries) {
				this.runtime.queueSummaryDelta(entry, delta);
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryTextDelta(entry.item, entry.block, delta, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_text.done") {
			if (!this.#sequentialCutoffSummaries) return firstTokenTime;
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				this.runtime.takeSummaryDeltas(entry);
				if (!firstTokenTime) firstTokenTime = performance.now();
				const summaryIndex =
					typeof rawEvent.summary_index === "number" && Number.isFinite(rawEvent.summary_index)
						? Math.trunc(rawEvent.summary_index)
						: 0;
				applyReasoningSummaryDone(
					this.runtime.cutoffSummaries,
					entry.block,
					typeof rawEvent.text === "string" ? rawEvent.text : "",
					summaryIndex,
					stream,
					output,
					entry.contentIndex,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				entry.block.thinking += delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: entry.contentIndex,
					delta,
					partial: output,
				});
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.done") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (this.#sequentialCutoffSummaries) {
				if (entry && this.runtime.pendingSummaryDeltas.has(entry)) this.runtime.queueSummaryDelta(entry, "\n\n");
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.content_part.added") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "message") {
				appendMessageContentPart(
					entry.item,
					(rawEvent as { part?: ResponseOutputMessage["content"][number] }).part,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "message" && entry.block?.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					(rawEvent as { delta?: string }).delta || "",
					stream,
					output,
					entry.contentIndex,
					eventType === "response.refusal.delta" ? "refusal" : "output_text",
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.delta") {
			const interruption = this.runtime.handleToolCallArgumentsDelta(rawEvent, stream, output);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleToolCallArgumentsDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.delta") {
			const interruption = this.runtime.handleCustomToolCallInputDelta(rawEvent, stream, output);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleCustomToolCallInputDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.output_item.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.#handleOutputItemDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.created") {
			this.runtime.handleResponseCreated(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
			this.#handleResponseCompleted(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.metadata") {
			updateCodexSessionMetadataFromHeaders(
				this.requestContext.turnState,
				this.requestContext.websocketState,
				toCodexHeaders(rawEvent.headers),
			);
			const moderation = asRecord(rawEvent.metadata)?.[CODEX_MODERATION_METADATA_KEY];
			if (moderation !== undefined) {
				try {
					this.options?.onModerationMetadata?.(moderation);
				} catch {}
			}
			return firstTokenTime;
		}

		if (eventType === "error" || eventType === "response.failed") {
			throw createCodexProviderStreamError(rawEvent);
		}

		return firstTokenTime;
	}

	#flushSummaryDeltas(entry: CodexOpenItem | null): void {
		if (entry?.block?.type !== "thinking") return;
		for (const delta of this.runtime.takeSummaryDeltas(entry)) {
			entry.block.thinking += delta;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: entry.contentIndex,
				delta,
				partial: this.output,
			});
		}
	}
	#handleOutputItemDone(rawEvent: Record<string, unknown>): void {
		const { runtime, output, stream } = this;
		const rawItem = rawEvent.item;
		if (!rawItem || typeof rawItem !== "object") return;
		const item = structuredCloneJSON(rawItem) as CodexEventItem;
		if (item.type === "image_generation_call" && item.result) item.status = "completed";
		runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

		const itemId = "id" in item && typeof item.id === "string" ? item.id : "";
		const entry = (itemId ? runtime.openItems.get(itemId) : null) ?? runtime.openItemForEvent(rawEvent);
		const block = entry?.block ?? null;
		const contentIndex = entry?.contentIndex ?? output.content.length - 1;

		if (item.type === "image_generation_call" && item.result) {
			appendResponsesImageResult(output, stream, item.result);
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "reasoning" && block?.type === "thinking") {
			this.#flushSummaryDeltas(entry);
			block.thinking = finalizeReasoningThinking(
				item,
				block.thinking,
				this.#sequentialCutoffSummaries ? this.runtime.cutoffSummaries : undefined,
			);
			block.thinkingSignature = JSON.stringify(item);
			stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "message" && block?.type === "text") {
			block.text = finalizeMessageText(item, block.text);
			const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
			block.textSignature = encodeTextSignatureV1(item.id, phase);
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "function_call") {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: parseStreamingJson(item.arguments || "{}"),
			};
			if (block?.type === "toolCall") {
				block.arguments = toolCall.arguments;
				clearStreamingPartialJson(block);
			}

			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}

		if (item.type === "computer_call") {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: "computer",
				arguments: {},
				providerMetadata: computerCallMetadata(item),
			};
			let resolvedContentIndex = contentIndex;
			if (block?.type === "toolCall") {
				block.id = toolCall.id;
				block.providerMetadata = toolCall.providerMetadata;
				clearStreamingPartialJson(block);
			} else {
				output.content.push(toolCall);
				resolvedContentIndex = output.content.length - 1;
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex: resolvedContentIndex, toolCall, partial: output });
			return;
		}

		if (item.type === "custom_tool_call") {
			const partial = block?.type === "toolCall" ? block[kStreamingPartialJson] : undefined;
			const rawInput = partial && partial.length > 0 ? partial : (item.input ?? "");
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: { input: rawInput },
				customWireName: item.name,
			};
			if (block?.type === "toolCall") {
				block.arguments = { input: rawInput };
				clearStreamingPartialJson(block);
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}
	}

	#handleResponseCompleted(rawEvent: Record<string, unknown>): void {
		const { runtime, model, output } = this;
		runtime.sawTerminalEvent = true;
		const rawResponse = rawEvent.response;
		const response = rawResponse && typeof rawResponse === "object" ? rawResponse : undefined;
		const responseId = response && "id" in response && typeof response.id === "string" ? response.id : undefined;
		const usage = response && "usage" in response ? parseCodexResponseUsage(response.usage) : undefined;
		const serviceTier =
			response && "service_tier" in response ? parseCodexServiceTier(response.service_tier) : undefined;
		const status = response && "status" in response ? parseCodexResponseStatus(response.status) : undefined;
		const endTurn = response && "end_turn" in response ? response.end_turn : undefined;

		populateResponsesUsageFromResponse(output, usage);
		recordCodexTurnUsageDiagnostics(runtime.websocketState, usage, output.usage);
		if (responseId) {
			output.responseId = responseId;
		}

		const state = runtime.websocketState;
		if (state) {
			if (runtime.transport !== "websocket") {
				resetCodexWebSocketAppendState(state);
			} else {
				state.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
				const replayableResponseItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
					structuredCloneJSON(runtime.nativeOutputItems),
				);
				if (responseId && replayableResponseItems) {
					state.lastResponseId = responseId;
					state.lastResponseItems = replayableResponseItems;
					state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed";
				} else {
					state.canAppend = false;
				}
			}
		}

		const incompleteDetails =
			response &&
			"incomplete_details" in response &&
			response.incomplete_details &&
			typeof response.incomplete_details === "object"
				? response.incomplete_details
				: undefined;
		const shouldPromoteIncompleteToolUse =
			status === "incomplete" &&
			incompleteDetails !== undefined &&
			"reason" in incompleteDetails &&
			incompleteDetails.reason === "max_output_tokens" &&
			hasExecutableIncompleteResponsesToolCalls(output);
		finalizePendingResponsesToolCalls(output);

		calculateCost(model, output.usage);
		applyCodexServiceTierPricing(model, output.usage, serviceTier, runtime.requestBodyForState.service_tier);
		output.stopReason = mapOpenAIResponsesStopReason(status);
		promoteResponsesToolUseStopReason(
			output,
			endTurn === true ? true : endTurn === false ? false : undefined,
			shouldPromoteIncompleteToolUse,
		);
	}

	async #recoverStreamError(error: unknown): Promise<boolean> {
		if (await this.#tryRecoverWhitespaceToolCallLoop(error)) {
			return true;
		}
		if (await this.#tryReconnectWebSocketOnConnectionLimit(error)) {
			return true;
		}
		if (await this.#tryRecoverPreviousResponseNotFound(error)) {
			return true;
		}
		if (await this.#tryReplayWebsocketFailureOverSse(error)) {
			return true;
		}
		if (await this.#tryRetryProviderError(error)) {
			return true;
		}
		return false;
	}

	async #tryRecoverWhitespaceToolCallLoop(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexWhitespaceToolCallLoopError)) {
			return false;
		}

		this.#dropTrailingDegenerateToolCall();
		if (
			this.runtime.whitespaceLoopRetries >= CODEX_WHITESPACE_LOOP_RETRY_LIMIT ||
			!this.runtime.canSafelyReplayWebsocketOverSse ||
			this.output.content.some(block => block.type !== "thinking") ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.whitespaceLoopRetries += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex turn after whitespace-only tool-call argument loop", {
				retry: this.runtime.whitespaceLoopRetries,
				retryBudget: CODEX_WHITESPACE_LOOP_RETRY_LIMIT,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		this.runtime.whitespaceToolCallArgumentsDelta = undefined;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS * this.runtime.whitespaceLoopRetries, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	#dropTrailingDegenerateToolCall(): void {
		const { runtime, output } = this;
		const block = runtime.currentBlock;
		if (block && block.type === "toolCall" && output.content[output.content.length - 1] === block) {
			output.content.pop();
		}
		runtime.closeOpenItem(runtime.currentEntry);
	}

	async #tryReconnectWebSocketOnConnectionLimit(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexProviderStreamError) || error.code !== "websocket_connection_limit_reached") {
			return false;
		}
		const websocketState = this.requestContext.websocketState;
		if (!websocketState || this.runtime.transport !== "websocket" || this.options?.signal?.aborted) {
			return false;
		}

		websocketState.connection?.close("connection_limit");
		websocketState.connection = undefined;
		resetCodexWebSocketAppendState(websocketState);

		if (this.output.content.length > 0 && !this.runtime.canSafelyReplayWebsocketOverSse) {
			return false;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket connection limit reached, reconnecting", {
				hadContent: this.output.content.length > 0,
				retry: this.runtime.websocketStreamRetries,
			});

		if (this.output.content.length > 0) {
			this.runtime.resetAccumulators();
			resetOutputState(this.output);
			this.firstTokenTime = undefined;
			recordCodexWebSocketFailure(websocketState, true);
			await this.#reopenSseStream(websocketState);
			return true;
		}

		this.runtime.resetAccumulators();
		this.firstTokenTime = undefined;
		if (this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET) {
			recordCodexWebSocketFailure(websocketState, true);
			await this.#reopenSseStream(websocketState);
			return true;
		}
		this.runtime.websocketStreamRetries += 1;
		await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
			signal: this.requestSetup.requestSignal,
		});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryRecoverPreviousResponseNotFound(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		if (
			!isCodexStalePreviousResponseError(error) ||
			!websocketState ||
			this.output.content.length > 0 ||
			this.options?.signal?.aborted ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES
		) {
			return false;
		}
		if (this.runtime.transport !== "websocket") {
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		resetCodexWebSocketAppendState(websocketState);
		websocketState.modelsEtag = undefined;
		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;

		CODEX_DEBUG &&
			logger.debug("[codex] codex previous_response_id expired; retrying with full context", {
				retry: this.runtime.providerRetryAttempt,
			});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryReplayWebsocketFailureOverSse(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		const canReplay =
			this.runtime.transport === "websocket" &&
			websocketState &&
			isCodexWebSocketRetryableStreamError(error) &&
			this.runtime.canSafelyReplayWebsocketOverSse &&
			!this.runtime.sawTerminalEvent &&
			!this.options?.signal?.aborted;
		if (!canReplay) return false;

		const state = websocketState;
		const streamError = error instanceof Error ? error : new Error(String(error));
		const replayingBufferedOutputOverSse = this.output.content.length > 0;
		const fatalWebSocketMessage = streamError.message.toLowerCase();
		const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
			fatalWebSocketMessage.includes(pattern.toLowerCase()),
		);
		const activateFallback =
			replayingBufferedOutputOverSse ||
			isFatal ||
			this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET;
		recordCodexWebSocketFailure(state, activateFallback);
		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket stream fallback", {
				error: streamError.message,
				retry: this.runtime.websocketStreamRetries,
				retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
				activated: activateFallback,
				fatal: isFatal,
				replayedBufferedOutput: replayingBufferedOutputOverSse,
			});

		if (!activateFallback) {
			this.runtime.websocketStreamRetries += 1;

			this.runtime.resetAccumulators();
			this.firstTokenTime = undefined;
			await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
				signal: this.requestSetup.requestSignal,
			});
			await this.#reopenWebSocketStream(state);
			return true;
		}

		this.runtime.resetAccumulators();
		resetOutputState(this.output);
		this.firstTokenTime = undefined;

		await this.#reopenSseStream(state);
		return true;
	}

	async #tryRetryProviderError(error: unknown): Promise<boolean> {
		if (
			!(error instanceof CodexProviderStreamError && error.retryable) ||
			this.output.content.length > 0 ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex provider stream error", {
				error: error instanceof Error ? error.message : String(error),
				retry: this.runtime.providerRetryAttempt,
				retryBudget: CODEX_MAX_RETRIES,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_RETRY_DELAY_MS * this.runtime.providerRetryAttempt, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	async #reopenWebSocketStream(state: CodexWebSocketSessionState): Promise<void> {
		try {
			const next = await openCodexWebSocketTransport(
				this.model,
				this.options,
				this.requestContext,
				this.requestSetup,
				state,
				this.runtime.websocketStreamRetries,
				this.options ? event => this.options?.onSseEvent?.(event, this.model) : undefined,
			);
			this.runtime.eventStream = next.eventStream;
			this.runtime.requestBodyForState = next.requestBodyForState;
			this.runtime.transport = next.transport;
			state.lastTransport = next.transport;
		} catch (error) {
			if (!(error instanceof CodexWebSocketTransportError)) throw error;

			recordCodexWebSocketFailure(state, true);
			CODEX_DEBUG &&
				logger.debug("[codex] codex websocket reopen failed, falling back to SSE", {
					error: error.message,
					retry: this.runtime.websocketStreamRetries,
				});
			await this.#reopenSseStream(state);
		}
	}

	async #reopenSseStream(state: CodexWebSocketSessionState | undefined): Promise<void> {
		const next = await openCodexSseTransport(this.model, this.requestContext, this.requestSetup, this.options, state);
		this.runtime.eventStream = next.eventStream;
		this.runtime.requestBodyForState = next.requestBodyForState;
		this.runtime.transport = next.transport;
		if (state) {
			state.lastTransport = next.transport;
		}
	}

	finalize(completion: CodexStreamCompletion): AssistantMessage {
		const { output } = this;
		if (this.options?.signal?.aborted) {
			throw new AIError.AbortError();
		}
		if (!this.runtime.sawTerminalEvent) {
			if (this.requestContext.websocketState) {
				resetCodexWebSocketAppendState(this.requestContext.websocketState);
				this.requestContext.websocketState.modelsEtag = undefined;
			}
			CODEX_DEBUG &&
				logger.debug("[codex] codex stream ended unexpectedly", {
					transport: this.runtime.transport,
					terminalEventSeen: this.runtime.sawTerminalEvent,
					unexpectedStreamEnd: true,
					sentTurnStateHeader: Boolean(this.requestContext.turnState.value),
					sentModelsEtagHeader: Boolean(this.requestContext.websocketState?.modelsEtag),
				});
			throw new CodexProviderStreamError("Codex stream ended before terminal completion event", false);
		}
		if (output.stopReason === "aborted" || output.stopReason === "error") {
			throw new CodexProviderStreamError("Codex response failed", false);
		}

		output.providerPayload = createOpenAIResponsesHistoryPayload(this.model.provider, this.runtime.nativeOutputItems);
		output.duration = performance.now() - this.startTime;
		if (completion.firstTokenTime) {
			output.ttft = completion.firstTokenTime - this.startTime;
		}
		return output;
	}
}

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const requestSetup = createRequestSetup(options);
		let processingContext: CodexStreamProcessor | undefined;
		let requestContext: CodexRequestContext | undefined;

		try {
			requestContext = await buildCodexRequestContext(model, context, options);
			const initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
			const runtime = new CodexStreamRuntime({
				...initialTransport,
				websocketState: requestContext.websocketState,
			});
			if (requestContext.websocketState) {
				requestContext.websocketState.lastTransport = initialTransport.transport;
			}

			processingContext = new CodexStreamProcessor({
				runtime,
				model,
				output,
				stream,
				options,
				requestSetup,
				requestContext,
				startTime,
			});

			const completion = await processingContext.process();
			processingContext.firstTokenTime = completion.firstTokenTime;
			const message = processingContext.finalize(completion);
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end();
		} catch (error) {
			const failureContext =
				processingContext ??
				({
					model,
					output,
					options,
					requestContext: requestContext ?? {
						apiKey: "",
						accountId: "",
						baseUrl: model.baseUrl || CODEX_BASE_URL,
						url: "",
						requestHeaders: {},
						codexClientVersion: CODEX_CLIENT_VERSION,
						turnState: {},
						responsesLite: options?.responsesLite === true,
						transformedBody: { model: model.id },
						rawRequestDump: {
							provider: model.provider,
							api: output.api,
							model: model.id,
							method: "POST",
							url: "",
							body: { model: model.id },
						},
					},
					startTime,
				} satisfies CodexStreamFailureContext);
			try {
				const failure = await handleCodexStreamFailure(failureContext, error);
				stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
			} catch (failureError) {
				logger.error("Codex stream failure handler threw", {
					error: failureError instanceof Error ? failureError.message : String(failureError),
				});
				output.stopReason = "error";
				output.errorMessage ??= error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
			}
			stream.end();
		} finally {
			requestContext?.isolatedTransportState?.close();
		}
	})();

	return stream;
};

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		"apiKey" | "headers" | "sessionId" | "signal" | "preferWebsockets" | "providerSessionState" | "responsesLite"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getCodexAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const promptCacheKey = transportSessionId;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = resolveCodexResponsesLite(model, options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const metadataSession = getOrCreateCodexMetadataSessionState(
		transportSessionId ?? crypto.randomUUID(),
		providerSessionState,
	);
	const turnState = getOrCreateCodexTurnState(metadataSession, sessionKey);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const requestIdentity = createCodexCompatibilityIdentity(metadataSession);
	const attestation = await getCodexAttestationHeader(accountId);
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
		accountId,
		apiKey,
		codexClientVersion,
		promptCacheKey,
		"websocket",
		state,
		turnState,
		responsesLite,
		requestIdentity,
		attestation,
	);
	await logger.time(
		"prewarmCodex:establishWs",
		getOrCreateCodexWebSocketConnection,
		state,
		turnState,
		toWebSocketUrl(url),
		headers,
		model.provider,
		options?.signal,
	);
	state.prewarmed = true;
}

function getCodexWebSocketSessionKey(
	normalizedSessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	apiKey: string,
	baseUrl: string,
	responsesLite: boolean,
): string | undefined {
	if (!normalizedSessionId) return undefined;
	const credentialKey = accountId ? `account:${accountId}` : `token:${Bun.hash(apiKey).toString(36)}`;

	const liteSuffix = responsesLite ? ":lite" : "";
	return `${credentialKey}:${baseUrl}:${model.id}:${normalizedSessionId}${liteSuffix}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: {
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
		},
	};
	providerSessionState.webSocketSessions.set(sessionKey, created);
	return created;
}

function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

function recordCodexWebSocketFailure(state: CodexWebSocketSessionState, activateFallback: boolean): void {
	resetCodexWebSocketAppendState(state);

	if (state.connection && !state.connection.isConnecting()) {
		state.connection.close("fallback");
		state.connection = undefined;
	}
	state.lastFallbackAt = Date.now();
	if (activateFallback && !state.disableWebsocket) {
		state.disableWebsocket = true;
		state.fallbackCount += 1;
	}
}

function getCodexWebSocketEnvValue(): boolean | undefined {
	const envVal = $env.PI_CODEX_WEBSOCKET;
	if (envVal !== undefined) {
		return $flag("PI_CODEX_WEBSOCKET");
	}
	return undefined;
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	if (model.preferWebsockets === false) return false;

	if (!state || state.disableWebsocket) return false;

	const envVal = getCodexWebSocketEnvValue();
	if (envVal !== undefined) return envVal;

	if (preferWebsockets === false) return false;
	return true;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const normalizedSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const publicSessionKey = normalizedSessionId ? `${baseUrl}:${model.id}:${normalizedSessionId}` : undefined;
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const envVal = getCodexWebSocketEnvValue();
	const websocketPreferred =
		envVal !== undefined
			? envVal
			: options?.preferWebsockets === false
				? false
				: options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = getCodexWebSocketStateForPublicSession(model, options);
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	let hasTurnState = false;
	if (sessionId) {
		const metadataSession = providerSessionState?.metadataSessions.get(sessionId);
		if (metadataSession) {
			for (const cell of metadataSession.turnStates.values()) {
				if (cell.value === undefined) continue;
				hasTurnState = true;
				break;
			}
		}
	}

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		hasTurnState,
		lastFallbackAt: state?.lastFallbackAt,
	};
}

const codexDiagnosticsTextEncoder = new TextEncoder();

function jsonByteLength(value: unknown): number {
	const json = JSON.stringify(value);
	return codexDiagnosticsTextEncoder.encode(json === undefined ? "undefined" : json).byteLength;
}

function hashJson(value: unknown): string {
	const json = JSON.stringify(value);
	return String(Bun.hash(json === undefined ? "undefined" : json));
}

function parseCodexServiceTier(value: unknown): ServiceTier | undefined {
	switch (value) {
		case "auto":
		case "default":
		case "flex":
		case "scale":
		case "priority":
			return value;
		default:
			return undefined;
	}
}

function parseCodexResponseStatus(value: unknown): ResponseStatus | undefined {
	switch (value) {
		case "completed":
		case "failed":
		case "in_progress":
		case "cancelled":
		case "queued":
		case "incomplete":
			return value;
		default:
			return undefined;
	}
}

function parseCodexResponseUsage(value: unknown): CodexResponseUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage: CodexResponseUsage = {};
	let hasUsage = false;
	if ("input_tokens" in value && typeof value.input_tokens === "number") {
		usage.input_tokens = value.input_tokens;
		hasUsage = true;
	}
	if ("output_tokens" in value && typeof value.output_tokens === "number") {
		usage.output_tokens = value.output_tokens;
		hasUsage = true;
	}
	if ("total_tokens" in value && typeof value.total_tokens === "number") {
		usage.total_tokens = value.total_tokens;
		hasUsage = true;
	}
	if ("prompt_cache_hit_tokens" in value && typeof value.prompt_cache_hit_tokens === "number") {
		usage.prompt_cache_hit_tokens = value.prompt_cache_hit_tokens;
		hasUsage = true;
	}
	if (
		"input_tokens_details" in value &&
		value.input_tokens_details &&
		typeof value.input_tokens_details === "object"
	) {
		const details = value.input_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["input_tokens_details"]> = {};
		let hasDetails = false;
		if ("cached_tokens" in details && typeof details.cached_tokens === "number") {
			parsedDetails.cached_tokens = details.cached_tokens;
			hasDetails = true;
		}
		if ("cache_write_tokens" in details && typeof details.cache_write_tokens === "number") {
			parsedDetails.cache_write_tokens = details.cache_write_tokens;
			hasDetails = true;
		}
		if ("orchestration_input_tokens" in details && typeof details.orchestration_input_tokens === "number") {
			parsedDetails.orchestration_input_tokens = details.orchestration_input_tokens;
			hasDetails = true;
		}
		if (
			"orchestration_input_cached_tokens" in details &&
			typeof details.orchestration_input_cached_tokens === "number"
		) {
			parsedDetails.orchestration_input_cached_tokens = details.orchestration_input_cached_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.input_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	if (
		"output_tokens_details" in value &&
		value.output_tokens_details &&
		typeof value.output_tokens_details === "object"
	) {
		const details = value.output_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["output_tokens_details"]> = {};
		let hasDetails = false;
		if ("reasoning_tokens" in details && typeof details.reasoning_tokens === "number") {
			parsedDetails.reasoning_tokens = details.reasoning_tokens;
			hasDetails = true;
		}
		if ("orchestration_output_tokens" in details && typeof details.orchestration_output_tokens === "number") {
			parsedDetails.orchestration_output_tokens = details.orchestration_output_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.output_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	return hasUsage ? usage : undefined;
}

function describeCodexInputItemType(item: unknown): string {
	if (item && typeof item === "object") {
		if ("type" in item && typeof item.type === "string") return item.type;
		if ("role" in item && typeof item.role === "string") return item.role;
	}
	return typeof item;
}

function createCodexOptionsHash(request: Record<string, unknown>): string {
	const options: Record<string, unknown> = {};
	for (const key in request) {
		if (key === "input" || key === "previous_response_id" || key === "type" || key === "client_metadata") {
			continue;
		}
		options[key] = request[key];
	}
	return hashJson(options);
}

function buildCodexTurnRequestDiagnostics(
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): OpenAICodexTurnRequestDiagnostics {
	const input = request.input;
	const inputItems = Array.isArray(input) ? input : [];
	const inputItemTypes = inputItems.map(describeCodexInputItemType);
	const promptCacheKey = typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined;
	const toolsHash = request.tools === undefined ? undefined : hashJson(request.tools);
	return {
		transport,
		previousResponseIdPresent:
			typeof request.previous_response_id === "string" && request.previous_response_id.length > 0,
		inputItemCount: inputItems.length,
		inputItemTypes,
		...(inputItemTypes[0] ? { firstInputItemType: inputItemTypes[0] } : {}),
		inputJsonBytes: jsonByteLength(inputItems),
		...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
		...(toolsHash !== undefined ? { toolsHash } : {}),
		optionsHash: createCodexOptionsHash(request),
		canAppendBeforeRequest,
	};
}

function recordCodexTurnRequestDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	const previousResponseId =
		typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
	if (previousResponseId && previousResponseId.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = previousResponseId;
	} else {
		state.stats.fullContextRequests += 1;
		state.stats.lastDeltaInputItems = undefined;
		state.stats.lastPreviousResponseId = undefined;
	}
	state.stats.lastTurn = {
		request: buildCodexTurnRequestDiagnostics(request, transport, canAppendBeforeRequest),
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn request diagnostics", { diagnostics: state.stats.lastTurn.request });
}

function recordCodexTurnUsageDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	rawUsage: CodexResponseUsage | undefined,
	displayedUsage: Usage,
): void {
	if (!state?.stats.lastTurn || !rawUsage) return;
	const details = rawUsage.input_tokens_details;
	const outputDetails = rawUsage.output_tokens_details;
	const rawInputTokens = rawUsage.input_tokens ?? 0;
	const rawCachedTokens = details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const usageDiagnostics: OpenAICodexTurnUsageDiagnostics = {
		rawInputTokens,
		rawCachedTokens,
		rawUncachedTokens: Math.max(0, rawInputTokens - rawCachedTokens),
		rawOutputTokens: rawUsage.output_tokens ?? 0,
		...(typeof rawUsage.total_tokens === "number" ? { rawTotalTokens: rawUsage.total_tokens } : {}),
		...(typeof details?.orchestration_input_tokens === "number"
			? { rawOrchestrationInputTokens: details.orchestration_input_tokens }
			: {}),
		...(typeof details?.orchestration_input_cached_tokens === "number"
			? { rawOrchestrationCachedTokens: details.orchestration_input_cached_tokens }
			: {}),
		...(typeof outputDetails?.orchestration_output_tokens === "number"
			? { rawOrchestrationOutputTokens: outputDetails.orchestration_output_tokens }
			: {}),
		displayedInputTokens: displayedUsage.input,
		displayedOutputTokens: displayedUsage.output,
		displayedCacheReadTokens: displayedUsage.cacheRead,
		displayedCacheWriteTokens: displayedUsage.cacheWrite,
		displayedTotalTokens: displayedUsage.totalTokens,
		displayedOrchestrationInputTokens: displayedUsage.orchestration?.input ?? 0,
		displayedOrchestrationCacheReadTokens: displayedUsage.orchestration?.cacheRead ?? 0,
		displayedOrchestrationOutputTokens: displayedUsage.orchestration?.output ?? 0,
	};
	state.stats.lastTurn = {
		...state.stats.lastTurn,
		usage: usageDiagnostics,
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn diagnostics", { diagnostics: state.stats.lastTurn });
}

function buildCodexChainedRequestBody(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): RequestBody {
	const chainable = state?.canAppend === true;
	const appendInput = chainable
		? buildResponsesDeltaInput(state.lastRequest, state.lastResponseItems, requestBody)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		return { ...requestBody, previous_response_id: state.lastResponseId, input: appendInput };
	}
	if (chainable && state) {
		CODEX_DEBUG &&
			logger.debug("[codex] codex append reset", {
				hadModelsEtagHeader: Boolean(state.modelsEtag),
			});
		resetCodexWebSocketAppendState(state);
		state.modelsEtag = undefined;
	}
	return requestBody;
}

function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketRequestTimeouts {
	idleTimeoutMs?: number;
	firstEventTimeoutMs?: number;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
	proxy?: string;
}

class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#proxy?: string;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;

	#lastInboundAt = 0;

	#lastPingAt = 0;

	#lastSeenResponseId?: string;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#proxy = options.proxy;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS;
		if (maxIdleMs <= 0) return true;

		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
		this.#stopHeartbeat();
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers, proxy: this.#proxy },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const clearPending = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`request was aborted`));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		if (!settled) {
			timeout = setTimeout(() => {
				socket.close(1000, "connect-timeout");
				if (!settled) {
					settled = true;
					clearPending();
					reject(new CodexWebSocketTransportError(`connection timeout`));
				}
			}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
		}

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#lastInboundAt = Date.now();
				this.#captureHandshakeHeaders(socket, event);
				this.#startHeartbeat(socket);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = new CodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(new CodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			this.#lastInboundAt = Date.now();
			this.#writeDebugWebSocketFrame(event.data);
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
					const inner = parsed.error as Record<string, unknown>;
					if (typeof parsed.code !== "string" && typeof inner.code === "string") {
						parsed.code = inner.code;
					}
					if (typeof parsed.message !== "string" && typeof inner.message === "string") {
						parsed.message = inner.message;
					}
				}
				notifyCodexWebSocketInbound(this.#streamObserver, parsed, text);
				this.#push(parsed);
			} catch (error) {
				notifyCodexWebSocketMalformed(this.#streamObserver, event.data, error);
				this.#push(new CodexWebSocketTransportError(`${String(error)}`));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
		}
		if (this.#activeRequest) {
			throw new CodexWebSocketTransportError(`websocket request already in progress`);
		}
		if (signal?.aborted) {
			throw new CodexWebSocketTransportError(`request was aborted`);
		}
		this.#activeRequest = true;
		this.#streamObserver = onSseEvent;

		this.#dropStaleFrames();
		const onAbort = () => {
			this.close("aborted");
			this.#push(new CodexWebSocketTransportError(`request was aborted`));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		try {
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "websocket",
						method: "POST",
						url: this.#url,
						headers: this.#headers,
						body: request,
					})
				: undefined;
			this.#debugResponseLog = debugSession
				? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
				: undefined;

			const requestPayload = JSON.stringify(request);
			notifyCodexWebSocketOutbound(onSseEvent, request, requestPayload);

			const socket = this.#socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
			}
			try {
				socket.send(requestPayload);
			} catch (error) {
				throw new CodexWebSocketTransportError(
					`websocket send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			let sawFirstEvent = false;
			const { idleTimeoutMs, firstEventTimeoutMs } = timeouts;
			let lastProgressAt = Date.now();
			let lastProgressEventType: string | undefined;
			let lastEventAt = lastProgressAt;
			let lastEventType: string | undefined;

			let activeResponseId: string | undefined;
			let lastSequence: number | undefined;
			const priorResponseId = this.#lastSeenResponseId;
			while (true) {
				let timeoutMs: number | undefined;
				let timeoutReason: string;
				if (sawFirstEvent) {
					timeoutReason = createCodexWebSocketTimeoutMessage("idle timeout waiting for websocket", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
						timeoutMs = idleTimeoutMs - (Date.now() - lastProgressAt);
						if (timeoutMs <= 0) {
							CODEX_DEBUG &&
								logger.debug("[codex] codex websocket idle timeout", {
									lastEventType,
									lastProgressEventType,
									msSinceLastEvent: Date.now() - lastEventAt,
									msSinceLastProgress: Date.now() - lastProgressAt,
								});
							throw new CodexWebSocketTransportError(`${timeoutReason}`);
						}
					}
				} else {
					timeoutReason = createCodexWebSocketTimeoutMessage("timeout waiting for first websocket event", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0) {
						timeoutMs = firstEventTimeoutMs;
					}
				}
				const next = await this.#nextMessage(timeoutMs, timeoutReason);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw new CodexWebSocketTransportError(`websocket closed before response completion`);
				}
				const eventType = typeof next.type === "string" ? next.type : "";

				const frameResponseId = extractCodexFrameResponseId(next);
				const frameSequence = extractCodexFrameSequenceNumber(next);
				if (frameResponseId !== undefined) {
					if (activeResponseId === undefined) {
						if (priorResponseId !== undefined && frameResponseId === priorResponseId) {
							continue;
						}
						activeResponseId = frameResponseId;
					} else if (frameResponseId !== activeResponseId) {
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket frame for response ${frameResponseId} interleaved into active response ${activeResponseId}`,
						);
					}
					this.#lastSeenResponseId = frameResponseId;
				}
				if (frameSequence !== undefined) {
					if (activeResponseId !== undefined && lastSequence !== undefined && frameSequence < lastSequence) {
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket sequence_number ${frameSequence} regressed below ${lastSequence} within response ${activeResponseId}`,
						);
					}
					lastSequence = frameSequence;
				}
				sawFirstEvent = true;
				lastEventAt = Date.now();
				lastEventType = eventType || undefined;
				if (isCodexStreamProgressEvent(next)) {
					lastProgressAt = lastEventAt;
					lastProgressEventType = lastEventType;
				}
				yield next;
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error"
				) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#handshakeHeaders = headers;
		this.#onHandshakeHeaders?.(headers);
	}

	#writeDebugWebSocketFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string") {
			log.write(data);
			return;
		}
		if (data instanceof Uint8Array) {
			log.write(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			log.write(new Uint8Array(data));
			return;
		}
		log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const intervalMs = CODEX_WEBSOCKET_PING_INTERVAL_MS;
		if (intervalMs <= 0) return;

		this.#lastPingAt = 0;
		const socketEventTarget = socket as EventTarget;
		const onPong = () => {
			this.#lastInboundAt = Date.now();
		};
		if (
			typeof socketEventTarget.addEventListener === "function" &&
			typeof socketEventTarget.removeEventListener === "function"
		) {
			socketEventTarget.addEventListener("pong", onPong);
			this.#removePongListener = () => socketEventTarget.removeEventListener("pong", onPong);
		}

		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}

			const pongTimeoutMs = CODEX_WEBSOCKET_PONG_TIMEOUT_MS;
			if (
				pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > pongTimeoutMs
			) {
				this.#failQueue(new CodexWebSocketTransportError(`websocket pong timeout`), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					new CodexWebSocketTransportError(
						`websocket ping failed: ${error instanceof Error ? error.message : String(error)}`,
					),
					"ping-failed",
				);
			}
		}, intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatInterval) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = undefined;
		}
		if (this.#removePongListener) {
			this.#removePongListener();
			this.#removePongListener = undefined;
		}
		this.#lastPingAt = 0;
	}

	#failQueue(error: Error, closeReason: string): void {
		CODEX_DEBUG && logger.debug("[codex] codex websocket transport failure", { error: error.message, closeReason });
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(closeReason);
		this.#wakeWaiters();
	}

	#dropStaleFrames(): number {
		if (this.#queue.length === 0) return 0;
		const surviving = this.#queue.filter(item => item instanceof Error);
		const dropped = this.#queue.length - surviving.length;
		if (dropped === 0) return 0;
		this.#queue.length = 0;
		for (const item of surviving) this.#queue.push(item);
		CODEX_DEBUG && logger.debug("[codex] codex websocket dropped stale frames before request", { dropped });
		return dropped;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error | null): void {
		if (item instanceof Error) {
			this.#queue.push(item);
			this.#wakeWaiters();
			return;
		}
		if (item !== null && this.#queue.length >= CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY) {
			this.#failQueue(
				new CodexWebSocketTransportError(
					`websocket message queue exceeded ${CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		timeoutReason: string,
	): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return new CodexWebSocketTransportError(`${timeoutReason}`);
			}
		}
		return this.#queue.shift() ?? null;
	}
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	turnState: CodexTurnStateCell,
	url: string,
	headers: Headers,
	provider: string,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const proxy = getProxyForUrl(provider, new URL(url));
	const headerRecord = headersToRecord(headers);

	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			CODEX_DEBUG && logger.debug("[codex] codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(turnState, state, handshakeHeaders);
		},
		proxy,
	});
	await state.connection.connect(signal);
	return state.connection;
}

function compressCodexRequestBody(bodyJson: string, baseUrl: string): Uint8Array | undefined {
	if (!isOfficialCodexApiUrl(baseUrl) || !$flag("PI_CODEX_ZSTD", true)) return undefined;
	try {
		return Bun.zstdCompressSync(bodyJson, { level: 3 });
	} catch (error) {
		CODEX_DEBUG &&
			logger.debug("[codex] codex request body compression failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		return undefined;
	}
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	turnState: CodexTurnStateCell,
	responsesLite: boolean,
	codexClientVersion: string,
	requestMetadata: CodexRequestMetadata | undefined,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	codexSseMaxAttempts: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const headers = createCodexHeaders(
		requestHeaders,
		accountId,
		apiKey,
		codexClientVersion,
		sessionId,
		"sse",
		state,
		turnState,
		responsesLite,
		requestMetadata,
		await getCodexAttestationHeader(accountId),
	);

	let clearPreResponseTimeout: (() => void) | undefined;
	const fetchAttempt: FetchImpl = async (input, init) => {
		try {
			return await (fetchOverride ?? fetch)(input, init);
		} finally {
			clearPreResponseTimeout?.();
			clearPreResponseTimeout = undefined;
		}
	};
	const bodyJson = JSON.stringify(body);
	const compressedBody = compressCodexRequestBody(bodyJson, url);
	if (compressedBody !== undefined) {
		headers.set("content-encoding", "zstd");
	}
	CODEX_DEBUG &&
		logger.debug("[codex] codex request", {
			url,
			model: body.model,
			headers: redactHeaders(headers),
			sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
		});

	const send = (requestBody: string | Uint8Array): Promise<Response> =>
		fetchWithRetry(url, {
			method: "POST",
			headers,
			body: requestBody,
			signal,
			prepareInit: () => {
				const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
				clearPreResponseTimeout = watchdog.clear;
				return { signal: watchdog.signal };
			},
			maxAttempts: resolveCodexSseMaxAttempts(codexSseMaxAttempts),
			defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
			maxDelayMs: CODEX_RATE_LIMIT_BUDGET_MS,
			fetch: fetchAttempt,
			timeout: false,
		});
	let response: Response;
	try {
		response = await send(compressedBody ?? bodyJson);
		if (compressedBody !== undefined && (response.status === 400 || response.status === 415)) {
			const rejectedStatus = response.status;
			await response.body?.cancel();
			headers.delete("content-encoding");
			CODEX_DEBUG &&
				logger.debug("[codex] retrying request without zstd after encoding rejection", {
					url,
					status: rejectedStatus,
				});
			response = await send(bodyJson);
		}
	} finally {
		clearPreResponseTimeout?.();
	}
	CODEX_DEBUG &&
		logger.debug("[codex] codex response", {
			url: response.url,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") || null,
			cfRay: response.headers.get("cf-ray") || null,
		});
	if (!response.ok) {
		throw await CodexApiError.fromResponse(response);
	}
	updateCodexSessionMetadataFromHeaders(turnState, state, response.headers);
	if (!response.body) {
		throw new CodexProviderStreamError("No response body", false);
	}
	return readSseJson<Record<string, unknown>>(response.body, signal, event =>
		onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, undefined),
	);
}

function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	accessToken: string,
	codexClientVersion: string,
	sessionId?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
	turnState?: CodexTurnStateCell,
	responsesLite = false,
	requestMetadata?: CodexCompatibilityIdentity,
	attestation?: string,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);

	applyCodexResidencyHeader(headers, accessToken);
	if (attestation) {
		headers.set(OPENAI_HEADERS.ATTESTATION, attestation);
	} else {
		headers.delete(OPENAI_HEADERS.ATTESTATION);
	}
	const betaHeader =
		transport === "websocket"
			? OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2
			: OPENAI_HEADER_VALUES.BETA_RESPONSES;
	headers.delete(OPENAI_HEADERS.BETA);
	headers.delete("openai-beta");
	headers.set(OPENAI_HEADERS.BETA, betaHeader);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, codexClientVersion);
	headers.set("User-Agent", USER_AGENT);
	if (sessionId) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
		headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		headers.set("x-client-request-id", sessionId);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
		headers.delete("x-client-request-id");
	}
	headers.delete(OPENAI_HEADERS.INSTALLATION_ID);
	if (requestMetadata) {
		applyCodexCompatibilityHeaders(headers, requestMetadata);
	} else {
		headers.delete(OPENAI_HEADERS.SCOPED_SESSION_ID);
		headers.delete(OPENAI_HEADERS.THREAD_ID);
		headers.delete(OPENAI_HEADERS.WINDOW_ID);
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
	if (turnState?.value) {
		headers.set(X_CODEX_TURN_STATE_HEADER, turnState.value);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (responsesLite) {
		headers.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
	} else {
		headers.delete(OPENAI_HEADERS.RESPONSES_LITE);
	}
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	return headers;
}

function redactHeaders(headers: Headers): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === "authorization") {
			redacted[key] = "Bearer [redacted]";
			continue;
		}
		if (
			lower.includes("account") ||
			lower.includes("session") ||
			lower.includes("conversation") ||
			lower.includes("thread") ||
			lower.includes("window") ||
			lower.includes("installation") ||
			lower.startsWith("x-codex-turn") ||
			lower === "x-client-request-id" ||
			lower === "cookie"
		) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

export function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const escapeControlTokens = isHarmonyDialectModel(model);
	let msgIndex = 0;

	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();
	const computerCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				const redactedHistoryItems = redactSensitiveInObject(historyItems).result as Array<ResponseInput[number]>;
				const replayItems =
					model.supportsComputerUse === true
						? redactedHistoryItems
						: unrollCodexComputerItems(redactedHistoryItems, model.compat.supportsImageDetailOriginal);
				for (const item of replayItems) {
					if (item.type === "custom_tool_call") {
						customCallIds.add(item.call_id);
					}
					if (item.type === "computer_call") computerCallIds.add(item.call_id);
					if ((item.type === "function_call" || item.type === "custom_tool_call") && item.call_id) {
						knownCallIds.add(item.call_id);
					}
				}
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(replayItems) : replayItems));
				msgIndex += 1;
				continue;
			}

			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			const providerPayload =
				assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items as Array<Record<string, unknown>> | undefined;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(historyItems);
				if (sanitizedHistoryItems) {
					const rawReplayItems =
						model.supportsComputerUse === true
							? sanitizedHistoryItems
							: unrollCodexComputerItems(sanitizedHistoryItems, model.compat.supportsImageDetailOriginal);
					const replayItems = escapeControlTokens ? escapeReplayedControlTokens(rawReplayItems) : rawReplayItems;
					for (const item of replayItems) {
						if (item.type === "custom_tool_call") {
							customCallIds.add(item.call_id);
						}
						if (item.type === "computer_call") computerCallIds.add(item.call_id);
						if ((item.type === "function_call" || item.type === "custom_tool_call") && item.call_id) {
							knownCallIds.add(item.call_id);
						}
					}
					if (providerPayload?.dt) {
						messages.push(...replayItems);
					} else {
						messages.splice(0, messages.length, ...replayItems);
					}
					msgIndex += 1;
					continue;
				}
				suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				model.supportsComputerUse === true ? assistantMsg : unrollCodexComputerAssistantMessage(assistantMsg),
				model,
				msgIndex,
				knownCallIds,
				!suppressHiddenEmptyFallback,
				customCallIds,
				false,
				true,
				undefined,
				computerCallIds,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length > 0) {
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(outputItems) : outputItems));
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				model.supportsComputerUse === true ? msg : unrollCodexComputerToolResult(msg),
				model,
				false,
				model.compat.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
				true,
				computerCallIds,
			);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | (AudioContent | ImageContent | TextContent | VideoContent)[],
): ResponseInputContent[] {
	const escapeControlTokens = isHarmonyDialectModel(model);
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		const text = content.toWellFormed();
		return [{ type: "input_text", text: escapeControlTokens ? escapeHarmonyControlTokens(text) : text }];
	}

	return (
		convertResponsesInputContent(
			content,
			model.input.includes("image"),
			model.compat.supportsImageDetailOriginal,
			escapeControlTokens,
		) ?? []
	);
}

export { convertMessages as convertCodexResponsesMessages };

type CodexToolPayload =
	| { type: "computer"; name?: never }
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = model.applyPatchToolType === "freeform";
	const payloads: CodexToolPayload[] = [];
	for (const tool of tools) {
		if (tool.native?.type === "computer" && model.supportsComputerUse === true) {
			payloads.push({ type: "computer" });
			continue;
		}
		if (allowFreeform && tool.customFormat) {
			payloads.push({
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			});
			continue;
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		payloads.push({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict ? { strict: true } : !NO_STRICT && tool.strict === false ? { strict: false } : {}),
		});
	}
	return payloads;
}

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string) {
		super(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${detail}`);
		this.name = "CodexWebSocketTransportError";
	}
}
class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code?: string;

	constructor(message: string, retryable: boolean, code?: string) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
	}
}

const optionalCodexString = type("unknown").pipe(raw => {
	const out = type("string")(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerErrorDetailSchema = type({
	"code?": optionalCodexString,
	"type?": optionalCodexString,
	"message?": optionalCodexString,
});

const codexErrorDetailSchema = type("unknown").pipe(raw => {
	const out = innerErrorDetailSchema(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerFailureEventSchema = type({
	"type?": optionalCodexString,
	"code?": optionalCodexString,
	"message?": optionalCodexString,
	"status?": optionalCodexString,
	"error?": codexErrorDetailSchema,
	"response?": type("unknown").pipe(raw => {
		const out = type({
			"error?": codexErrorDetailSchema,
			"message?": optionalCodexString,
			"status?": optionalCodexString,
		})(raw);
		return out instanceof type.errors ? undefined : out;
	}),
});

const codexFailureEventSchema = type("unknown").pipe(raw => {
	const out = innerFailureEventSchema(raw);
	return out instanceof type.errors
		? {
				type: undefined,
				code: undefined,
				message: undefined,
				status: undefined,
				error: undefined,
				response: undefined,
			}
		: out;
});

export function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return false;
	}
	const error = event.error ?? event.response?.error;
	const code = error?.code ?? error?.type ?? event.code;
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = error?.message ?? event.message ?? event.response?.message;
	return !!message && CODEX_RETRYABLE_EVENT_MESSAGE.test(message);
}

export function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return new CodexProviderStreamError("Codex response failed", false);
	}
	const nestedError = event.error ?? event.response?.error;
	const code = nestedError?.code ?? nestedError?.type ?? event.code ?? "";
	const message = event.message ?? "";
	const formattedMessage =
		event.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, isRetryableCodexFailureEvent(rawEvent), code || undefined);
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return null;
	}
	const error = event.error ?? event.response?.error;
	const message = error?.message ?? event.message ?? event.response?.message;
	const code = error?.code ?? error?.type ?? event.code;
	const status = event.response?.status ?? event.status;

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex response failed: ${truncatedRawEventJson}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex error event: ${truncatedRawEventJson}`;
	} catch {
		return "Codex error event";
	}
}
