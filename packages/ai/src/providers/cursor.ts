import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
import type {
	ConversationStep,
	CursorRule,
	McpToolDefinition,
	RequestedModel_ModelParameterbytes,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AgentStoreConflictErrorSchema,
	AgentStoreConflictResultSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	CanvasDiagnosticsErrorSchema,
	CanvasDiagnosticsResultSchema,
	ClientHeartbeatSchema,
	ComputerUseErrorSchema,
	ComputerUseResultSchema,
	ConversationActionSchema,
	ConversationSearchErrorSchema,
	ConversationSearchResultSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	CursorRuleSchema,
	CursorRuleSource,
	CursorRuleTypeGlobalSchema,
	CursorRuleTypeSchema,
	DeleteErrorSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	DiagnosticsErrorSchema,
	DiagnosticsRejectedSchema,
	DiagnosticsResultSchema,
	DiagnosticsSuccessSchema,
	ExecClientControlMessageSchema,
	type ExecClientMessage,
	ExecClientMessageSchema,
	ExecClientStreamCloseSchema,
	ExecClientThrowSchema,
	type ExecServerMessage,
	FetchErrorSchema,
	FetchResultSchema,
	ForceBackgroundShellResultSchema,
	ForceBackgroundShellStatus,
	ForceBackgroundSubagentResultSchema,
	ForceBackgroundSubagentStatus,
	GetBlobResultSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
	KvClientMessageSchema,
	type KvServerMessage,
	ListMcpResourcesErrorSchema,
	type ListMcpResourcesExecResult,
	ListMcpResourcesExecResult_McpResourceSchema,
	ListMcpResourcesExecResultSchema,
	ListMcpResourcesSuccessSchema,
	type LsDirectoryTreeNode,
	type LsDirectoryTreeNode_File,
	LsDirectoryTreeNode_FileSchema,
	LsDirectoryTreeNodeSchema,
	LsErrorSchema,
	LsRejectedSchema,
	LsResultSchema,
	LsSuccessSchema,
	McpAllowlistPrecheckResultSchema,
	McpApprovedSchema,
	McpArgsSchema,
	McpErrorSchema,
	McpImageContentSchema,
	McpRejectedSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	McpToolErrorSchema,
	McpToolNotFoundSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	ReadErrorSchema,
	ReadMcpResourceErrorSchema,
	type ReadMcpResourceExecResult,
	ReadMcpResourceExecResultSchema,
	ReadMcpResourceNotFoundSchema,
	ReadMcpResourceSuccessSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	RecordScreenFailureSchema,
	RecordScreenResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	RequestedModel_ModelParameterbytesSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	ShellAllowlistPrecheckResultSchema,
	type ShellArgs,
	ShellFailureSchema,
	ShellRejectedSchema,
	type ShellResult,
	ShellResultSchema,
	type ShellStream,
	ShellStreamExitSchema,
	ShellStreamSchema,
	ShellStreamStartSchema,
	ShellStreamStderrSchema,
	ShellStreamStdoutSchema,
	ShellSuccessSchema,
	SmartModeClassifierErrorSchema,
	SmartModeClassifierResultSchema,
	SubagentAwaitNotFoundSchema,
	SubagentAwaitResultSchema,
	SubagentErrorSchema,
	SubagentResultSchema,
	ThinkingMessageSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WebFetchAllowlistPrecheckResultSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	WriteSuccessSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	create,
	decodeJsonValue,
	encodeJsonValue,
	fromBinary,
	type JsonValue,
	toBinary,
	toJson,
} from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isKimiK3ModelId, parseOpenAIModel } from "@oh-my-pi/pi-catalog/identity";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	$env,
	isRecord,
	logger,
	parseJsonWithRepair,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	sanitizeText,
} from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AudioContent,
	Context,
	CursorExecHandlerResult,
	CursorExecHandlers,
	CursorExecPairing,
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorTodoSnapshot,
	CursorTodoSnapshotItem,
	CursorTodoSyncHandler,
	CursorToolResultHandler,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	VideoContent,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	kCursorExecResolved,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingEnvelopeId,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForUrl } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { toolWireSchema } from "../utils/schema/wire";
import { formatConnectEndStreamError } from "./connect-error-detail";
import {
	buildMcpStateResult,
	buildNeutralHookResult,
	buildPiBashError,
	buildPiBashResult,
	buildPiEditError,
	buildPiEditRejected,
	buildPiEditResult,
	buildPiFindError,
	buildPiFindResult,
	buildPiGrepError,
	buildPiGrepResult,
	buildPiLsError,
	buildPiLsResult,
	buildPiReadError,
	buildPiReadResult,
	buildPiWriteError,
	buildPiWriteRejected,
	buildPiWriteResult,
	cursorEditOwnedReadPath,
	omitUndefinedArgs,
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadDisplayPath,
	piReadPathHasRange,
	piTimeout,
} from "./cursor/exec-modern";
import { handleInteractionQuery } from "./cursor/interaction-query";
import { mediaOmissionNote } from "./vision-guard";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";

const HTTP2_FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"http2-settings",
]);

const CURSOR_RESERVED_HEADERS = new Set([
	"content-type",
	"connect-protocol-version",
	"te",
	"authorization",
	"x-ghost-mode",
	"x-cursor-client-version",
	"x-cursor-client-type",
	"x-request-id",

	"host",

	"content-length",
]);

function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const field = name.toLowerCase();
		if (field.startsWith(":")) continue;
		if (HTTP2_FORBIDDEN_HEADERS.has(field)) continue;
		if (CURSOR_RESERVED_HEADERS.has(field)) continue;
		sanitized[field] = value;
	}
	return sanitized;
}

const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";

const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;

const CURSOR_MODEL_NOT_FOUND_PATTERN = /^(?:Connect error not_found:|gRPC error 5:)/i;
const NOT_IMPLEMENTED = `Not implemented by this client`;

const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();
const warnedCursorKimiK3ReplayMessages = new Set<string>();

const rotatedConversationIds = new Map<string, string>();

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	conversationId?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;

	wireModelId?: string;
}

type CursorWireMode = "normalized" | "discovered";

interface CursorStreamTiming {
	startTime: number;
	timestamp: number;
}

interface CursorRequestState {
	conversationId: string;
	blobStore: Map<string, Uint8Array>;
	conversationState?: ConversationStateStructure;
}

interface CursorGrpcRequest {
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
}

interface CursorTransportRequest extends CursorGrpcRequest {
	fallbackWireModelId?: string;
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

interface CursorLogEntry {
	ts: number;
	type: string;
	subtype?: string;
	data?: unknown;
}

async function appendCursorDebugLog(entry: CursorLogEntry): Promise<void> {
	const logPath = $env.DEBUG_CURSOR_LOG;
	if (!logPath) return;
	try {
		await fs.appendFile(logPath, `${JSON.stringify(entry, debugReplacer)}\n`);
	} catch {}
}

function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

class ConnectEndStreamError extends AIError.ProviderResponseError {
	readonly diagnosticMessage: string;

	constructor(classificationMessage: string, diagnosticMessage: string) {
		super(classificationMessage, { kind: "envelope" });
		this.diagnosticMessage = diagnosticMessage;
	}
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			const classificationMessage = `Connect error ${code}: ${message}`;
			return new ConnectEndStreamError(classificationMessage, formatConnectEndStreamError(error));
		}
		return null;
	} catch {
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", { kind: "envelope" });
	}
}

export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new AIError.ProviderResponseError(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
				"h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy (e.g. Zscaler). " +
				"Front the provider with a local HTTP/2 bridge and set providers.cursor.baseUrl to it.",
			{ provider: "cursor", kind: "runtime", cause: error },
		);
	}
	return error;
}

function debugBytes(bytes: Uint8Array, asHex: boolean): string {
	if (asHex) {
		return Buffer.from(bytes).toString("hex");
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/^[\x20-\x7E\s]*$/.test(text)) return text;
	} catch {}
	return Buffer.from(bytes).toString("hex");
}

function debugReplacer(key: string, value: unknown): unknown {
	if (
		value instanceof Uint8Array ||
		(value && typeof value === "object" && "type" in value && value.type === "Buffer")
	) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as any).data);
		const asHex = key === "blobId" || key === "blob_id" || key.endsWith("Id") || key.endsWith("_id");
		return debugBytes(bytes, asHex);
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

function extractLogBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value && typeof value === "object" && "type" in value && value.type === "Buffer") {
		const data = (value as { data?: number[] }).data;
		if (Array.isArray(data)) {
			return new Uint8Array(data);
		}
	}
	return null;
}

function decodeMcpArgsForLog(args?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	let mutated = false;
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const bytes = extractLogBytes(value);
		if (bytes) {
			decoded[key] = decodeMcpArgValue(bytes);
			mutated = true;
			continue;
		}
		const normalizedValue = decodeLogData(value);
		decoded[key] = normalizedValue;
		if (normalizedValue !== value) {
			mutated = true;
		}
	}
	return mutated ? decoded : args;
}

function decodeLogData(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => decodeLogData(entry));
	}
	const record = value as Record<string, unknown>;
	const typeName = record.$typeName;
	const stripTypeName = typeof typeName === "string" && typeName.startsWith("agent.v1.");

	if (typeName === "agent.v1.McpArgs") {
		const decodedArgs = decodeMcpArgsForLog(record.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		return decodedArgs ? { ...base, args: decodedArgs } : base;
	}
	if (typeName === "agent.v1.McpToolCall") {
		const argsRecord = record.args as Record<string, unknown> | undefined;
		const decodedArgs = decodeMcpArgsForLog(argsRecord?.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		if (decodedArgs && argsRecord) {
			return { ...base, args: { ...argsRecord, args: decodedArgs } };
		}
		return base;
	}

	let mutated = stripTypeName;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (stripTypeName && key === "$typeName") {
			continue;
		}
		const normalizedEntry = decodeLogData(entry);
		decoded[key] = normalizedEntry;
		if (normalizedEntry !== entry) {
			mutated = true;
		}
	}
	return mutated ? decoded : record;
}

function omitTypeName(record: Record<string, unknown>): Record<string, unknown> {
	const { $typeName: _, ...rest } = record;
	return rest;
}

function streamCursorWithWireMode(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorOptions | undefined,
	wireMode: CursorWireMode,
	timing?: CursorStreamTiming,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = timing?.startTime ?? performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-agent" as Api,
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
			timestamp: timing?.timestamp ?? Date.now(),
		};

		const inFlightDispatches = new Set<Promise<void>>();

		let abortSettled: Promise<void> | undefined;
		const drainInFlightDispatches = async (): Promise<void> => {
			const signal = options?.signal;
			while (inFlightDispatches.size > 0) {
				if (signal?.aborted) return;
				const settled = Promise.all([...inFlightDispatches]);
				if (!signal) {
					await settled;
					continue;
				}
				abortSettled ??= new Promise<void>(resolve =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				await Promise.race([settled, abortSettled]);
			}
		};

		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let debugResponseLogPromise: Promise<RequestDebugResponseLog | undefined> | undefined;
		const h2Completion = Promise.withResolvers<void>();
		let h2Settled = false;
		let sawTurnEnded = false;
		let endStreamError: Error | null = null;

		let sawProgressOrSideEffect = false;

		let openBlockState: BlockState | undefined;
		const settleH2 = (error?: unknown): void => {
			if (h2Settled) return;
			h2Settled = true;
			if (error !== undefined) {
				h2Completion.reject(error);
				return;
			}
			if (endStreamError) {
				h2Completion.reject(endStreamError);
				return;
			}
			if (!sawTurnEnded) {
				h2Completion.reject(
					new AIError.ProviderResponseError("Cursor stream ended before turnEnded", {
						kind: "incomplete-stream",
					}),
				);
				return;
			}
			h2Completion.resolve();
		};

		let baseConversationId: string | undefined;
		let conversationId: string | undefined;
		let usageState: UsageState | undefined;
		let serializedFallbackWireModelId: string | undefined;
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
			}

			baseConversationId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
			conversationId = rotatedConversationIds.get(baseConversationId) ?? baseConversationId;
			const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
			conversationBlobStores.set(conversationId, blobStore);
			const cachedState = conversationStateCache.get(conversationId);
			const builtRequest = await buildGrpcRequestForWireMode(
				model,
				context,
				options,
				{
					conversationId,
					blobStore,
					conversationState: cachedState,
				},
				wireMode,
			);
			const { requestBytes, conversationState } = builtRequest;
			serializedFallbackWireModelId = builtRequest.fallbackWireModelId;
			conversationStateCache.set(conversationId, conversationState);
			const requestContextTools = buildMcpToolDefinitions(context.tools);
			const requestContextRules = buildCursorRequestContextRules(context.systemPrompt);

			const baseUrl = model.baseUrl || CURSOR_API_URL;
			const requestPath = "/agent.v1.AgentService/Run";

			const callerHeaders = sanitizeCursorCallerHeaders(options?.headers);
			const requestHeaders = {
				...callerHeaders,
				":method": "POST",
				":path": requestPath,
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				te: "trailers",
				authorization: `Bearer ${apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": CURSOR_CLIENT_VERSION,
				"x-cursor-client-type": "cli",
				"x-request-id": crypto.randomUUID(),
			};
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "http2",
						method: "POST",
						url: new URL(requestPath, baseUrl).toString(),
						headers: requestHeaders,
						bodyBase64: Buffer.from(requestBytes).toString("base64"),
					})
				: undefined;

			const proxyUrl = getProxyForUrl(model.provider, new URL(baseUrl));
			if (proxyUrl) {
				const tlsSocket = await connectProxiedSocket(proxyUrl, baseUrl, {
					signal: options?.signal,
					timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
				});
				h2Client = http2.connect(baseUrl, {
					createConnection: () => tlsSocket,
				});
			} else {
				h2Client = http2.connect(baseUrl);
			}
			h2Client.on("error", error => settleH2(mapH2TransportError(error, baseUrl)));

			h2Request = h2Client.request(requestHeaders);

			stream.push({ type: "start", partial: output });

			let pendingBuffer: Buffer = Buffer.alloc(0);
			let currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentToolCall: ToolCallState | null = null;
			const resolvedMcpToolCallIds = new Set<string>();
			usageState = { sawTokenDelta: false };

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get currentToolCall() {
					return currentToolCall;
				},
				openToolCalls: new Map<string, ToolCallState>(),
				resolvedMcpToolCallIds,
				get firstTokenTime() {
					return firstTokenTime;
				},
				setTextBlock: b => {
					currentTextBlock = b;
				},
				setThinkingBlock: b => {
					currentThinkingBlock = b;
				},
				setToolCall: t => {
					currentToolCall = t;
				},
				setFirstTokenTime: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				onTodoSnapshot: options?.execHandlers?.todoSync?.bind(options.execHandlers),
				onToolResult: options?.onToolResult,
			};
			openBlockState = state;

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
				conversationStateCache.set(conversationId!, checkpoint);
			};

			h2Request.on("response", headers => {
				debugResponseLogPromise = debugSession?.openResponseLog(
					`HTTP/2 ${headers[":status"] ?? ""}`.trim(),
					headers,
				);
			});

			h2Request.on("data", (chunk: Buffer) => {
				if (debugResponseLogPromise) {
					void debugResponseLogPromise.then(log => {
						log?.write(chunk);
					});
				}

				pendingBuffer = pendingBuffer.length === 0 ? chunk : Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							h2Request?.close();
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const interaction =
							serverMessage.message.case === "interactionUpdate" ? serverMessage.message.value : undefined;
						const interactionCase = interaction?.message?.case;

						if (interactionCase !== "heartbeat") sawProgressOrSideEffect = true;
						const isTurnEnded = interactionCase === "turnEnded";

						const dispatch = handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							options?.execHandlers,
							options?.onToolResult,
							usageState!,
							requestContextTools,
							requestContextRules,
							onConversationCheckpoint,
						).catch(error => {
							log("error", "handleServerMessage", { error: String(error) });
						});
						inFlightDispatches.add(dispatch);
						void dispatch.finally(() => inFlightDispatches.delete(dispatch));

						if (isTurnEnded) {
							sawTurnEnded = true;
						}
					} catch (e) {
						log("error", "parseServerMessage", { error: String(e) });
					}
				}
			});

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
				h2Request.write(frameConnectMessage(heartbeatBytes));
			};

			const closeDebugLog = async (): Promise<void> => {
				const log = await debugResponseLogPromise;
				await log?.close();
			};

			h2Request.on("trailers", trailers => {
				const status = trailers["grpc-status"];
				const msg = trailers["grpc-message"];
				if (status && status !== "0" && !endStreamError) {
					endStreamError = new AIError.ProviderResponseError(
						`gRPC error ${status}: ${decodeURIComponent(String(msg || ""))}`,
						{ kind: "envelope" },
					);
				}
			});

			h2Request.on("end", () => {
				void closeDebugLog()
					.then(() => settleH2())
					.catch(error => settleH2(error));
			});

			h2Request.on("error", error => {
				const mapped = mapH2TransportError(error, baseUrl);
				void closeDebugLog().finally(() => settleH2(mapped));
			});

			if (options?.signal) {
				options.signal.addEventListener("abort", () => {
					h2Request?.close();
					void closeDebugLog().finally(() => {
						settleH2(new AIError.AbortError());
					});
				});
			}

			h2Request.write(frameConnectMessage(requestBytes));
			heartbeatTimer = setInterval(sendHeartbeat, 5000);
			await h2Completion.promise;

			await drainInFlightDispatches();

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			flushOpenToolCalls(output, stream, state);

			calculateCost(model, output.usage);

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			const fallbackWireModelId =
				wireMode === "normalized" &&
				!sawProgressOrSideEffect &&
				!options?.signal?.aborted &&
				error instanceof Error &&
				CURSOR_MODEL_NOT_FOUND_PATTERN.test(error.message)
					? serializedFallbackWireModelId
					: undefined;
			if (fallbackWireModelId !== undefined) {
				if (heartbeatTimer) {
					clearInterval(heartbeatTimer);
					heartbeatTimer = null;
				}
				h2Request?.close();
				h2Client?.close();

				const fallbackStream = streamCursorWithWireMode(model, context, options, "discovered", {
					startTime,
					timestamp: output.timestamp,
				});

				stream.forwardLocalWorkFrom(fallbackStream);
				try {
					for await (const event of fallbackStream) {
						if (event.type === "start") continue;
						stream.push(event);
					}
					const fallbackResult = await fallbackStream.result();
					if (!stream.resultSettled) stream.end(fallbackResult);
				} finally {
					stream.forwardLocalWorkFrom(undefined);
				}
				return;
			}

			await drainInFlightDispatches();

			if (openBlockState) {
				endCurrentTextBlock(output, stream, openBlockState);
				endCurrentThinkingBlock(output, stream, openBlockState);
				flushOpenToolCalls(output, stream, openBlockState);
			}
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });

			if (
				conversationId !== undefined &&
				baseConversationId !== undefined &&
				usageState !== undefined &&
				!usageState.sawTokenDelta &&
				RESOURCE_EXHAUSTED_PATTERN.test(result.message) &&
				!rotatedConversationIds.has(baseConversationId)
			) {
				const rotated = crypto.randomUUID();
				rotatedConversationIds.set(baseConversationId, rotated);
				const state = conversationStateCache.get(conversationId);
				if (state) conversationStateCache.set(rotated, state);
				const blobs = conversationBlobStores.get(conversationId);
				if (blobs) conversationBlobStores.set(rotated, blobs);
			}
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			if (error instanceof ConnectEndStreamError) {
				output.errorClassificationMessage = result.message;
				output.errorMessage = error.diagnosticMessage;
			} else {
				output.errorMessage = result.message;
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			const log = await debugResponseLogPromise;
			await log?.close();
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			h2Request?.close();
			h2Client?.close();
		}
	})();

	return stream;
}

export const streamCursor: StreamFunction<"cursor-agent"> = (model, context, options) =>
	streamCursorWithWireMode(model, context, options, "normalized");

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec" | "cursor-edit" | "connect-scm" | "web-fetch";
	[kStreamingEnvelopeId]?: string;
	[kCursorExecResolved]?: true;
};

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;

	openToolCalls: Map<string, ToolCallState>;

	resolvedMcpToolCallIds: Set<string>;

	editOwnedToolCallIds?: Set<string>;

	pairedEditToolCallIds?: Set<string>;
	firstTokenTime: number | undefined;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	setFirstTokenTime: () => void;

	onTodoSnapshot?: CursorTodoSyncHandler;

	onToolResult?: CursorToolResultHandler;
}

function markCursorExecResolved(block: CursorExecResolvedCarrier): void {
	block[kCursorExecResolved] = true;
}

export interface UsageState {
	sawTokenDelta: boolean;
}

export async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	usageState: UsageState,
	requestContextTools: McpToolDefinition[],
	requestContextRules: CursorRule[] = [],
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): Promise<void> {
	const msgCase = msg.message.case;

	log("serverMessage", msgCase, msg.message.value);

	if (msgCase === "interactionUpdate") {
		processInteractionUpdate(msg.message.value, output, stream, state, usageState);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request);
	} else if (msgCase === "execServerMessage") {
		await stream.trackLocalWork(
			handleExecServerMessage(
				msg.message.value as ExecServerMessage,
				h2Request,
				execHandlers,
				onToolResult,
				requestContextTools,
				requestContextRules,
				output,
				stream,
				state,
			),
		);
	} else if (msgCase === "interactionQuery") {
		handleInteractionQuery(msg.message.value, h2Request);
	} else if (msgCase === "conversationCheckpointUpdate") {
		handleConversationCheckpointUpdate(msg.message.value, output, usageState, onConversationCheckpoint);
	}
}

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array };

type HostedFetchCall = {
	args?: { url?: string; toolCallId?: string };
	result?: { result?: { case?: string; value?: { content?: string; error?: string; url?: string } } };
};

function selectHostedFetchCall(
	toolCall: { tool?: { case?: string; value?: HostedFetchCall } } | undefined,
): HostedFetchCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "fetchToolCall" || oneof?.case === "webFetchToolCall") return oneof.value;
	return undefined;
}

function hostedFetchUnknown(toolCall: object | undefined): boolean {
	if (!toolCall) return false;
	return (
		protoUnknownFields(toolCall).some(field => field.no === 37) ||
		protoUnknownFields((toolCall as { tool?: object }).tool ?? {}).some(field => field.no === 37)
	);
}

function extractHttpUrlFromUnknown(message: object): string | undefined {
	for (const field of protoUnknownFields(message)) {
		const match = new TextDecoder().decode(field.data).match(/https?:\/\/[^\x00-\x1f]+/);
		if (match) return match[0];
	}
	const nested = (message as { tool?: object }).tool;
	return nested ? extractHttpUrlFromUnknown(nested) : undefined;
}

function describeHostedFetchResult(call: HostedFetchCall | undefined): { text: string; isError: boolean } {
	const result = call?.result?.result;
	if (result?.case === "success") {
		return { text: result.value?.content || result.value?.url || "Fetched", isError: false };
	}
	if (result?.case === "error") {
		return { text: result.value?.error || "Fetch failed", isError: true };
	}
	return { text: "Fetch completed", isError: false };
}

function protoUnknownFields(message: object): ProtoUnknownField[] {
	const raw = (message as { $unknown?: ProtoUnknownField[] }).$unknown;
	return Array.isArray(raw) ? raw : [];
}

function handleKvServerMessage(
	kvMsg: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
): void {
	const kvCase = kvMsg.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message.value.blobId;
		const blobIdKey = Buffer.from(blobId).toString("hex");

		const blobData = blobStore.get(blobIdKey);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "getBlobResult", { blobId: blobIdKey.slice(0, 40) });
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		blobStore.set(blobIdKey, blobData);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "setBlobResult", { blobId: blobIdKey.slice(0, 40) });
	}
}

function sendShellStreamEvent(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	event: ShellStream["event"],
): void {
	sendExecClientMessage(h2Request, execMsg, "shellStream", create(ShellStreamSchema, { event }));
}

function sanitizeShellExecResult(execResult: ShellResult): ShellResult {
	const result = execResult.result;
	if (!result) return execResult;

	switch (result.case) {
		case "success":
		case "failure": {
			const value = result.value;
			return {
				...execResult,
				result: {
					case: result.case,
					value: {
						...value,
						stdout: value.stdout ? sanitizeText(value.stdout) : value.stdout,
						stderr: value.stderr ? sanitizeText(value.stderr) : value.stderr,
					},
				},
			} as ShellResult;
		}
		default:
			return execResult;
	}
}

async function handleShellStreamArgs(
	args: ShellArgs,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<void> {
	const normalizedWorkingDirectory = args.workingDirectory || process.cwd();
	const normalizedArgs: ShellArgs = { ...args, workingDirectory: normalizedWorkingDirectory };
	const startTs = performance.now();
	log("shellStream", "start", {
		command: (args as any).command,
		workingDirectory: normalizedWorkingDirectory,
		execId: execMsg.execId,
		hasExecHandlers: !!execHandlers,
		hasShell: !!execHandlers?.shell,
		hasShellStream: !!execHandlers?.shellStream,
	});

	sendShellStreamEvent(h2Request, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });

	let stdoutBuffer = "";
	let stderrBuffer = "";

	const incompleteEscapeRegex = /\x1b(|\[|\[\d*|\[\?|\[\?\d*|\]\d*;?)$/;

	const flushStdout = () => {
		if (stdoutBuffer) {
			let safeEnd = stdoutBuffer.length;
			const match = stdoutBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stdoutBuffer.length - match[0].length;
			}
			const toSend = stdoutBuffer.slice(0, safeEnd);
			const remaining = stdoutBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stdout",
					value: create(ShellStreamStdoutSchema, { data: sanitizeText(toSend) }),
				});
			}
			stdoutBuffer = remaining;
		}
	};

	const flushStderr = () => {
		if (stderrBuffer) {
			let safeEnd = stderrBuffer.length;
			const match = stderrBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stderrBuffer.length - match[0].length;
			}
			const toSend = stderrBuffer.slice(0, safeEnd);
			const remaining = stderrBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stderr",
					value: create(ShellStreamStderrSchema, { data: sanitizeText(toSend) }),
				});
			}
			stderrBuffer = remaining;
		}
	};

	let stdoutFlushTimer: NodeJS.Timeout | null = null;
	let stderrFlushTimer: NodeJS.Timeout | null = null;

	const scheduleStdoutFlush = () => {
		if (!stdoutFlushTimer) {
			stdoutFlushTimer = setTimeout(() => {
				stdoutFlushTimer = null;
				flushStdout();
			}, 100);
		}
	};

	const scheduleStderrFlush = () => {
		if (!stderrFlushTimer) {
			stderrFlushTimer = setTimeout(() => {
				stderrFlushTimer = null;
				flushStderr();
			}, 100);
		}
	};

	const streamCallbacks: CursorShellStreamCallbacks = {
		onStdout(data: string) {
			stdoutBuffer += data;
			if (stdoutBuffer.includes("\n") || stdoutBuffer.length > 4096) {
				if (stdoutFlushTimer) {
					clearTimeout(stdoutFlushTimer);
					stdoutFlushTimer = null;
				}
				flushStdout();
			} else {
				scheduleStdoutFlush();
			}
		},
		onStderr(data: string) {
			stderrBuffer += data;
			if (stderrBuffer.includes("\n") || stderrBuffer.length > 4096) {
				if (stderrFlushTimer) {
					clearTimeout(stderrFlushTimer);
					stderrFlushTimer = null;
				}
				flushStderr();
			} else {
				scheduleStderrFlush();
			}
		},
	};

	const streamHandler = execHandlers?.shellStream?.bind(execHandlers);
	const batchHandler = execHandlers?.shell?.bind(execHandlers);
	const handler = streamHandler ? (shellArgs: ShellArgs) => streamHandler(shellArgs, streamCallbacks) : batchHandler;

	const { execResult } = await resolveExecHandler(
		args as any,
		handler as typeof batchHandler,
		onToolResult,
		toolResult => buildShellResultFromToolResult(normalizedArgs as any, toolResult),
		reason =>
			buildShellRejectedResult((normalizedArgs as any).command, (normalizedArgs as any).workingDirectory, reason),
		error =>
			buildShellFailureResult((normalizedArgs as any).command, (normalizedArgs as any).workingDirectory, error),
		{ toolCallId: args.toolCallId, toolName: "bash" },
	);

	const sendBufferedOutput = !streamHandler;
	const sanitizedExecResult = sanitizeShellExecResult(execResult);

	if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
	if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
	flushStdout();
	flushStderr();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);

	sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
	sendExecClientStreamClose(h2Request, execMsg);

	log("shellStream", "done", { elapsed: performance.now() - startTs });
}

function sendShellStreamExitFromResult(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	execResult: ShellResult,
	sendBufferedOutput: boolean,
): void {
	const result = execResult.result;
	switch (result.case) {
		case "success": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "failure": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: value.aborted,
					abortReason: value.abortReason,
				}),
			});
			return;
		}
		case "rejected": {
			sendShellStreamEvent(h2Request, execMsg, { case: "rejected", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "timeout": {
			const value = result.value;
			sendShellStreamEvent(h2Request, execMsg, {
				case: "stderr",
				value: create(ShellStreamStderrSchema, {
					data: `Command timed out after ${value.timeoutMs}ms`,
				}),
			});
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: value.workingDirectory,
					aborted: true,
				}),
			});
			return;
		}
		case "permissionDenied": {
			sendShellStreamEvent(h2Request, execMsg, { case: "permissionDenied", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		default:
			return;
	}
}

async function handleExecServerMessage(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	requestContextTools: McpToolDefinition[],
	requestContextRules: CursorRule[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): Promise<void> {
	const execCase = execMsg.message.case;
	log("exec", "dispatch", { execCase, execId: execMsg.execId, hasHandlers: !!execHandlers });
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			rules: requestContextRules,
			repositoryInfo: [],
			tools: requestContextTools,
			gitRepos: [],
			projectLayouts: [],
			mcpInstructions: [],
			fileContents: {},
			customSubagents: [],
		});

		const requestContextResult = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext }),
			},
		});

		sendExecClientMessage(h2Request, execMsg, "requestContextResult", requestContextResult);
		log("execClient", "requestContextResult");
		return;
	}

	if (!execCase) {
		log("warn", "unknownExecVariant", { id: execMsg.id, execId: execMsg.execId });
		sendExecClientThrow(h2Request, execMsg, "Unknown exec message variant", "unknown_exec_variant");
		return;
	}

	switch (execCase) {
		case "readArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const editOwned = isEditOwnedToolCallId(state, output, args.toolCallId);

			const composed = editOwned ? cursorEditOwnedReadPath(args.path, args.offset, args.limit) : args.path;
			const handlerArgs = editOwned
				? composed === null
					? args
					: { ...args, path: composed, offset: undefined, limit: undefined }
				: args;
			if (!editOwned) {
				synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", {
					path: piReadDisplayPath(args.path, args.offset, args.limit),
				});
			}
			const { execResult } = await resolveExecHandler(
				handlerArgs,
				execHandlers?.read?.bind(execHandlers),
				editOwned ? undefined : onToolResult,
				toolResult =>
					buildReadResultFromToolResult(
						args.path,
						toolResult,
						args.offset !== undefined || args.limit !== undefined || piReadPathHasRange(args.path),
					),
				reason => buildReadRejectedResult(args.path, reason),
				error => buildReadErrorResult(args.path, error),
				editOwned ? null : { toolCallId: args.toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "readResult", execResult);
			return;
		}
		case "lsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();

			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.ls?.bind(execHandlers),
				onToolResult,
				toolResult => buildLsResultFromToolResult(args.path, toolResult),
				reason => buildLsRejectedResult(args.path, reason),
				error => buildLsErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "lsResult", execResult);
			return;
		}
		case "grepArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();

			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				sendExecClientMessage(h2Request, execMsg, "grepResult", buildGrepErrorResult(emptyPatternError));
				return;
			}

			const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "grep", {
				pattern: args.pattern,
				path: searchPath,
				case: args.caseInsensitive === true ? false : undefined,
				skip: piGrepSkip(args.offset),
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.grep?.bind(execHandlers),
				onToolResult,
				toolResult => buildGrepResultFromToolResult(args, toolResult),
				reason => buildGrepErrorResult(reason),
				error => buildGrepErrorResult(error),
				{ toolCallId: args.toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "grepResult", execResult);
			return;
		}
		case "writeArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const editOwned = isEditOwnedToolCallId(state, output, args.toolCallId);

			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			if (!editOwned) {
				synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "write", {
					path: args.path,
					content,
				});
			}
			const write = execHandlers?.write?.bind(execHandlers);
			const writeHandler = write
				? async (writeArgs: typeof args) => {
						const result = await write(writeArgs);
						return editOwned ? remapExecHandlerToolName(result, "edit") : result;
					}
				: undefined;
			const { execResult } = await resolveExecHandler(
				args,
				writeHandler,
				onToolResult,
				toolResult =>
					buildWriteResultFromToolResult(
						{
							path: args.path,
							fileText: args.fileText,
							fileBytes: args.fileBytes,
							returnFileContentAfterWrite: args.returnFileContentAfterWrite,
						},
						toolResult,
					),
				reason => buildWriteRejectedResult(args.path, reason),
				error => buildWriteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: editOwned ? "edit" : "write" },
			);
			if (editOwned) markEditToolCallPaired(state, args.toolCallId);
			sendExecClientMessage(h2Request, execMsg, "writeResult", execResult);
			return;
		}
		case "deleteArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "delete", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.delete?.bind(execHandlers),
				onToolResult,
				toolResult => buildDeleteResultFromToolResult(args.path, toolResult),
				reason => buildDeleteRejectedResult(args.path, reason),
				error => buildDeleteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "delete" },
			);
			sendExecClientMessage(h2Request, execMsg, "deleteResult", execResult);
			return;
		}
		case "shellArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };

			const shellTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellTimeout,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.shell?.bind(execHandlers),
				onToolResult,
				toolResult => buildShellResultFromToolResult(normalizedArgs, toolResult),
				reason => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				error => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			const sanitizedExecResult = sanitizeShellExecResult(execResult);
			sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
			return;
		}
		case "shellStreamArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const shellStreamTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellStreamTimeout,
			});
			await handleShellStreamArgs(args, execMsg, h2Request, execHandlers, onToolResult);
			return;
		}
		case "backgroundShellSpawnArgs": {
			const args = execMsg.message.value;
			const execResult = create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command,
						workingDirectory: args.workingDirectory,
						reason: "Not implemented",
						isReadonly: false,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "backgroundShellSpawnResult", execResult);
			return;
		}
		case "writeShellStdinArgs": {
			const execResult = create(WriteShellStdinResultSchema, {
				result: {
					case: "error",
					value: create(WriteShellStdinErrorSchema, {
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "writeShellStdinResult", execResult);
			return;
		}
		case "fetchArgs": {
			const args = execMsg.message.value;
			const execResult = create(FetchResultSchema, {
				result: {
					case: "error",
					value: create(FetchErrorSchema, {
						url: args.url,
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "fetchResult", execResult);
			return;
		}
		case "diagnosticsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();

			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "lsp", {
				action: "diagnostics",
				file: args.path,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.diagnostics?.bind(execHandlers),
				onToolResult,
				toolResult => buildDiagnosticsResultFromToolResult(args.path, toolResult),
				reason => buildDiagnosticsRejectedResult(args.path, reason),
				error => buildDiagnosticsErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "lsp" },
			);
			sendExecClientMessage(h2Request, execMsg, "diagnosticsResult", execResult);
			return;
		}
		case "mcpArgs": {
			const args = execMsg.message.value;
			const mcpCall = decodeMcpCall(args);

			if (mcpCall.approvalOnly) {
				const approved = (await execHandlers?.mcpApprovalPreflight?.(mcpCall)) === true;
				sendExecClientMessage(
					h2Request,
					execMsg,
					"mcpResult",
					create(McpResultSchema, {
						result: approved
							? { case: "approved", value: create(McpApprovedSchema, {}) }
							: {
									case: "rejected",
									value: create(McpRejectedSchema, {
										reason: `Tool "${mcpCall.toolName || mcpCall.name}" is not approved to run without asking.`,
									}),
								},
					}),
				);
				return;
			}
			if (execHandlers?.mcp) {
				const existingBlock = output.content.find(
					block => block.type === "toolCall" && block.id === mcpCall.toolCallId,
				);
				if (existingBlock) {
					markCursorExecResolved(existingBlock);
				} else {
					synthesizeCursorExecToolCall(
						output,
						stream,
						state,
						mcpCall.toolCallId,
						mcpCall.toolName || mcpCall.name,
						mcpCall.args,
					);
					state.resolvedMcpToolCallIds.add(mcpCall.toolCallId);
				}
			}
			const { execResult } = await resolveExecHandler(
				mcpCall,
				execHandlers?.mcp?.bind(execHandlers),
				onToolResult,
				toolResult => buildMcpResultFromToolResult(mcpCall, toolResult),
				_reason => buildMcpToolNotFoundResult(mcpCall),
				error => buildMcpErrorResult(error),
				execHandlers?.mcp ? { toolCallId: mcpCall.toolCallId, toolName: mcpCall.toolName } : null,
			);
			sendExecClientMessage(h2Request, execMsg, "mcpResult", execResult);
			return;
		}
		case "listMcpResourcesExecArgs": {
			const args = execMsg.message.value;
			let execResult: ListMcpResourcesExecResult;

			const toolCallId = execHandlers?.listMcpResources ? crypto.randomUUID() : undefined;
			if (toolCallId) {
				synthesizeCursorExecToolCall(output, stream, state, toolCallId, "list_mcp_resources", {
					server: args.server,
				});
			}
			try {
				const resources = (await execHandlers?.listMcpResources?.({ server: args.server })) ?? [];
				execResult = create(ListMcpResourcesExecResultSchema, {
					result: {
						case: "success",
						value: create(ListMcpResourcesSuccessSchema, {
							resources: resources.map(resource =>
								create(ListMcpResourcesExecResult_McpResourceSchema, {
									uri: resource.uri,
									name: resource.name,
									description: resource.description,
									mimeType: resource.mimeType,
									server: resource.server,
								}),
							),
						}),
					},
				});
			} catch (error) {
				execResult = create(ListMcpResourcesExecResultSchema, {
					result: {
						case: "error",
						value: create(ListMcpResourcesErrorSchema, {
							error: error instanceof Error ? error.message : String(error),
						}),
					},
				});
			}
			if (toolCallId) {
				const settled = execResult.result;
				const text =
					settled.case === "success"
						? formatListedMcpResources(settled.value.resources)
						: settled.case === "error"
							? settled.value.error || "Failed to list MCP resources"
							: (settled.value?.reason ?? "Failed to list MCP resources");
				await pairSynthesizedExecResult(
					state,
					onToolResult,
					toolCallId,
					"list_mcp_resources",
					text,
					settled.case !== "success",
				);
			}
			sendExecClientMessage(h2Request, execMsg, "listMcpResourcesExecResult", execResult);
			return;
		}
		case "readMcpResourceExecArgs": {
			const args = execMsg.message.value;
			let execResult: ReadMcpResourceExecResult;

			const toolCallId = execHandlers?.readMcpResource ? crypto.randomUUID() : undefined;
			if (toolCallId) {
				synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read_mcp_resource", {
					server: args.server,
					uri: args.uri,
					download_path: args.downloadPath,
				});
			}
			try {
				const content = await execHandlers?.readMcpResource?.({
					server: args.server,
					uri: args.uri,
					downloadPath: args.downloadPath,
				});
				execResult = content
					? create(ReadMcpResourceExecResultSchema, {
							result: {
								case: "success",
								value: create(ReadMcpResourceSuccessSchema, {
									uri: content.uri,
									name: content.name,
									description: content.description,
									mimeType: content.mimeType,
									downloadPath: content.downloadPath,

									content:
										content.downloadPath !== undefined
											? { case: undefined }
											: content.text !== undefined
												? { case: "text", value: content.text }
												: content.blob !== undefined
													? { case: "blob", value: content.blob }
													: { case: undefined },
								}),
							},
						})
					: create(ReadMcpResourceExecResultSchema, {
							result: { case: "notFound", value: create(ReadMcpResourceNotFoundSchema, { uri: args.uri }) },
						});
			} catch (error) {
				execResult = create(ReadMcpResourceExecResultSchema, {
					result: {
						case: "error",
						value: create(ReadMcpResourceErrorSchema, {
							uri: args.uri,
							error: error instanceof Error ? error.message : String(error),
						}),
					},
				});
			}
			if (toolCallId) {
				const settled = execResult.result;
				let text: string;
				switch (settled.case) {
					case "success":
						text = settled.value.downloadPath
							? `Downloaded ${args.uri} to ${settled.value.downloadPath}`
							: `Read ${args.uri}`;
						break;
					case "notFound":
						text = `No such resource: ${args.uri}`;
						break;

					case "rejected":
						text = `Refused: ${settled.value.reason}`;
						break;
					default:
						text = settled.value?.error ?? `Failed to read ${args.uri}`;
						break;
				}
				await pairSynthesizedExecResult(
					state,
					onToolResult,
					toolCallId,
					"read_mcp_resource",
					text,
					settled.case !== "success",
				);
			}
			sendExecClientMessage(h2Request, execMsg, "readMcpResourceExecResult", execResult);
			return;
		}
		case "recordScreenArgs": {
			const execResult = create(RecordScreenResultSchema, {
				result: { case: "failure", value: create(RecordScreenFailureSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "recordScreenResult", execResult);
			return;
		}
		case "computerUseArgs": {
			const execResult = create(ComputerUseResultSchema, {
				result: { case: "error", value: create(ComputerUseErrorSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "computerUseResult", execResult);
			return;
		}
		case "piReadArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();

			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read", {
				path: piReadDisplayPath(args.path, args.offset, args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piRead?.bind(execHandlers),
				onToolResult,
				buildPiReadResult,
				buildPiReadError,
				buildPiReadError,
				{ toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "piReadResult", execResult);
			return;
		}
		case "piBashArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "bash", {
				command: args.command,
				timeout: piTimeout(args.timeout),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piBash?.bind(execHandlers),
				onToolResult,
				buildPiBashResult,
				buildPiBashError,
				buildPiBashError,
				{ toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "piBashResult", execResult);
			return;
		}
		case "piEditArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();

			const firstEdit = args.edits[0];
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "edit", {
				path: args.path,
				old_string: firstEdit?.oldText ?? "",
				new_string: firstEdit?.newText ?? "",
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piEdit?.bind(execHandlers),
				onToolResult,
				buildPiEditResult,
				buildPiEditRejected,
				buildPiEditError,
				{ toolCallId, toolName: "edit" },
			);
			sendExecClientMessage(h2Request, execMsg, "piEditResult", execResult);
			return;
		}
		case "piWriteArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "write", {
				path: args.path,
				content: args.content,
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piWrite?.bind(execHandlers),
				onToolResult,
				buildPiWriteResult,
				buildPiWriteRejected,
				buildPiWriteError,
				{ toolCallId, toolName: "write" },
			);
			sendExecClientMessage(h2Request, execMsg, "piWriteResult", execResult);
			return;
		}
		case "piGrepArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "grep", {
				pattern: args.literal === true ? piEscapeRegexLiteral(args.pattern) : args.pattern,
				path: args.glob ? piJoinPath(args.path, args.glob) : args.path || ".",
				case: args.ignoreCase === true ? false : undefined,

				context: args.context,
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piGrep?.bind(execHandlers),
				onToolResult,
				buildPiGrepResult,
				buildPiGrepError,
				buildPiGrepError,
				{ toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "piGrepResult", execResult);
			return;
		}
		case "piFindArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "glob", {
				path: piJoinPath(args.path, args.pattern),
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piFind?.bind(execHandlers),
				onToolResult,
				buildPiFindResult,
				buildPiFindError,
				buildPiFindError,
				{ toolCallId, toolName: "glob" },
			);
			sendExecClientMessage(h2Request, execMsg, "piFindResult", execResult);
			return;
		}
		case "piLsArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();

			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read", { path: piLsPath(args.path) });
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piLs?.bind(execHandlers),
				onToolResult,
				buildPiLsResult,
				buildPiLsError,
				buildPiLsError,
				{ toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "piLsResult", execResult);
			return;
		}
		case "miniSweAgentBashArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
			});
			const { execResult } = await resolveExecHandler(
				normalizedArgs,
				execHandlers?.shell?.bind(execHandlers),
				onToolResult,
				toolResult => buildShellResultFromToolResult(normalizedArgs, toolResult),
				reason => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				error => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "miniSweAgentBashResult", sanitizeShellExecResult(execResult));
			return;
		}
		case "redactedReadArgs": {
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"redactedReadResult",
				buildReadErrorResult(args.path, "Secret redaction is not implemented by this client"),
			);
			return;
		}
		case "mcpStateExecArgs": {
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpStateExecResult",
				buildMcpStateResult(requestContextTools, args.serverIdentifiers),
			);
			return;
		}
		case "executeHookArgs": {
			const args = execMsg.message.value;
			const execResult = buildNeutralHookResult(args.request);
			if (!execResult) {
				sendExecClientThrow(
					h2Request,
					execMsg,
					`Unsupported hook request: ${args.request?.request.case ?? "unset"}`,
					"unknown_hook_request",
				);
				return;
			}
			sendExecClientMessage(h2Request, execMsg, "executeHookResult", execResult);
			return;
		}
		case "subagentArgs": {
			const args = execMsg.message.value;
			const execResult = create(SubagentResultSchema, {
				result: {
					case: "error",
					value: create(SubagentErrorSchema, { error: `Subagents are ${NOT_IMPLEMENTED_SUFFIX}` }),
				},
			});
			log("exec", "subagentRejected", { subagentType: args.subagentType });
			sendExecClientMessage(h2Request, execMsg, "subagentResult", execResult);
			return;
		}
		case "subagentAwaitArgs": {
			const args = execMsg.message.value;
			const execResult = create(SubagentAwaitResultSchema, {
				result: {
					case: "notFound",
					value: create(SubagentAwaitNotFoundSchema, { agentId: args.agentId }),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "subagentAwaitResult", execResult);
			return;
		}
		case "forceBackgroundShellArgs": {
			const execResult = create(ForceBackgroundShellResultSchema, {
				status: ForceBackgroundShellStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundShellResult", execResult);
			return;
		}
		case "forceBackgroundSubagentArgs": {
			const execResult = create(ForceBackgroundSubagentResultSchema, {
				status: ForceBackgroundSubagentStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundSubagentResult", execResult);
			return;
		}
		case "smartModeClassifierArgs": {
			const execResult = create(SmartModeClassifierResultSchema, {
				result: {
					case: "error",
					value: create(SmartModeClassifierErrorSchema, {
						error: `Smart-mode classification is ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "smartModeClassifierResult", execResult);
			return;
		}
		case "canvasDiagnosticsArgs": {
			const args = execMsg.message.value;
			const execResult = create(CanvasDiagnosticsResultSchema, {
				result: {
					case: "error",
					value: create(CanvasDiagnosticsErrorSchema, {
						path: args.path,
						error: `Canvas diagnostics are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "canvasDiagnosticsResult", execResult);
			return;
		}
		case "shellAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"shellAllowlistPrecheckResult",
				create(ShellAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "mcpAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpAllowlistPrecheckResult",
				create(McpAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "webFetchAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"webFetchAllowlistPrecheckResult",
				create(WebFetchAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "conversationSearchArgs": {
			const args = execMsg.message.value;
			const toolCallId = args.toolCallId || crypto.randomUUID();
			const error = `Conversation search is ${NOT_IMPLEMENTED_SUFFIX}`;
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "search_conversations", {
				query: args.query,
				limit: args.limit,
			});
			await pairSynthesizedExecResult(state, onToolResult, toolCallId, "search_conversations", error);
			const execResult = create(ConversationSearchResultSchema, {
				result: { case: "error", value: create(ConversationSearchErrorSchema, { error }) },
			});
			sendExecClientMessage(h2Request, execMsg, "conversationSearchResult", execResult);
			return;
		}
		case "agentStoreConflictArgs": {
			const execResult = create(AgentStoreConflictResultSchema, {
				result: {
					case: "error",
					value: create(AgentStoreConflictErrorSchema, {
						error: `Agent store conflicts are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "agentStoreConflictResult", execResult);
			return;
		}
		case "gitDiffRequest": {
			sendExecClientThrow(h2Request, execMsg, `Git diff is ${NOT_IMPLEMENTED_SUFFIX}`, "exec_variant_unsupported");
			return;
		}
		default: {
			log("warn", "unhandledExecMessage", { execCase });
			sendExecClientThrow(
				h2Request,
				execMsg,
				`No handler for exec message of type ${execCase}`,
				"exec_variant_unsupported",
			);
		}
	}
}

function sendExecClientMessage<TCase extends NonNullable<ExecClientMessage["message"]["case"]>>(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	messageCase: TCase,
	value: Extract<ExecClientMessage["message"], { case: TCase }>["value"],
): void {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMsg.id,
		execId: execMsg.execId,
		message: { case: messageCase, value } as ExecClientMessage["message"],
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});

	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	h2Request.write(frameConnectMessage(responseBytes));

	log("execClientMessage", messageCase, value);
}

function sendExecClientThrow(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	error: string,
	errorCode?: string,
): void {
	const controlMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "throw",
			value: create(ExecClientThrowSchema, { id: execMsg.id, error, errorCode }),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: controlMessage },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("execClientControl", "throw", { id: execMsg.id, execId: execMsg.execId, error, errorCode });
	sendExecClientStreamClose(h2Request, execMsg);
}

function sendExecClientStreamClose(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): void {
	const closeMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "streamClose",
			value: create(ExecClientStreamCloseSchema, {
				id: execMsg.id,
			}),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: closeMessage },
	});
	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	h2Request.write(frameConnectMessage(responseBytes));
	log("execClientControl", "streamClose", { id: execMsg.id, execId: execMsg.execId });
}

export async function resolveExecHandler<TArgs, TResult>(
	args: TArgs,
	handler: ((args: TArgs) => Promise<CursorExecHandlerResult<TResult>>) | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	buildFromToolResult: (toolResult: ToolResultMessage) => TResult,
	buildRejected: (reason: string) => TResult,
	buildError: (error: string) => TResult,
	pairing: CursorExecPairing | null,
): Promise<{ execResult: TResult; toolResult?: ToolResultMessage }> {
	const pair = async (text: string, isError: boolean): Promise<ToolResultMessage | undefined> => {
		if (!pairing) return undefined;
		const synthesized: ToolResultMessage = {
			role: "toolResult",
			toolCallId: pairing.toolCallId,
			toolName: pairing.toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		};
		return await applyToolResultHandler(synthesized, onToolResult);
	};

	if (!handler) {
		const reason = "Tool not available";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	}

	try {
		const handlerResult = await handler(args);
		const { execResult, toolResult } = splitExecHandlerResult(handlerResult);
		const finalToolResult = await applyToolResultHandler(toolResult, onToolResult);

		if (execResult) {
			return {
				execResult,
				toolResult: finalToolResult ?? (await pair(...describeExecResult(execResult))),
			};
		}
		if (finalToolResult) {
			return { execResult: buildFromToolResult(finalToolResult), toolResult: finalToolResult };
		}
		const reason = "Tool returned no result";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { execResult: buildError(message), toolResult: await pair(message, true) };
	}
}

function describeExecResult(execResult: unknown): [text: string, isError: boolean] {
	const result = (execResult as { result?: { case?: string; value?: unknown } } | null)?.result;
	const variant = result?.case;
	if (variant === "success") {
		const success = result?.value as { isError?: boolean; content?: unknown[] } | undefined;
		if (!success?.isError) return ["Tool produced no transcript result", false];
		return [mcpContentToText(success.content) || "MCP tool reported an error", true];
	}
	if (!variant) return ["Tool produced no transcript result", false];
	const value = result?.value as { error?: string; reason?: string } | undefined;
	return [value?.error || value?.reason || `Tool call ${variant}`, true];
}

function mcpContentToText(content: unknown[] | undefined): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const inner = (item as { content?: { case?: string; value?: { text?: string } } } | null)?.content;
		if (inner?.case === "text" && inner.value?.text) parts.push(inner.value.text);
	}
	return parts.join("\n");
}

function splitExecHandlerResult<TResult>(result: CursorExecHandlerResult<TResult>): {
	execResult?: TResult;
	toolResult?: ToolResultMessage;
} {
	if (isToolResultMessage(result)) {
		return { toolResult: result };
	}
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		if ("execResult" in record) {
			const { execResult, toolResult } = record as {
				execResult: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("toolResult" in record && !isToolResultMessage(record)) {
			const { result: execResult, toolResult } = record as {
				result?: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("result" in record && !("$typeName" in record)) {
			const { result: execResult, toolResult } = record as {
				result: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
	}
	return { execResult: result as TResult };
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

async function applyToolResultHandler(
	toolResult: ToolResultMessage | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<ToolResultMessage | undefined> {
	if (!toolResult || !onToolResult) {
		return toolResult;
	}
	const updated = await onToolResult(toolResult);
	return updated ?? toolResult;
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function formatListedMcpResources(
	resources: { uri: string; name?: string; mimeType?: string; server?: string }[],
): string {
	if (resources.length === 0) return "No MCP resources available";
	const lines = resources.map(resource => {
		const qualifiers = [resource.name, resource.mimeType].filter(part => !!part).join(", ");
		const server = resource.server ? `[${resource.server}] ` : "";
		return qualifiers ? `- ${server}${resource.uri} (${qualifiers})` : `- ${server}${resource.uri}`;
	});
	return [`Listed ${resources.length} MCP resource(s):`, ...lines].join("\n");
}

function toolResultWasTruncated(toolResult: ToolResultMessage): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const truncation = (toolResult.details as { truncation?: { truncated?: boolean } }).truncation;
	return !!truncation?.truncated;
}

function toolResultDetailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const value = (toolResult.details as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : false;
}

function readTotalLinesFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object") return undefined;
	const direct = "totalLines" in details ? details.totalLines : undefined;
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	const meta = "meta" in details ? details.meta : undefined;
	if (!meta || typeof meta !== "object") return undefined;
	const truncation = "truncation" in meta ? meta.truncation : undefined;
	if (!truncation || typeof truncation !== "object") return undefined;
	const totalLines = "totalLines" in truncation ? truncation.totalLines : undefined;
	return typeof totalLines === "number" && Number.isFinite(totalLines) ? totalLines : undefined;
}

function readFileSizeFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object" || !("fileSize" in details)) return undefined;
	const { fileSize } = details;
	return typeof fileSize === "number" && Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : undefined;
}

function buildReadResultFromToolResult(path: string, toolResult: ToolResultMessage, rangeApplied = false) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildReadErrorResult(path, text || "Read failed");
	}

	const totalLines = readTotalLinesFromDetails(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\n").length : 0);
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? Buffer.byteLength(text, "utf-8")),
				truncated: toolResultWasTruncated(toolResult),
				output: { case: "content", value: text },

				rangeApplied,
			}),
		},
	});
}

function buildReadErrorResult(path: string, error: string) {
	return create(ReadResultSchema, {
		result: {
			case: "error",
			value: create(ReadErrorSchema, { path, error }),
		},
	});
}

function buildReadRejectedResult(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: {
			case: "rejected",
			value: create(ReadRejectedSchema, { path, reason }),
		},
	});
}

function buildWriteResultFromToolResult(
	args: { path: string; fileText?: string; fileBytes?: Uint8Array; returnFileContentAfterWrite?: boolean },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildWriteErrorResult(args.path, text || "Write failed");
	}
	const fileText = args.fileText ?? "";
	const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
	const linesCreated = fileText ? fileText.split("\n").length : 0;
	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: args.path,
				linesCreated,
				fileSize,
				fileContentAfterWrite: args.returnFileContentAfterWrite ? fileText : undefined,
			}),
		},
	});
}

function buildWriteErrorResult(path: string, error: string) {
	return create(WriteResultSchema, {
		result: {
			case: "error",
			value: create(WriteErrorSchema, { path, error }),
		},
	});
}

function buildWriteRejectedResult(path: string, reason: string) {
	return create(WriteResultSchema, {
		result: {
			case: "rejected",
			value: create(WriteRejectedSchema, { path, reason }),
		},
	});
}

function buildDeleteResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDeleteErrorResult(path, text || "Delete failed");
	}
	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path,
				deletedFile: path,
				fileSize: BigInt(0),
				prevContent: "",
			}),
		},
	});
}

function buildDeleteErrorResult(path: string, error: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "error",
			value: create(DeleteErrorSchema, { path, error }),
		},
	});
}

function buildDeleteRejectedResult(path: string, reason: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "rejected",
			value: create(DeleteRejectedSchema, { path, reason }),
		},
	});
}

function buildShellResultFromToolResult(
	args: { command: string; workingDirectory: string },
	toolResult: ToolResultMessage,
) {
	const output = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildShellFailureResult(args.command, args.workingDirectory, output || "Shell failed");
	}
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command: args.command,
				workingDirectory: args.workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: output,
				stderr: "",
				executionTime: 0,
			}),
		},
	});
}

function buildShellFailureResult(command: string, workingDirectory: string, error: string) {
	return create(ShellResultSchema, {
		result: {
			case: "failure",
			value: create(ShellFailureSchema, {
				command,
				workingDirectory,
				exitCode: 1,
				signal: "",
				stdout: "",
				stderr: error,
				executionTime: 0,
				aborted: false,
			}),
		},
	});
}

function buildShellRejectedResult(command: string, workingDirectory: string, reason: string) {
	return create(ShellResultSchema, {
		result: {
			case: "rejected",
			value: create(ShellRejectedSchema, {
				command,
				workingDirectory,
				reason,
				isReadonly: false,
			}),
		},
	});
}

function buildLsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildLsErrorResult(path, text || "Ls failed");
	}
	const rootPath = path || ".";
	const entries = text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("["));
	const childrenDirs: LsDirectoryTreeNode[] = [];
	const childrenFiles: LsDirectoryTreeNode_File[] = [];

	for (const entry of entries) {
		const name = entry.split(" (")[0];
		if (name.endsWith("/")) {
			const dirName = name.slice(0, -1);
			childrenDirs.push(
				create(LsDirectoryTreeNodeSchema, {
					absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
					childrenDirs: [],
					childrenFiles: [],
					childrenWereProcessed: false,
					fullSubtreeExtensionCounts: {},
					numFiles: 0,
				}),
			);
		} else {
			childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name }));
		}
	}

	const root = create(LsDirectoryTreeNodeSchema, {
		absPath: rootPath,
		childrenDirs,
		childrenFiles,
		childrenWereProcessed: true,
		fullSubtreeExtensionCounts: {},
		numFiles: childrenFiles.length,
	});

	return create(LsResultSchema, {
		result: {
			case: "success",
			value: create(LsSuccessSchema, { directoryTreeRoot: root }),
		},
	});
}

function buildLsErrorResult(path: string, error: string) {
	return create(LsResultSchema, {
		result: {
			case: "error",
			value: create(LsErrorSchema, { path, error }),
		},
	});
}

function buildLsRejectedResult(path: string, reason: string) {
	return create(LsResultSchema, {
		result: {
			case: "rejected",
			value: create(LsRejectedSchema, { path, reason }),
		},
	});
}

function buildGrepResultFromToolResult(
	args: { pattern: string; path?: string; outputMode?: string; offset?: number },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildGrepErrorResult(text || "Grep failed");
	}

	const outputMode = args.outputMode || "content";
	const clientTruncated = toolResultDetailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	const workspaceKey = args.path || ".";
	let unionResult: GrepUnionResult;

	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,

					offsetApplied: args.offset,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts = lines
			.map(line => {
				const separatorIndex = line.lastIndexOf(":");
				if (separatorIndex === -1) {
					return null;
				}
				const file = line.slice(0, separatorIndex);
				const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
				if (!file || Number.isNaN(count)) {
					return null;
				}
				return create(GrepFileCountSchema, { file, count });
			})
			.filter((entry): entry is GrepFileCount => entry !== null);
		const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else {
		const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;

		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) {
				continue;
			}
			const [, file, lineNumber, content] = match;
			const isContextLine = Boolean(contextLine);
			const list = matchMap.get(file) ?? [];
			list.push({ line: Number(lineNumber), content, isContextLine });
			matchMap.set(file, list);
			if (!isContextLine) {
				totalMatchedLines += 1;
			}
		}

		const matches = Array.from(matchMap.entries()).map(([file, matches]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: matches.map(entry =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines,
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	}

	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

function buildGrepErrorResult(error: string) {
	return create(GrepResultSchema, {
		result: {
			case: "error",
			value: create(GrepErrorSchema, { error }),
		},
	});
}

export function emptyGrepPatternRejection(pattern: string | undefined, glob: string | undefined): string | null {
	if (pattern && pattern.trim().length > 0) return null;
	if (glob && glob.length > 0) {
		return (
			`grep pattern is required (received an empty pattern). To list files matching "${glob}", ` +
			`pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.`
		);
	}
	return "grep pattern is required (received an empty pattern).";
}

function buildDiagnosticsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDiagnosticsErrorResult(path, text || "Diagnostics failed");
	}
	return create(DiagnosticsResultSchema, {
		result: {
			case: "success",
			value: create(DiagnosticsSuccessSchema, {
				path,
				diagnostics: [],
				totalDiagnostics: 0,
			}),
		},
	});
}

function buildDiagnosticsErrorResult(_path: string, error: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "error",
			value: create(DiagnosticsErrorSchema, { error }),
		},
	});
}

function buildDiagnosticsRejectedResult(path: string, reason: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "rejected",
			value: create(DiagnosticsRejectedSchema, { path, reason }),
		},
	});
}

function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const jsonValue = decodeJsonValue(value);
		if (typeof jsonValue === "string") {
			const first = jsonValue.trimStart()[0];
			return first === "{" || first === "[" || first === '"' ? parseToolArgsJson(jsonValue) : jsonValue;
		}
		return jsonValue;
	} catch {}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

function decodeMcpArgsMap(args?: Record<string, Uint8Array>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function decodeMcpCall(args: {
	name: string;
	args: Record<string, Uint8Array>;
	toolCallId: string;
	providerIdentifier: string;
	toolName: string;
	smartModeApprovalOnly?: boolean;
}): CursorMcpCall {
	const decodedArgs: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args.args ?? {})) {
		decodedArgs[key] = decodeMcpArgValue(value);
	}
	return {
		name: args.name,
		providerIdentifier: args.providerIdentifier,
		toolName: args.toolName || args.name,
		toolCallId: args.toolCallId,
		args: decodedArgs,
		rawArgs: args.args ?? {},
		approvalOnly: args.smartModeApprovalOnly === true,
	};
}

function mapTodoStatusValue(status?: number): CursorTodoSnapshotItem["status"] {
	switch (status) {
		case 2:
			return "in_progress";
		case 3:
			return "completed";
		case 4:
			return "abandoned";
		default:
			return "pending";
	}
}

interface CursorTodoItem {
	id?: string;
	content?: string;
	status?: number;

	dependencies?: string[];
}

interface CursorTodoResult {
	result?: {
		case?: "success" | "error";
		value?: { todos?: CursorTodoItem[]; totalCount?: number; wasMerge?: boolean; error?: string };
	};
}

interface CursorReadTodosArgs {
	statusFilter?: number[];
	idFilter?: string[];
}

interface CursorUpdateTodosCall {
	args?: { todos?: CursorTodoItem[]; merge?: boolean };
	result?: CursorTodoResult;
}

interface CursorReadTodosCall {
	args?: CursorReadTodosArgs;
	result?: CursorTodoResult;
}

interface CursorTodoToolCall {
	tool?: { case?: string; value?: unknown };
	updateTodosToolCall?: CursorUpdateTodosCall;
	readTodosToolCall?: CursorReadTodosCall;
}

function selectTodoCalls(toolCall: CursorTodoToolCall): {
	update?: CursorUpdateTodosCall;
	read?: CursorReadTodosCall;
} {
	const oneof = toolCall.tool;
	if (oneof?.case === "updateTodosToolCall") return { update: oneof.value as CursorUpdateTodosCall };
	if (oneof?.case === "readTodosToolCall") return { read: oneof.value as CursorReadTodosCall };
	return { update: toolCall.updateTodosToolCall, read: toolCall.readTodosToolCall };
}

function mapTodoSnapshot(todos: CursorTodoItem[]): CursorTodoSnapshotItem[] {
	return todos.map(todo => ({
		content: typeof todo.content === "string" ? todo.content : "",
		status: mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined),
	}));
}

interface CursorMcpToolCall {
	args?: {
		name?: string;
		toolName?: string;
		toolCallId?: string;
		args?: Record<string, Uint8Array>;
	};
}

interface CursorMcpToolCallCarrier {
	tool?: { case?: string; value?: unknown };
	mcpToolCall?: CursorMcpToolCall;
}

function selectMcpCall(toolCall: CursorMcpToolCallCarrier | undefined): CursorMcpToolCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "mcpToolCall") return oneof.value as CursorMcpToolCall;
	return toolCall?.mcpToolCall;
}

interface CursorEditToolCall {
	args?: {
		path?: string;
		streamContent?: string;
	};
	result?: {
		result?: {
			case?: string;
			value?: {
				error?: string;
				reason?: string;
				message?: string;
				path?: string;
				modelVisibleError?: string;
			};
		};
	};
}

interface CursorEditToolCallCarrier {
	tool?: { case?: string; value?: unknown };
	toolCallId?: string;
	editToolCall?: CursorEditToolCall;
}

function selectEditCall(toolCall: CursorEditToolCallCarrier | undefined): CursorEditToolCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "editToolCall") return oneof.value as CursorEditToolCall;
	return toolCall?.editToolCall;
}

function selectEditStreamDelta(update: {
	toolCallDelta?: {
		delta?: { case?: string; value?: { streamContentDelta?: string } };
		editToolCallDelta?: { streamContentDelta?: string };
	};
}): string | undefined {
	const oneof = update.toolCallDelta?.delta;
	if (oneof?.case === "editToolCallDelta") return oneof.value?.streamContentDelta;
	return update.toolCallDelta?.editToolCallDelta?.streamContentDelta;
}

function rememberEditOwnedToolCall(
	state: BlockState,
	toolCall: CursorEditToolCallCarrier | undefined,
	envelopeId?: string,
): void {
	if (!state.editOwnedToolCallIds) state.editOwnedToolCallIds = new Set();
	const ids = state.editOwnedToolCallIds;
	if (envelopeId) ids.add(envelopeId);
	if (toolCall?.toolCallId) ids.add(toolCall.toolCallId);
}

function isEditOwnedToolCallId(state: BlockState, output: AssistantMessage, toolCallId: string): boolean {
	if (state.editOwnedToolCallIds?.has(toolCallId)) return true;
	return output.content.some(block => block.type === "toolCall" && block.id === toolCallId && block.name === "edit");
}

function stringToolArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function markEditToolCallPaired(state: BlockState, toolCallId: string): void {
	if (!state.pairedEditToolCallIds) state.pairedEditToolCallIds = new Set();
	state.pairedEditToolCallIds.add(toolCallId);
}

function describeEditResult(toolCall: CursorEditToolCallCarrier | undefined): { text: string; isError: boolean } {
	const oneof = selectEditCall(toolCall)?.result?.result;
	const variant = oneof?.case;
	const value = oneof?.value;
	if (variant === "success") {
		return { text: value?.message || value?.path || "Edited", isError: false };
	}
	if (variant === "error") {
		return { text: value?.modelVisibleError || value?.error || "Edit failed", isError: true };
	}
	if (variant === "rejected") {
		return { text: value?.reason || "Edit rejected", isError: true };
	}
	if (variant === "fileNotFound") {
		return { text: value?.path ? `File not found: ${value.path}` : "File not found", isError: true };
	}
	if (variant === "readPermissionDenied") {
		return { text: value?.path ? `Read permission denied: ${value.path}` : "Read permission denied", isError: true };
	}
	if (variant === "writePermissionDenied") {
		return {
			text: value?.error || (value?.path ? `Write permission denied: ${value.path}` : "Write permission denied"),
			isError: true,
		};
	}
	return { text: "Edit reported no result", isError: true };
}

function remapExecHandlerToolName<TResult>(
	result: CursorExecHandlerResult<TResult>,
	toolName: string,
): CursorExecHandlerResult<TResult> {
	if (isToolResultMessage(result)) return { ...result, toolName };
	if (result && typeof result === "object" && "toolResult" in result) {
		const record = result as { result?: TResult; toolResult?: ToolResultMessage };
		if (record.toolResult && record.result !== undefined) {
			return { result: record.result, toolResult: { ...record.toolResult, toolName } };
		}
		if (record.toolResult) return { ...record.toolResult, toolName };
	}
	return result;
}

function openOrUpdateEditBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	toolCall: CursorEditToolCallCarrier | undefined,
	envelopeId?: string,
): ToolCallState | undefined {
	const edit = selectEditCall(toolCall);
	if (!edit && toolCall?.tool?.case !== "editToolCall") return undefined;
	rememberEditOwnedToolCall(state, toolCall, envelopeId);
	const id = toolCall?.toolCallId || envelopeId;
	if (!id) return undefined;

	const nextArgs = omitUndefinedArgs({
		path: edit?.args?.path,
		stream_content: edit?.args?.streamContent,
	});
	const existing = output.content.find(
		(block): block is ToolCallState => block.type === "toolCall" && block.id === id,
	);
	if (existing) {
		existing.arguments = { ...existing.arguments, ...nextArgs };
		return existing;
	}

	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);
	const block: ToolCallState = {
		type: "toolCall",
		id,
		name: "edit",
		arguments: nextArgs,
		[kStreamingBlockIndex]: output.content.length,
		[kStreamingBlockKind]: "cursor-edit",
		[kStreamingEnvelopeId]: envelopeId || undefined,
		[kCursorExecResolved]: true,
	};
	output.content.push(block);
	retainStreamedCall(state, block, envelopeId);
	stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
	return block;
}

const EXEC_OWNED_TOOL_CALL_CASES: ReadonlySet<string> = new Set([
	"piReadToolCall",
	"piBashToolCall",
	"piEditToolCall",
	"piWriteToolCall",
	"piGrepToolCall",
	"piFindToolCall",
	"piLsToolCall",
	"listMcpResourcesToolCall",
	"readMcpResourceToolCall",
]);

function isExecOwnedToolCall(toolCall: { tool?: { case?: string } } | undefined): boolean {
	const variant = toolCall?.tool?.case;
	return variant !== undefined && EXEC_OWNED_TOOL_CALL_CASES.has(variant);
}

export function flushOpenToolCalls(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const openBlocks = new Set<ToolCallState>(state.openToolCalls.values());
	if (state.currentToolCall) openBlocks.add(state.currentToolCall);
	for (const block of openBlocks) {
		const idx = output.content.indexOf(block);
		const partialJson = block[kStreamingPartialJson];
		if (partialJson !== undefined) {
			block.arguments = parseStreamingJson(partialJson);
			clearStreamingPartialJson(block);
		}
		const kind = block[kStreamingBlockKind];
		if (kind === "connect-scm" || kind === "todo" || kind === "cursor-edit") {
			if (!(kind === "cursor-edit" && state.pairedEditToolCallIds?.has(block.id))) {
				state.onToolResult?.({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: "The connection to Cursor closed before this call completed." }],
					isError: true,
					timestamp: Date.now(),
				});
			}
		}
		stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
	}
	state.openToolCalls.clear();
	state.setToolCall(null);
}

function retainStreamedCall(state: BlockState, block: ToolCallState, envelopeId: string | undefined): void {
	if (envelopeId) state.openToolCalls.set(envelopeId, block);
	state.setToolCall(block);
}

function resolveStreamedCall(state: BlockState, envelopeId: string | undefined): ToolCallState | null {
	if (!envelopeId) return state.currentToolCall;
	const keyed = state.openToolCalls.get(envelopeId);
	if (keyed) return keyed;

	const current = state.currentToolCall;
	return current && current[kStreamingEnvelopeId] === undefined ? current : null;
}

function releaseStreamedCall(state: BlockState, block: ToolCallState): void {
	const envelopeId = block[kStreamingEnvelopeId];
	if (envelopeId) state.openToolCalls.delete(envelopeId);
	if (state.currentToolCall === block) state.setToolCall(null);
}

interface CursorConnectScmRepository {
	owner?: string;
	repo?: string;
}

interface CursorConnectScmCall {
	args?: {
		toolCallId?: string;

		target?: { case?: string; value?: { repository?: CursorConnectScmRepository } };
		github?: { repository?: CursorConnectScmRepository };
	};

	result?: { result?: { case?: string; value?: { error?: string; reason?: string } } };
}

interface CursorConnectScmCarrier {
	tool?: { case?: string; value?: unknown };
	connectScmToolCall?: CursorConnectScmCall;
}

function selectConnectScmCall(toolCall: CursorConnectScmCarrier | undefined): CursorConnectScmCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "connectScmToolCall") return oneof.value as CursorConnectScmCall;
	return toolCall?.connectScmToolCall;
}

function selectConnectScmRepository(call: CursorConnectScmCall | undefined): CursorConnectScmRepository | undefined {
	const target = call?.args?.target;
	if (target?.case === "github") return target.value?.repository;
	return call?.args?.github?.repository;
}

function describeConnectScmResult(call: CursorConnectScmCall | undefined): { text: string; isError: boolean } {
	const result = call?.result?.result;
	switch (result?.case) {
		case "success":
			return { text: "SCM connected", isError: false };
		case "error":
			return { text: result.value?.error || "SCM connection failed", isError: true };
		case "rejected":
			return { text: result.value?.reason || "SCM connection rejected", isError: true };
		default:
			return { text: "SCM connection reported no result", isError: true };
	}
}

function extractTodoSnapshot(toolCall: CursorTodoToolCall): CursorTodoSnapshot | null {
	const { update, read } = selectTodoCalls(toolCall);
	if (read && ((read.args?.statusFilter?.length ?? 0) > 0 || (read.args?.idFilter?.length ?? 0) > 0)) {
		return null;
	}
	const call = update ?? read;
	if (!call) return null;
	const result = call.result?.result;
	if (result?.case !== "success") return null;
	const todos = result.value?.todos;
	if (!todos) return null;

	const totalCount = result.value?.totalCount;
	if (typeof totalCount === "number" && totalCount !== todos.length) {
		return null;
	}
	if (read && todos.length === 0) {
		return null;
	}
	const mapped = mapTodoSnapshot(todos);

	if (mapped.some(todo => todo.content.length === 0)) return null;

	const seen = new Set<string>();
	for (const todo of mapped) {
		if (seen.has(todo.content)) return null;
		seen.add(todo.content);
	}

	const finished = new Set<string>();
	for (const todo of todos) {
		const status = mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined);
		if (todo.id && (status === "completed" || status === "abandoned")) finished.add(todo.id);
	}
	for (const todo of todos) {
		for (const dependency of todo.dependencies ?? []) {
			if (!finished.has(dependency)) return null;
		}
	}
	return {
		todos: mapped,

		merged: result.value?.wasMerge === true,
	};
}

function extractTodoError(toolCall: CursorTodoToolCall): string | null {
	const { update, read } = selectTodoCalls(toolCall);
	const result = (update ?? read)?.result?.result;
	if (result?.case !== "error") return null;
	const error = result.value?.error;
	return typeof error === "string" && error.length > 0 ? error : "Todo operation failed";
}

function buildTodoDisplayArgs(toolCall: CursorTodoToolCall): { todos: CursorTodoSnapshotItem[]; merge?: boolean } {
	const args = selectTodoCalls(toolCall).update?.args;
	return {
		todos: args?.todos ? mapTodoSnapshot(args.todos) : [],
		merge: args?.merge === true ? true : undefined,
	};
}

function buildTodoToolResult(
	toolCallId: string,
	snapshot: CursorTodoSnapshot | null,
	error: string | null,
): ToolResultMessage {
	const text = error ?? (snapshot ? formatTodoSnapshotSummary(snapshot.todos) : "Todo snapshot not mirrored");
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [{ type: "text", text }],
		isError: error !== null,
		timestamp: Date.now(),
	};
}

function formatTodoSnapshotSummary(todos: CursorTodoSnapshotItem[]): string {
	if (todos.length === 0) return "No todos";
	const done = todos.filter(todo => todo.status === "completed").length;
	return `${done}/${todos.length} tasks completed`;
}

function buildMcpResultFromToolResult(_mcpCall: CursorMcpCall, toolResult: ToolResultMessage) {
	if (toolResult.isError) {
		return buildMcpErrorResult(toolResultToText(toolResult) || "MCP tool failed");
	}
	const content = toolResult.content.map(item => {
		if (item.type === "image") {
			return create(McpToolResultContentItemSchema, {
				content: {
					case: "image",
					value: create(McpImageContentSchema, {
						data: Uint8Array.from(Buffer.from(item.data, "base64")),
						mimeType: item.mimeType,
					}),
				},
			});
		}
		return create(McpToolResultContentItemSchema, {
			content: {
				case: "text",
				value: create(McpTextContentSchema, { text: item.text }),
			},
		});
	});

	return create(McpResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content,
				isError: false,
			}),
		},
	});
}

function buildMcpToolNotFoundResult(mcpCall: CursorMcpCall) {
	return create(McpResultSchema, {
		result: {
			case: "toolNotFound",
			value: create(McpToolNotFoundSchema, { name: mcpCall.toolName, availableTools: [] }),
		},
	});
}

function buildMcpErrorResult(error: string) {
	return create(McpResultSchema, {
		result: {
			case: "error",
			value: create(McpErrorSchema, { error }),
		},
	});
}

export function mergeCursorMcpToolCallArgs(
	streamed: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(streamed ?? {}) };
	if (!completion) return merged;
	for (const [key, completionValue] of Object.entries(completion)) {
		const streamedValue = merged[key];
		if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") {
			continue;
		}
		merged[key] = completionValue;
	}
	return merged;
}

function endCurrentTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	const block = state.currentTextBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: block.text,
		partial: output,
	});
	state.setTextBlock(null);
}

function endCurrentThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const block = state.currentThinkingBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: block.thinking,
		partial: output,
	});
	state.setThinkingBlock(null);
}

export function synthesizeCursorExecToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): void {
	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);

	const block: ToolCallState = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: omitUndefinedArgs(args),
		[kStreamingBlockIndex]: output.content.length,
		[kStreamingBlockKind]: "cursor-exec",
		[kCursorExecResolved]: true,
	};
	output.content.push(block);
	const idx = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
}

async function pairSynthesizedExecResult(
	state: BlockState,
	onToolResult: CursorToolResultHandler | undefined,
	toolCallId: string,
	toolName: string,
	text: string,
	isError = true,
): Promise<void> {
	const synthesized: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
	const sink = onToolResult ?? state.onToolResult;
	if (!sink) return;
	await sink(synthesized);
}

export function processInteractionUpdate(
	update: any,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
): void {
	const updateCase = update.message?.case;

	log("interactionUpdate", updateCase, update.message?.value);

	if (updateCase === "textDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { [kStreamingBlockIndex]: number } = {
				type: "text",
				text: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock!.text += delta;
		const idx = output.content.indexOf(state.currentTextBlock!);
		stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { [kStreamingBlockIndex]: number } = {
				type: "thinking",
				thinking: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock!.thinking += delta;
		const idx = output.content.indexOf(state.currentThinkingBlock!);
		stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingCompleted") {
		endCurrentThinkingBlock(output, stream, state);
	} else if (updateCase === "toolCallStarted" && selectConnectScmCall(update.message.value.toolCall)) {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const scmCall = selectConnectScmCall(update.message.value.toolCall);
		const repository = selectConnectScmRepository(scmCall);
		const block: ToolCallState = {
			type: "toolCall",
			id: scmCall?.args?.toolCallId || update.message.value.callId || crypto.randomUUID(),
			name: "connect_scm",
			arguments: repository ? { owner: repository.owner, repo: repository.repo } : {},
			[kStreamingBlockIndex]: output.content.length,
			[kStreamingBlockKind]: "connect-scm",
			[kStreamingEnvelopeId]: update.message.value.callId || undefined,
			[kCursorExecResolved]: true,
		};
		output.content.push(block);
		retainStreamedCall(state, block, update.message.value.callId);
		stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
	} else if (updateCase === "toolCallStarted" && isExecOwnedToolCall(update.message.value.toolCall)) {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		log("exec", "streamedToolCallOwnedByExec", { case: update.message.value.toolCall?.tool?.case });
	} else if (updateCase === "toolCallStarted") {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const toolCall = update.message.value.toolCall;
		if (toolCall) {
			const mcpCall = selectMcpCall(toolCall);
			if (mcpCall) {
				const args = mcpCall.args || {};
				const id = args.toolCallId || crypto.randomUUID();
				const resolvedByExec = state.resolvedMcpToolCallIds.delete(id);
				if (resolvedByExec && output.content.some(block => block.type === "toolCall" && block.id === id)) {
					return;
				}
				const block: ToolCallState = {
					type: "toolCall",
					id,

					name: args.toolName || args.name || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
				};
				if (resolvedByExec) {
					markCursorExecResolved(block);
				}
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			const todoCalls = selectTodoCalls(toolCall);
			if (todoCalls.update || todoCalls.read) {
				const callId = update.message.value.callId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: callId,
					name: "todo",
					arguments: buildTodoDisplayArgs(toolCall),
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingBlockKind]: "todo",

					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
					[kCursorExecResolved]: true,
				};
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			const fetchCall = selectHostedFetchCall(toolCall);
			if (fetchCall || hostedFetchUnknown(toolCall)) {
				const url = fetchCall?.args?.url || extractHttpUrlFromUnknown(toolCall);
				const callId = fetchCall?.args?.toolCallId || update.message.value.callId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: callId,
					name: "web_fetch",
					arguments: url ? { url } : {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingBlockKind]: "web-fetch",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
					[kCursorExecResolved]: true,
				};
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			openOrUpdateEditBlock(output, stream, state, toolCall, update.message.value.callId);
		}
	} else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
		const value = update.message.value;
		if (updateCase === "partialToolCall" && value.toolCall) {
			openOrUpdateEditBlock(output, stream, state, value.toolCall, value.callId);
		}
		const editDelta = selectEditStreamDelta(value);
		if (editDelta) {
			const target = resolveStreamedCall(state, value.callId);
			if (target?.[kStreamingBlockKind] === "cursor-edit") {
				const current = stringToolArg(target.arguments, "stream_content") ?? "";
				target.arguments = { ...target.arguments, stream_content: current + editDelta };
				const idx = output.content.indexOf(target);
				stream.push({ type: "toolcall_delta", contentIndex: idx, delta: editDelta, partial: output });
				return;
			}
		}

		const target = resolveStreamedCall(state, value.callId);
		if (target?.[kStreamingBlockKind] === "mcp") {
			const snapshot: string = update.message.value.argsTextDelta || "";
			const current = target[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			target[kStreamingPartialJson] = nextBuffer;

			const throttled = parseStreamingJsonThrottled(nextBuffer, target[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				target.arguments = throttled.value;
				target[kStreamingLastParseLen] = throttled.parsedLen;
			}
			const idx = output.content.indexOf(target);
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: output });
		}
	} else if (updateCase === "toolCallCompleted") {
		const settled = resolveStreamedCall(state, update.message.value.callId);
		if (settled) {
			const toolCall = update.message.value.toolCall;
			if (settled[kStreamingBlockKind] === "mcp") {
				const partial = settled[kStreamingPartialJson];
				if (partial !== undefined) {
					settled.arguments = parseStreamingJson(partial);
				}
				const decodedArgs = decodeMcpArgsMap(selectMcpCall(toolCall)?.args?.args);
				settled.arguments = mergeCursorMcpToolCallArgs(
					settled.arguments as Record<string, unknown> | undefined,
					decodedArgs,
				);
			} else if (settled[kStreamingBlockKind] === "connect-scm") {
				const scmCall = selectConnectScmCall(toolCall);
				const repository = selectConnectScmRepository(scmCall);
				if (repository) {
					settled.arguments = { owner: repository.owner, repo: repository.repo };
				}
				const { text, isError } = describeConnectScmResult(scmCall);
				state.onToolResult?.({
					role: "toolResult",
					toolCallId: settled.id,
					toolName: "connect_scm",
					content: [{ type: "text", text }],
					isError,
					timestamp: Date.now(),
				});
			} else if (settled[kStreamingBlockKind] === "web-fetch") {
				const fetchCall = selectHostedFetchCall(toolCall);
				const url = fetchCall?.args?.url || extractHttpUrlFromUnknown(toolCall ?? {});
				if (url) settled.arguments = { url };
				const { text, isError } = describeHostedFetchResult(fetchCall);
				state.onToolResult?.({
					role: "toolResult",
					toolCallId: settled.id,
					toolName: "web_fetch",
					content: [{ type: "text", text }],
					isError,
					timestamp: Date.now(),
				});
			} else if (settled[kStreamingBlockKind] === "todo") {
				const snapshot = toolCall ? extractTodoSnapshot(toolCall) : null;
				const error = toolCall ? extractTodoError(toolCall) : null;
				if (snapshot) {
					settled.arguments = { todos: snapshot.todos, merged: snapshot.merged };
				}

				let persisted: ToolResultMessage | undefined;
				let hostError: string | null = null;
				try {
					persisted = state.onTodoSnapshot?.(snapshot, settled.id, error) ?? undefined;
				} catch (callbackError) {
					hostError = callbackError instanceof Error ? callbackError.message : String(callbackError);
					log("error", "onTodoSnapshot", { error: hostError });
				}
				state.onToolResult?.(persisted ?? buildTodoToolResult(settled.id, snapshot, hostError ?? error));
			} else if (settled[kStreamingBlockKind] === "cursor-edit") {
				const edit = selectEditCall(toolCall);
				if (edit?.args) {
					settled.arguments = omitUndefinedArgs({
						...settled.arguments,
						path: edit.args.path ?? stringToolArg(settled.arguments, "path"),
						stream_content: edit.args.streamContent ?? stringToolArg(settled.arguments, "stream_content"),
					});
				}
				if (!state.pairedEditToolCallIds?.has(settled.id)) {
					const { text, isError } = describeEditResult(toolCall);
					state.onToolResult?.({
						role: "toolResult",
						toolCallId: settled.id,
						toolName: "edit",
						content: [{ type: "text", text }],
						isError,
						timestamp: Date.now(),
					});
				}
			}
			const idx = output.content.indexOf(settled);
			clearStreamingPartialJson(settled);
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: settled, partial: output });
			releaseStreamedCall(state, settled);
		}
	} else if (updateCase === "turnEnded") {
		output.stopReason = "stop";
		if (
			isKimiK3ModelId(output.model) &&
			!output.content.some(item => item.type === "thinking" && item.thinking.length > 0)
		) {
			logger.warn(
				"Cursor kimi-k3 turn completed without thinking blocks; persisted history will replay this turn without reasoning",
				{ model: output.model, messageTimestamp: output.timestamp },
			);
		}
	} else if (updateCase === "tokenDelta") {
		const tokenDelta = update.message.value;
		usageState.sawTokenDelta = true;
		output.usage.output += tokenDelta.tokens || 0;
		output.usage.totalTokens = output.usage.input + output.usage.output;
	}
}

function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	output: AssistantMessage,
	usageState: UsageState,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
	if (usageState.sawTokenDelta) {
		return;
	}
	const usedTokens = checkpoint.tokenDetails?.usedTokens ?? 0;
	if (usedTokens <= 0) {
		return;
	}
	if (output.usage.contextTokens !== usedTokens) {
		output.usage.contextTokens = usedTokens;
	}
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
	const blobId = createBlobId(data);
	blobStore.set(Buffer.from(blobId).toString("hex"), data);
	return blobId;
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
	const data = blobStore.get(Buffer.from(blobId).toString("hex"));
	if (!data) {
		throw new AIError.ValidationError("Cursor blob not found");
	}
	return data;
}

export function buildCursorRequestContextRules(systemPrompt: readonly string[] | undefined): CursorRule[] {
	return normalizeSystemPrompts(systemPrompt).map((content, index) =>
		create(CursorRuleSchema, {
			fullPath: `/proto/system-prompt/${index}.mdc`,
			content,
			source: CursorRuleSource.USER,
			type: create(CursorRuleTypeSchema, {
				type: {
					case: "global",
					value: create(CursorRuleTypeGlobalSchema, {}),
				},
			}),
		}),
	);
}

const CURSOR_NATIVE_TOOL_NAMES = new Set(["bash", "read", "write", "delete", "ls", "grep", "todo"]);

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	for (const key in value) {
		if (!isJsonValue(value[key])) return false;
	}
	return true;
}

export function buildMcpToolDefinitions(tools: Tool[] | undefined): McpToolDefinition[] {
	if (!tools || tools.length === 0) {
		return [];
	}

	const advertisedTools = tools.filter(tool => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name));
	if (advertisedTools.length === 0) {
		return [];
	}

	const writeTool = tools.find(tool => tool.name === "write");
	const forwarded = writeTool ? [...advertisedTools, writeTool] : advertisedTools;

	return forwarded.map(tool => {
		const jsonSchema = toolWireSchema(tool);
		const schemaValue: JsonValue =
			jsonSchema !== null && !Array.isArray(jsonSchema) && isJsonValue(jsonSchema)
				? jsonSchema
				: { type: "object", properties: {}, required: [] };
		const inputSchema = encodeJsonValue(schemaValue);
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-agent",
			toolName: tool.name,
			inputSchema,
		});
	});
}

function extractUserMessageText(msg: Message): string {
	if (msg.role !== "user" && msg.role !== "developer") return "";
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
	return text.trim();
}

function hasUserMessageImages(msg: Message): boolean {
	return (
		(msg.role === "user" || msg.role === "developer") &&
		Array.isArray(msg.content) &&
		msg.content.some(item => item.type === "image")
	);
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(
	content: string | (AudioContent | ImageContent | TextContent | VideoContent)[],
): CursorRootPromptContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	const parts: CursorRootPromptContentPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else if (item.type === "image") {
			parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
		} else {
			parts.push({ type: "text", text: mediaOmissionNote(item.type) });
		}
	}
	return parts;
}

function cursorUserContentKey(content: string | (AudioContent | ImageContent | TextContent | VideoContent)[]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const hash = createHash("sha256");
	for (const item of content) {
		hash.update(item.type);
		if (item.type === "text") {
			hash.update(item.text);
		} else {
			hash.update(item.mimeType);
			hash.update(item.data);
		}
	}
	return hash.digest("hex");
}

type CursorRootPromptAssistantContentPart =
	| { type: "text"; text: string }
	| {
			type: "reasoning";
			text: string;
			providerOptions: { cursor: { modelName: string } };
			signature?: string;
	  }
	| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> };

function canReplayCursorThinking(msg: AssistantMessage, targetModelId: string | undefined): boolean {
	return (
		targetModelId !== undefined &&
		isKimiK3ModelId(targetModelId) &&
		msg.api === "cursor-agent" &&
		msg.provider === "cursor" &&
		msg.model === targetModelId
	);
}

function buildCursorAssistantContent(
	msg: AssistantMessage,
	targetModelId: string | undefined,
): CursorRootPromptAssistantContentPart[] {
	const content: CursorRootPromptAssistantContentPart[] = [];
	const replayThinking = canReplayCursorThinking(msg, targetModelId);
	for (const item of msg.content) {
		if (item.type === "text") {
			if (item.text) content.push({ type: "text", text: item.text });
		} else if (item.type === "thinking") {
			if (replayThinking && item.thinking) {
				content.push({
					type: "reasoning",
					text: item.thinking,
					providerOptions: { cursor: { modelName: msg.model } },
					...(item.thinkingSignature ? { signature: item.thinkingSignature } : {}),
				});
			}
		} else if (item.type === "toolCall") {
			content.push({
				type: "tool-call",
				toolCallId: item.id,
				toolName: item.name,
				args: normalizeCursorMcpArguments(item.arguments),
			});
		}
	}
	return content;
}

function assertCursorKimiK3HistoryReplayable(
	messages: Message[],
	activeUserMessageIndex: number,
	targetModelId: string | undefined,
): void {
	if (!targetModelId || !isKimiK3ModelId(targetModelId)) return;
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const missingThinkingTurns: number[] = [];
	const newlyWarnedKeys: string[] = [];
	let assistantTurn = 0;
	for (let i = 0; i < historyEnd; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		assistantTurn++;
		const isSameCursorModel = msg.api === "cursor-agent" && msg.provider === "cursor" && msg.model === targetModelId;
		if (!isSameCursorModel) {
			throw new AIError.ValidationError(
				`Cursor ${targetModelId} cannot continue history from a different model (${msg.provider}/${msg.model}); start a new session.`,
			);
		}
		const hasThinking = msg.content.some(item => item.type === "thinking" && item.thinking.length > 0);
		if (hasThinking) continue;
		const warningKey = `${msg.api}\0${msg.provider}\0${msg.model}\0${msg.timestamp}`;
		if (warnedCursorKimiK3ReplayMessages.has(warningKey)) continue;
		missingThinkingTurns.push(assistantTurn);
		newlyWarnedKeys.push(warningKey);
	}
	if (missingThinkingTurns.length === 0) return;
	for (const key of newlyWarnedKeys) warnedCursorKimiK3ReplayMessages.add(key);
	logger.warn(
		`Cursor kimi-k3 history contains same-model assistant turn(s) ${missingThinkingTurns.join(", ")} without thinking blocks; replaying those spans without reasoning may make generation less stable`,
		{ model: targetModelId, assistantTurns: missingThinkingTurns },
	);
}

function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user" || role === "developer") {
			return i;
		}
	}
	return -1;
}

export function buildCursorSystemPromptJsons(systemPrompt: readonly string[] | undefined): string[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return systemPrompts.map(content => JSON.stringify({ role: "system", content }));
}

function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	assertCursorKimiK3HistoryReplayable(messages, activeUserMessageIndex, targetModelId);
	const entries: Uint8Array[] = [...systemPromptIds];
	const pushJson = (obj: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		entries.push(storeCursorBlob(blobStore, bytes));
	};

	for (let i = 0; i < messages.length; i++) {
		if (i === activeUserMessageIndex) break;
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "developer") {
			const content = buildCursorRootPromptContent(msg.content);
			if (content.length === 0) continue;
			pushJson({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content = buildCursorAssistantContent(msg, targetModelId);
			if (content.length === 0) continue;
			pushJson({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			pushJson({
				role: "tool",
				id: msg.toolCallId,
				content: [
					{
						type: "tool-result",
						toolName: msg.toolName,
						toolCallId: msg.toolCallId,
						result: toolResultToText(msg),
						...(msg.isError ? { isError: true } : {}),
					},
				],
			});
		}
	}

	return entries;
}

function normalizeCursorMcpArgument(value: unknown, seen: Set<object>): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map(item => normalizeCursorMcpArgument(item, seen) ?? null);
		}
		if (!isRecord(value)) return undefined;
		const normalized: Record<string, JsonValue> = Object.create(null);
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const normalizedItem = normalizeCursorMcpArgument(value[key], seen);
			if (normalizedItem !== undefined) normalized[key] = normalizedItem;
		}
		return normalized;
	} finally {
		seen.delete(value);
	}
}

function normalizeCursorMcpArguments(args: Record<string, unknown>): Record<string, JsonValue> {
	const normalized: Record<string, JsonValue> = Object.create(null);
	const seen = new Set<object>();
	for (const name in args) {
		if (!Object.hasOwn(args, name)) continue;
		const normalizedValue = normalizeCursorMcpArgument(args[name], seen);
		if (normalizedValue !== undefined) normalized[name] = normalizedValue;
	}
	return normalized;
}

function encodeCursorMcpArguments(toolCall: ToolCall): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = Object.create(null);
	const normalized = normalizeCursorMcpArguments(toolCall.arguments);
	for (const name in normalized) {
		encoded[name] = encodeJsonValue(normalized[name]);
	}
	return encoded;
}

function createCursorMcpResult(result: ToolResultMessage) {
	if (result.isError) {
		return create(McpToolResultSchema, {
			result: {
				case: "error",
				value: create(McpToolErrorSchema, { error: toolResultToText(result) }),
			},
		});
	}
	return create(McpToolResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content: result.content.map(item =>
					item.type === "text"
						? create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
							})
						: create(McpToolResultContentItemSchema, {
								content: {
									case: "image",
									value: create(McpImageContentSchema, {
										data: Uint8Array.from(Buffer.from(item.data, "base64")),
										mimeType: item.mimeType,
									}),
								},
							}),
				),
			}),
		},
	});
}

function createCursorToolCallStep(toolCall: ToolCall, result: ToolResultMessage | undefined) {
	const mcpCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: toolCall.name,
			args: encodeCursorMcpArguments(toolCall),
			toolCallId: toolCall.id,
			providerIdentifier: "pi-agent",
			toolName: toolCall.name,
		}),
		...(result ? { result: createCursorMcpResult(result) } : {}),
	});
	return create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: mcpCall },
				toolCallId: toolCall.id,
			}),
		},
	});
}

function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	const turns: Uint8Array[] = [];
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const toolResults = new Map<string, ToolResultMessage>();
	const pairedToolCallIds = new Set<string>();
	for (let index = 0; index < historyEnd; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			toolResults.set(message.toolCallId, message);
		} else if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "toolCall") pairedToolCallIds.add(item.id);
			}
		}
	}

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "developer") {
			i++;
			continue;
		}
		if (i === activeUserMessageIndex) break;

		const userText = extractUserMessageText(msg);
		if (userText.length === 0 && !hasUserMessageImages(msg)) {
			i++;
			continue;
		}

		const userMessage = createCursorUserMessage(
			msg.content,
			userText,
			deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
		);
		const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
		const stepBlobIds: Uint8Array[] = [];
		i++;

		while (i < messages.length && messages[i].role !== "user" && messages[i].role !== "developer") {
			const stepMsg = messages[i];
			if (stepMsg.role === "assistant") {
				for (const item of stepMsg.content) {
					let step: ConversationStep;
					if (item.type === "text") {
						if (!item.text) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "assistantMessage",
								value: create(AssistantMessageSchema, { text: item.text }),
							},
						});
					} else if (item.type === "thinking") {
						if (!item.thinking || !canReplayCursorThinking(stepMsg, targetModelId)) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "thinkingMessage",
								value: create(ThinkingMessageSchema, { text: item.thinking }),
							},
						});
					} else if (item.type === "toolCall") {
						step = createCursorToolCallStep(item, toolResults.get(item.id));
					} else {
						continue;
					}
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			} else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
				const text = toolResultToText(stepMsg);
				if (text) {
					const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			}
			i++;
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
	}

	return turns;
}

export function buildCursorHistoryForTest(
	messages: Message[],
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): {
	rootPromptMessagesJson: unknown[];
	turnUserMessagesJson: JsonValue[];
	turnStepMessagesJson: JsonValue[][];
} {
	const blobStore = new Map<string, Uint8Array>();
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		messages,
		[],
		blobStore,
		activeUserMessageIndex,
		targetModelId,
	).map(blobId => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))));
	const turnUserMessagesJson: JsonValue[] = [];
	const turnStepMessagesJson: JsonValue[][] = [];
	for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex, targetModelId)) {
		const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
		if (turn.turn.case !== "agentConversationTurn") {
			continue;
		}
		const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
		turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
		turnStepMessagesJson.push(
			turn.turn.value.steps.map(stepBlobId => {
				const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
				return toJson(ConversationStepSchema, step);
			}),
		);
	}
	return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}
function createCursorUserMessage(
	content: string | (AudioContent | ImageContent | TextContent | VideoContent)[],
	text: string,
	messageId = crypto.randomUUID(),
) {
	const images = typeof content === "string" ? [] : extractImages(content);
	return create(UserMessageSchema, {
		text,
		messageId,
		...(images.length > 0
			? {
					selectedContext: create(SelectedContextSchema, {
						selectedImages: images,
					}),
				}
			: {}),
	});
}

function extractImages(content: readonly (AudioContent | ImageContent | TextContent | VideoContent)[]) {
	return content
		.filter((item): item is ImageContent => item.type === "image")
		.map(image =>
			create(SelectedImageSchema, {
				uuid: crypto.randomUUID(),
				mimeType: image.mimeType,
				dataOrBlobId: {
					case: "data",
					value: Uint8Array.from(Buffer.from(image.data, "base64")),
				},
			}),
		);
}

function resolveCursorWireModel(
	model: Model<"cursor-agent">,
	requestModelId: string | undefined,
	wireMode: CursorWireMode = "normalized",
): {
	modelId: string;
	parameters: RequestedModel_ModelParameterbytes[];
} {
	const wireModelId = requestModelId ?? model.requestModelId ?? model.id;
	if (wireMode === "discovered") return { modelId: wireModelId, parameters: [] };

	const match = /^(.*)-(minimal|low|medium|high|xhigh|max)(-fast)?$/.exec(wireModelId);
	const base = match?.[1];
	const effort = match?.[2];
	if (base && effort && (THINKING_EFFORTS as readonly string[]).includes(effort) && parseOpenAIModel(base) !== null) {
		return {
			modelId: `${base}${match[3] ?? ""}`,
			parameters: [create(RequestedModel_ModelParameterbytesSchema, { id: "reasoning", value: effort })],
		};
	}
	return { modelId: wireModelId, parameters: [] };
}

async function buildGrpcRequestForWireMode(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorOptions | undefined,
	state: CursorRequestState,
	wireMode: CursorWireMode,
): Promise<CursorTransportRequest> {
	const blobStore = state.blobStore;

	const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map(json =>
		storeCursorBlob(blobStore, new TextEncoder().encode(json)),
	);

	const activeUserMessageIndex = context.messages.length - 1;
	const activeMessage = context.messages[activeUserMessageIndex];
	const activeUserMessage =
		activeMessage?.role === "user" || activeMessage?.role === "developer" ? activeMessage : undefined;
	let userContent: string | (AudioContent | ImageContent | TextContent | VideoContent)[] | undefined;
	let userText = "";
	let hasUserImages = false;
	if (activeUserMessage?.role === "user" || activeUserMessage?.role === "developer") {
		userContent = activeUserMessage.content;
		if (typeof userContent === "string") {
			userText = userContent.trim();
		} else {
			userText = extractText(userContent);
			hasUserImages = hasImages(userContent);
		}
	}

	const action = create(ConversationActionSchema, {
		action:
			userContent && (userText.trim().length > 0 || hasUserImages)
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: createCursorUserMessage(userContent, userText),
						}),
					}
				: {
						case: "resumeAction",
						value: create(ResumeActionSchema, {}),
					},
	});

	const turns = buildConversationTurns(
		context.messages,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
	const hasMatchingPrompt =
		cachedPromptHead.length === systemPromptIds.length &&
		systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]).equals(id));
	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: systemPromptIds,
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

	const { modelId: wireModelId, parameters: wireParameters } = resolveCursorWireModel(
		model,
		options?.wireModelId,
		wireMode,
	);
	const cursorMaxMode = model.cursorMaxMode === true;
	const modelDetails = create(ModelDetailsSchema, {
		modelId: wireModelId,
		displayModelId: model.id,
		displayName: model.name,
		...(cursorMaxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: wireModelId,
		maxMode: cursorMaxMode,
		parameters: wireParameters,
	});

	let runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: state.conversationId,
	});

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	const replacementRequest = await options?.onPayload?.(runRequest, model);
	if (replacementRequest !== undefined) runRequest = replacementRequest as typeof runRequest;

	const discoveredWireModelId = options?.wireModelId ?? model.requestModelId ?? model.id;
	const serializedParameters = runRequest.requestedModel?.parameters;
	const normalizedEffortPayloadSerialized =
		wireMode === "normalized" &&
		wireParameters.length > 0 &&
		wireModelId !== discoveredWireModelId &&
		runRequest.requestedModel?.modelId === wireModelId &&
		runRequest.modelDetails?.modelId === wireModelId &&
		serializedParameters?.length === wireParameters.length &&
		serializedParameters.every((parameter, index) => {
			const expected = wireParameters[index];
			return expected !== undefined && parameter.id === expected.id && parameter.value === expected.value;
		});
	const fallbackWireModelId = normalizedEffortPayloadSerialized ? discoveredWireModelId : undefined;

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

	const toolNames = context.tools?.map(tool => tool.name) ?? [];
	const detail =
		$env.DEBUG_CURSOR === "2"
			? ` ${JSON.stringify(clientMessage.message.value, debugReplacer, 2)?.slice(0, 2000)}`
			: "";
	log("info", "builtRunRequest", {
		bytes: requestBytes.length,
		tools: toolNames.length,
		toolNames: toolNames.slice(0, 20),
		detail: detail || undefined,
	});

	return { requestBytes, blobStore, conversationState, fallbackWireModelId };
}

export async function buildGrpcRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorOptions | undefined,
	state: CursorRequestState,
): Promise<CursorGrpcRequest> {
	return buildGrpcRequestForWireMode(model, context, options, state, "normalized");
}

function hasImages(content: readonly (AudioContent | ImageContent | TextContent | VideoContent)[]): boolean {
	return content.some(item => item.type === "image");
}
function extractText(content: readonly (AudioContent | ImageContent | TextContent | VideoContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
