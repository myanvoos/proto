import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	atomicWriteJson,
	getAgentDir,
	getBlobsDir,
	isEnoent,
	isRecord,
	logger,
	type postmortem,
	VERSION,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type CreateElicitationResponse,
	conciseErrorReason,
	type ElicitationContentValue,
	type ElicitationPropertySchema,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type Usage,
} from "@oh-my-pi/pi-utils/acp";
import { disableProvider, enableProvider, reset as resetCapabilities } from "../../capability";
import { Settings } from "../../config/settings";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { PYTHON_KERNEL_CANCEL_BUDGET_MS } from "../../eval/py/kernel";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";
import { theme } from "../../modes/theme/theme";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import type { UsageStatistics } from "../../session/session-entries";
import type { SessionInfo as StoredSessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands, toAcpAvailableCommands } from "../../slash-commands/available-commands";
import { refreshAgentDiscovery } from "../../task";
import { parseThinkingLevel } from "../../thinking";
import { OTHER_OPTION } from "../../tools/ask";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { createAcpClientBridge } from "./acp-client-bridge";
import {
	extractAssistantMessageText,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const AGENT_AUTH_METHOD_ID = "agent";
const TERMINAL_AUTH_METHOD_ID = "terminal";
/** `data.reason` of every error caused by provider credentials: missing, or rejected by the provider. */
const PROVIDER_AUTH_REASON = "provider_auth";
/** `agentCapabilities._meta` key advertising `_session/steering`, in proto's `_proto/*` extension namespace. */
const STEERING_CAPABILITY_META_KEY = "proto/steering";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const THINKING_OFF = "off";
const SESSION_PAGE_SIZE = 50;

export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const ACP_CANCEL_CLEANUP_TIMEOUT_MS = PYTHON_KERNEL_CANCEL_BUDGET_MS + 1_000;
const ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS = 250;
const ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES = 3;
/** Interrupts a prompt tries against runs that keep claiming the session before it gives up explicitly. */
const ACP_DISPATCH_ATTEMPTS = 3;

const ACP_SESSION_HANDLES_FILE = "acp-session-handles.json";

async function readAcpSessionHandles(): Promise<Record<string, string>> {
	try {
		const value: unknown = await Bun.file(path.join(getAgentDir(), ACP_SESSION_HANDLES_FILE)).json();
		if (isRecord(value))
			return Object.fromEntries(
				Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Ignoring unreadable ACP session handle map", { error: String(error) });
	}
	return {};
}

type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

type PromptQueueState = {
	promise: Promise<void>;
	release: (() => void) | undefined;
};
type PromptDispatchCancellation = { cancelled: boolean };
type PromptLifecycleError = Error & { readonly code: "ACP_SESSION_CLOSED" };
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

type PromptTurnState = {
	abortController: AbortController;
	cancelRequested: boolean;
	/** session/prompt has been answered. */
	settled: boolean;
	/** The answer is being prepared: the turn forwards no further events. */
	closing: boolean;
	awaitingSteerResubmissions?: string[];
	/** A run that claimed the session before this turn's dispatch is being stopped; its events are not this turn's. */
	interrupting: boolean;
	/** Newest agent_end of the turn. Recovery and continuations supersede earlier ones; the last decides the answer. */
	lastAgentEnd: AgentEndEvent | undefined;
	/** Tool calls the client was shown that have not reached completed/failed. */
	openToolCalls: Set<string>;
	/** Resolves once a cancelled turn has been answered. */
	cancelling: Promise<void> | undefined;
	/** The session's abort of this turn. It can outlive the answer when it overruns the cancel budget. */
	cleanup: Promise<void> | undefined;
	usageBaseline: UsageStatistics;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<PromptResponse>;
};

function isPromptTurnInFlight(turn: PromptTurnState | undefined): turn is PromptTurnState {
	return turn !== undefined && (!turn.settled || turn.cleanup !== undefined);
}

const SESSION_STEERING_METHOD = "_session/steering";

function toSteeringPromptBlocks(prompt: unknown): PromptRequest["prompt"] {
	if (typeof prompt === "string") {
		return [{ type: "text", text: prompt }];
	}
	if (!Array.isArray(prompt)) {
		throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt must be content blocks");
	}
	for (const block of prompt) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt blocks must be objects");
		}
		const record = block as Record<string, unknown>;
		if (typeof record.type !== "string") {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt block requires a string type");
		}
		// Own-key lookup: inherited names (`constructor`, `toString`, …) would
		// index inherited prototype values, and the `for…of` below would then
		// throw a TypeError that surfaces as a generic -32603 internal error.
		if (!Object.hasOwn(STEERING_BLOCK_STRING_FIELDS, record.type)) {
			throw RequestError.invalidParams(
				{ method: SESSION_STEERING_METHOD },
				`unsupported prompt block type: ${record.type}`,
			);
		}
		const required = STEERING_BLOCK_STRING_FIELDS[record.type];
		for (const field of required) {
			if (typeof record[field] !== "string") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					`prompt block ${record.type} requires string ${field}`,
				);
			}
		}
		if (record.type === "resource") {
			const resource = record.resource;
			if (
				typeof resource !== "object" ||
				resource === null ||
				typeof (resource as Record<string, unknown>).uri !== "string"
			) {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block requires a resource object with a string uri",
				);
			}
			const resourceFields = resource as Record<string, unknown>;
			if (Object.hasOwn(resourceFields, "mimeType") && typeof resourceFields.mimeType !== "string") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block mimeType must be a string when present",
				);
			}
			// `#convertPromptBlocks` selects the text arm whenever the key
			// exists and the image arm only for a string blob: require the
			// arm that would be selected to be a string, so a mixed shape
			// (e.g. a string blob plus a non-string text) cannot pass here
			// and then silently replace the image with the raw field value
			// in model input. A resource with neither arm keeps the same
			// rejection as before.
			if (Object.hasOwn(resourceFields, "text")) {
				if (typeof resourceFields.text !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						"resource block with a text arm requires string text",
					);
				}
			} else if (Object.hasOwn(resourceFields, "blob")) {
				if (typeof resourceFields.blob !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						"resource block with a blob arm requires string blob",
					);
				}
			} else {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block requires string text or string blob",
				);
			}
		}
		if (record.type === "resource_link") {
			if (record.size !== undefined && record.size !== null && typeof record.size !== "number") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource_link size must be a number or null when present",
				);
			}
			for (const field of ["title", "name", "mimeType", "description"] as const) {
				if (record[field] !== undefined && typeof record[field] !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						`resource_link ${field} must be a string when present`,
					);
				}
			}
		}
	}
	return prompt as PromptRequest["prompt"];
}

/** Required top-level string fields per accepted prompt block type. */
const STEERING_BLOCK_STRING_FIELDS: Record<string, string[]> = {
	text: ["text"],
	image: ["data", "mimeType"],
	audio: ["data", "mimeType"],
	resource_link: ["uri"],
	resource: [],
};

/**
 * `_meta.steering.queue` of a `_session/steering` request — the omp-specific
 * opt-in routing the message to the native follow-up queue instead of the
 * steering queue. Everything else (including `idleBehavior`) is unused: idle
 * sessions always answer `promptRequired`, so the host keeps owning the turn.
 */
function steeringQueueFromMeta(meta: unknown): "steering" | "followUp" {
	if (typeof meta === "object" && meta !== null) {
		const steering = (meta as Record<string, unknown>).steering;
		if (typeof steering === "object" && steering !== null) {
			return (steering as Record<string, unknown>).queue === "followUp" ? "followUp" : "steering";
		}
	}
	return "steering";
}

type AcpCompactionNotification = {
	method: "_proto/compaction/start" | "_proto/compaction/end";
	params: Record<string, unknown>;
};

type ManagedSessionRecord = {
	/** ACP identity does not change when an extension replaces the conversation. */
	readonly protocolSessionId: string;
	session: AgentSession;
	setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined;
	mcpManager: MCPManager | undefined;

	mcpRefreshChain: Promise<void> | undefined;
	// MCP startup failures recorded during session setup, before the
	// newSession/loadSession response has told the client the session id.
	// Drained by `#emitBootstrapUpdates` behind the bootstrap race guard so
	// clients (Zed) cannot drop them as notifications for an unknown session.
	pendingMcpStartupChunks: Array<{ name: string; message: string }>;
	promptTurn: PromptTurnState | undefined;
	promptQueue: PromptQueueState;
	pendingPromptDispatches: PromptDispatchCancellation[];
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
	extensionsConfigured: boolean;

	lifetimeUnsubscribe: (() => void) | undefined;
	lifetimeUpdatesReady: boolean;
	pendingCompactionNotifications: AcpCompactionNotification[];
	lifetimeDeliveries: Set<Promise<void>>;
	closedError: PromptLifecycleError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
};

type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};

/**
 * The local path a `file:` prompt resource names, or `undefined` for any other scheme. A query or
 * fragment the client added (Zed's `?symbol=` and `#L10:20` for a symbol or selection) stays on the
 * path: dropping it would present an excerpt as the whole file.
 */
function promptResourceFilePath(uri: string): string | undefined {
	const parsed = URL.parse(uri);
	if (parsed?.protocol !== "file:") return undefined;
	const suffix = `${parsed.search}${parsed.hash}`;
	parsed.search = "";
	parsed.hash = "";
	try {
		return `${Bun.fileURLToPath(parsed)}${suffix}`;
	} catch {
		// A `file:` URI naming a remote host has no local path; the caller keeps the URI.
		return undefined;
	}
}

/**
 * A `resource_link` as the model reads it: the client's title or name, linked to the absolute path
 * (for `file:` URIs) or the URI, so the model can open what the user pointed at.
 */
function formatPromptResourceLink(link: Extract<PromptRequest["prompt"][number], { type: "resource_link" }>): string {
	const location = promptResourceFilePath(link.uri) ?? link.uri;
	const label = link.title || link.name;
	if (!label || label === location) return location;
	return `[${label}](${/[\s()<>]/.test(location) ? `<${location}>` : location})`;
}

type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};

type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};

type MCPSourceMap = {
	[name: string]: MCPSource;
};

type AcpSessionHandle = {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
};

type CreateAcpSession = (
	cwd: string,
	options?: { interactivePrompts?: boolean },
) => Promise<AgentSession | AcpSessionHandle>;

function normalizeCreatedAcpSession(created: AgentSession | AcpSessionHandle): {
	session: AgentSession;
	setToolUIContext: AcpSessionHandle["setToolUIContext"] | undefined;
} {
	return "session" in created ? created : { session: created, setToolUIContext: undefined };
}

async function elicitFormFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: string,
	message: string,
	properties: Record<string, ElicitationPropertySchema>,
	required: string[] | undefined,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<Record<string, ElicitationContentValue> | undefined> {
	const signal = dialogOptions?.signal;
	if (signal?.aborted) {
		return undefined;
	}
	const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const finish = (value: CreateElicitationResponse | undefined) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	// An abandoned form must not stay open in the client: withdraw it with `$/cancel_request`.
	const request = new AbortController();
	const abandon = () => {
		if (settled) return;
		finish(undefined);
		request.abort();
	};
	const onAbort = () => abandon();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (dialogOptions?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			if (settled) return;
			try {
				dialogOptions.onTimeout?.();
			} catch (error) {
				logger.warn("ACP elicitation onTimeout threw", { acpSessionId: sessionId, method, error });
			}
			abandon();
		}, dialogOptions.timeout);

		timeoutId.unref();
	}
	connection
		.unstable_createElicitation(
			{
				mode: "form",
				sessionId,
				message,
				requestedSchema: {
					type: "object",
					properties,
					required,
				},
			},
			{ signal: request.signal },
		)
		.then(finish, error => {
			if (settled) return;
			logger.warn("ACP elicitation failed", { acpSessionId: sessionId, method, error });
			finish(undefined);
		});
	const response = await promise;
	if (!isAcceptedElicitation(response) || !response.content) {
		return undefined;
	}
	return response.content;
}

async function elicitFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: "select" | "confirm" | "input" | "editor",
	message: string,
	property: ElicitationPropertySchema,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<ElicitationContentValue | undefined> {
	const content = await elicitFormFromAcpClient(
		connection,
		sessionId,
		method,
		message,
		{ value: property },
		["value"],
		dialogOptions,
	);
	return content?.value;
}

function isAcceptedElicitation(
	response: CreateElicitationResponse | undefined,
): response is Extract<CreateElicitationResponse, { action: "accept" }> {
	return response?.action === "accept";
}

export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	clientCapabilities: ClientCapabilities | undefined,
): ExtensionUIContext {
	const supportsForm = clientCapabilities?.elicitation?.form != null;
	return {
		select: async (title, options, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"select",
				title,
				{ type: "string", enum: options.map(getExtensionUISelectOptionLabel) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		confirm: async (title, message, dialogOptions) => {
			if (!supportsForm) return false;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"confirm",
				message.trim().length > 0 ? `${title}\n\n${message}` : title,
				{ type: "boolean" },
				dialogOptions,
			);
			return typeof value === "boolean" ? value : false;
		},
		input: async (title, placeholder, dialogOptions) => {
			if (!supportsForm || dialogOptions?.secret) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"input",
				title,

				{ type: "string", ...(placeholder?.trim() ? { description: placeholder } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		askDialog: async (questions, dialogOptions) => {
			if (!supportsForm) return undefined;
			const properties: Record<string, ElicitationPropertySchema> = {};
			for (const [index, question] of questions.entries()) {
				const key = `q${index}`;
				const entries = question.options.map(option => ({
					const: option.label,
					title: option.label,
					...(option.description?.trim() ? { description: option.description.trim() } : {}),
				}));
				const description = question.header?.trim();
				if (entries.length > 0) {
					if (question.multi === true) {
						properties[key] = {
							type: "array",
							title: question.question,
							...(description ? { description } : {}),
							items: { anyOf: entries },
						};
					} else {
						const recommended = question.recommended;
						properties[key] = {
							type: "string",
							title: question.question,
							...(description ? { description } : {}),
							oneOf: entries,
							...(recommended !== undefined && recommended >= 0 && recommended < question.options.length
								? { default: question.options[recommended].label }
								: {}),
						};
					}
				}
				properties[`${key}__other`] = { type: "string", title: OTHER_OPTION };
			}

			let timedOut = false;
			const content = await elicitFormFromAcpClient(
				connection,
				getSessionId(),
				"askDialog",
				questions.length === 1 ? questions[0].question : `Answer ${questions.length} questions`,
				properties,
				undefined,
				{
					...dialogOptions,
					onTimeout: () => {
						timedOut = true;
						dialogOptions?.onTimeout?.();
					},
				},
			);
			if (timedOut) {
				return {
					kind: "timeout",
					results: questions.map(question => ({
						id: question.id,
						question: question.question,
						options: question.options.map(option => option.label),
						multi: question.multi ?? false,
						selectedOptions: [],
						timedOut: true,
					})),
				};
			}
			if (!content) return undefined;

			return {
				kind: "submit",
				results: questions.map((question, index) => {
					const key = `q${index}`;
					const otherKey = `${key}__other`;
					const labels = question.options.map(option => option.label);
					const otherValue = content[otherKey];
					const customInput = typeof otherValue === "string" && otherValue.trim() ? otherValue.trim() : undefined;
					const value = content[key];
					const selectedOptions =
						question.multi === true
							? Array.isArray(value)
								? value.filter(candidate => typeof candidate === "string" && labels.includes(candidate))
								: []
							: customInput === undefined && typeof value === "string" && labels.includes(value)
								? [value]
								: [];
					return {
						id: question.id,
						question: question.question,
						options: labels,
						multi: question.multi ?? false,
						selectedOptions,
						customInput,
					};
				}),
			};
		},
		notify: (message, type) => {
			logger.debug("ACP extension notification", { message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async (title, prefill, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"editor",
				title,
				{ type: "string", ...(prefill ? { default: prefill } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/** `data` of an error caused by provider credentials. `model` is the `provider/id` value of the model config option. */
type ProviderAuthErrorData = {
	reason: typeof PROVIDER_AUTH_REASON;
	provider?: string;
	model?: string;
	httpStatus?: number;
	details?: string;
};

/** A provider's refusal of its credentials, pinned to the credential-store generation it refused. */
type CredentialRejection = { generation: number; httpStatus: number };

/**
 * HTTP status of a provider refusing the credentials it was sent: any 401, and any 403 the provider did not
 * classify as a quota or concurrency limit (those refuse the request, not the key).
 */
function credentialRejectionStatus(message: AssistantMessage): number | undefined {
	const status = message.errorStatus;
	if (status === 401) return status;
	if (status !== 403) return undefined;
	const id = message.errorId;
	return AIError.is(id, AIError.Flag.UsageLimit) || AIError.is(id, AIError.Flag.Transient) ? undefined : status;
}

function requireObjectParams(method: string, params: unknown): Record<string, unknown> {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw RequestError.invalidParams({ method }, `${method} requires a params object`);
	}
	return params as Record<string, unknown>;
}

function requireStringField(method: string, params: unknown, field: string): string {
	const record = requireObjectParams(method, params);
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw RequestError.invalidParams({ method, field }, `${method} requires a non-empty string "${field}"`);
	}
	return value;
}

export class AcpAgent implements Agent {
	#connection: AgentSideConnection;
	#initialSession: AgentSession | undefined;
	#createSession: CreateAcpSession;
	#sessions = new Map<string, ManagedSessionRecord>();
	#handleWrites: Promise<void> = Promise.resolve();
	#disposePromise: Promise<void> | undefined;
	#cleanupRegistered = false;
	#clientCapabilities: ClientCapabilities | undefined;
	#initialized = false;
	#cancelCleanupTimeoutMs = ACP_CANCEL_CLEANUP_TIMEOUT_MS;
	#blobs = new BlobStore(getBlobsDir());
	/** Per provider: the last credential refusal a turn hit, so `authenticate` cannot vouch for those credentials. */
	#credentialRejections = new Map<string, CredentialRejection>();

	constructor(connection: AgentSideConnection, createSession: CreateAcpSession, initialSession?: AgentSession) {
		this.#connection = connection;
		this.#initialSession = initialSession;
		this.#createSession = createSession;
	}

	setCancelCleanupTimeoutForTesting(timeoutMs: number): void {
		this.#cancelCleanupTimeoutMs = Math.max(1, timeoutMs);
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		const record = requireObjectParams("initialize", params);
		const requested = record.protocolVersion;
		if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
			throw RequestError.invalidParams(
				{ method: "initialize", field: "protocolVersion", supported: PROTOCOL_VERSION },
				`initialize requires an integer protocolVersion >= 1, got ${JSON.stringify(requested)}`,
			);
		}
		// Spec negotiation: answer with the highest version both sides speak. A
		// client asking for something newer gets our version, not its own back.
		const negotiated = Math.min(requested, PROTOCOL_VERSION);
		if (negotiated !== requested) {
			logger.warn("ACP client requested an unsupported protocol version", {
				requested,
				negotiated,
				supported: PROTOCOL_VERSION,
			});
			// stderr is the only channel an ACP client shows its operator, and a
			// silent downgrade is what made version mismatches invisible.
			process.stderr.write(
				`proto acp: client requested protocol version ${requested}; serving version ${negotiated}.\n`,
			);
		}
		this.#registerConnectionCleanup();
		this.#initialized = true;
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: AGENT_AUTH_METHOD_ID,
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.proto.",
			},
		];
		if (this.#supportsTerminalAuth()) {
			authMethods.push({
				type: "terminal",
				id: TERMINAL_AUTH_METHOD_ID,
				name: "Set up Proto in terminal",
				description: "Launch the proto TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: negotiated,
			agentInfo: {
				name: "proto",
				title: "Proto",
				version: VERSION,
			},
			authMethods,
			// Legacy copy of the steering advertisement for clients that read it here, before it moved into
			// agentCapabilities._meta under a namespaced key as ACP's extensibility rules ask.
			_meta: { steering: { supported: true } },
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					// session/fork is in ACP's unstable schema: stable clients ignore the key, and T3 Code enables
					// thread forking from it.
					fork: {},
					resume: {},
					close: {},
				},
				_meta: { [STEERING_CAPABILITY_META_KEY]: { supported: true } },
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		this.#requireInitialized("authenticate");
		const methodId = requireStringField("authenticate", params, "methodId");
		const supported = this.#supportsTerminalAuth()
			? [AGENT_AUTH_METHOD_ID, TERMINAL_AUTH_METHOD_ID]
			: [AGENT_AUTH_METHOD_ID];
		if (!supported.includes(methodId)) {
			throw RequestError.invalidParams(
				{ field: "methodId", methodId, supported },
				`unknown auth method: ${methodId}`,
			);
		}
		// Both methods end in proto's own credential store: `agent` uses what is there, and a finished terminal
		// login wrote to it. Succeed only when requests can stop failing for credentials.
		await this.#verifyLocalCredentials();
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#requireInitialized("session/new");
		const cwd = await this.#requireWorkingDirectory("session/new", params);
		const record = await this.#createNewSessionRecord(cwd, params.mcpServers);
		const response: NewSessionResponse = {
			sessionId: record.protocolSessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.protocolSessionId);
		return response;
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#requireInitialized("session/load");
		const sessionId = requireStringField("session/load", params, "sessionId");
		const cwd = await this.#requireWorkingDirectory("session/load", params);
		const record = await this.#loadManagedSession(sessionId, cwd, params.mcpServers);
		await this.#replaySessionHistory(record);
		const response: LoadSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.protocolSessionId);
		return response;
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		this.#requireInitialized("session/list");
		if (params?.cwd) {
			await this.#requireWorkingDirectory("session/list", params);
		}
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		const sessions = await this.#listStoredSessions(params.cwd ?? undefined);
		const offset = this.#parseCursor(params.cursor ?? undefined);
		const paged = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
		const nextOffset = offset + paged.length;
		return {
			sessions: paged.map(session => this.#toSessionInfo(session)),
			nextCursor: nextOffset < sessions.length ? String(nextOffset) : undefined,
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#requireInitialized("session/resume");
		const sessionId = requireStringField("session/resume", params, "sessionId");
		const cwd = await this.#requireWorkingDirectory("session/resume", params);
		const record = await this.#resumeManagedSession(sessionId, cwd, params.mcpServers ?? []);
		const response: ResumeSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.protocolSessionId);
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#requireInitialized("session/fork");
		requireStringField("session/fork", params, "sessionId");
		await this.#requireWorkingDirectory("session/fork", params);
		const record = await this.#forkManagedSession(params);
		const response: ForkSessionResponse = {
			sessionId: record.protocolSessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.protocolSessionId);
		return response;
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		this.#requireInitialized("session/close");
		const record = this.#sessions.get(requireStringField("session/close", params, "sessionId"));
		if (!record) {
			return {};
		}
		await this.#closeManagedSession(params.sessionId, record);
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		this.#requireInitialized("session/set_mode");
		const record = this.#getSessionRecord(requireStringField("session/set_mode", params, "sessionId"));
		requireStringField("session/set_mode", params, "modeId");
		this.#applyModeChange(record.session, params.modeId);
		await this.#connection.sessionUpdate({
			sessionId: record.protocolSessionId,
			update: this.#buildCurrentModeUpdate(record.session),
		});
		await this.#pushConfigOptionUpdate(record);
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		this.#requireInitialized("session/set_config_option");
		const record = this.#getSessionRecord(requireStringField("session/set_config_option", params, "sessionId"));
		requireStringField("session/set_config_option", params, "configId");
		if (typeof params.value === "boolean") {
			throw RequestError.invalidParams(
				{ field: "value", configId: params.configId },
				`config option ${params.configId} does not take a boolean`,
			);
		}

		switch (params.configId) {
			case MODE_CONFIG_ID:
				this.#applyModeChange(record.session, params.value);
				break;
			case MODEL_CONFIG_ID:
				await this.#setModelById(record.session, params.value);
				break;
			case THINKING_CONFIG_ID:
				this.#setThinkingLevelById(record.session, params.value);
				break;
			default:
				throw RequestError.invalidParams(
					{ field: "configId", configId: params.configId },
					`unknown config option: ${params.configId}`,
				);
		}

		if (params.configId === MODE_CONFIG_ID) {
			await this.#connection.sessionUpdate({
				sessionId: record.protocolSessionId,
				update: this.#buildCurrentModeUpdate(record.session),
			});
		}

		const handledBySubscription =
			(params.configId === THINKING_CONFIG_ID || params.configId === MODEL_CONFIG_ID) &&
			record.lifetimeUnsubscribe !== undefined;
		if (!handledBySubscription) {
			await this.#pushConfigOptionUpdate(record);
		}
		return { configOptions: this.#buildConfigOptions(record.session) };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		this.#requireInitialized("session/prompt");
		const record = this.#getSessionRecord(requireStringField("session/prompt", params, "sessionId"));
		if (!Array.isArray(params.prompt)) {
			throw RequestError.invalidParams(
				{ method: "session/prompt", field: "prompt" },
				"session/prompt requires a prompt array",
			);
		}
		const activeTurn = record.promptTurn;
		const steerResubmission = this.#takeSteerResubmissionCredit(activeTurn, params.prompt);
		if (
			!steerResubmission &&
			activeTurn &&
			!activeTurn.settled &&
			(record.session.isStreaming || record.session.isRetrying)
		) {
			// A prompt sent while a turn runs, or waits to retry, steers by interrupting it (T3 Code relies on this):
			// the running turn answers `cancelled` once it has stopped, and this prompt runs after it.
			void this.#cancelTurn(record, activeTurn);
		}
		const cancellation: PromptDispatchCancellation = { cancelled: false };
		record.pendingPromptDispatches.push(cancellation);
		try {
			return await this.#queuePrompt(record, async () => {
				const previousTurn = record.promptTurn;
				if (previousTurn) {
					await previousTurn.promise.catch(() => undefined);
					await this.#awaitTurnStopped(record, previousTurn);
				}
				this.#throwIfRecordClosed(record);

				const converted = this.#convertPromptBlocks(params.prompt);
				// A run no prompt owns (an extension's background turn, a continuation that outlived its prompt) would
				// make this prompt busy: interrupt it as a steering prompt interrupts a turn, then run.
				if (!cancellation.cancelled) await this.#interruptUnownedRun(record);
				this.#throwIfRecordClosed(record);
				const pendingPrompt = Promise.withResolvers<PromptResponse>();
				const turn: PromptTurnState = {
					abortController: new AbortController(),
					cancelRequested: false,
					settled: false,
					closing: false,
					interrupting: false,
					lastAgentEnd: undefined,
					openToolCalls: new Set(),
					cancelling: undefined,
					cleanup: undefined,
					usageBaseline: this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
					unsubscribe: undefined,
					resolve: pendingPrompt.resolve,
					reject: pendingPrompt.reject,
					promise: pendingPrompt.promise,
				};
				record.promptTurn = turn;
				turn.unsubscribe = record.session.subscribe(event => {
					this.#trackPromptEvent(record, turn, event);
				});

				if (cancellation.cancelled) {
					// Cancelled while it waited in the queue: nothing ran, so there is nothing to stop.
					void this.#settleTurn(record, turn, { stopReason: "cancelled" });
					return await pendingPrompt.promise;
				}

				this.#runPromptOrCommand(record, turn, converted.text, converted.images).catch((error: unknown) => {
					// Errors from aborted work are the cancellation, never the answer (spec: prompt-turn cancellation).
					if (turn.cancelRequested) return;
					void this.#settleTurn(record, turn, undefined, error);
				});

				return await pendingPrompt.promise;
			});
		} finally {
			const index = record.pendingPromptDispatches.indexOf(cancellation);
			if (index >= 0) record.pendingPromptDispatches.splice(index, 1);
		}
	}

	async #queuePrompt(record: ManagedSessionRecord, run: () => Promise<PromptResponse>): Promise<PromptResponse> {
		const nextQueue = Promise.withResolvers<void>();
		const releaseQueue = nextQueue.resolve;
		const previousQueue = record.promptQueue;
		record.promptQueue = {
			promise: nextQueue.promise,
			release: releaseQueue,
		};
		await previousQueue.promise;
		this.#throwIfRecordClosed(record);
		try {
			return await run();
		} finally {
			releaseQueue();
			if (record.promptQueue.release === releaseQueue) {
				record.promptQueue.release = undefined;
			}
		}
	}

	#throwIfRecordClosed(record: ManagedSessionRecord): void {
		if (record.closedError) {
			throw record.closedError;
		}
	}

	#createPromptLifecycleError(message: string): PromptLifecycleError {
		return Object.assign(new Error(message), { code: "ACP_SESSION_CLOSED" as const });
	}

	#trackPromptEvent(record: ManagedSessionRecord, promptTurn: PromptTurnState, event: AgentSessionEvent): void {
		const handling = this.#handlePromptEvent(record, promptTurn, event).catch((error: unknown) => {
			logger.warn("ACP prompt event handler failed", { error });
		});
		record.promptEventHandlers.add(handling);
		void handling.finally(() => {
			record.promptEventHandlers.delete(handling);
		});
	}

	async #waitForPromptEventHandlers(record: ManagedSessionRecord): Promise<void> {
		while (record.promptEventHandlers.size > 0) {
			await Promise.allSettled(Array.from(record.promptEventHandlers));
		}
	}

	#trackExtensionUserMessage(record: ManagedSessionRecord, task: Promise<void>): void {
		const tracked = task.catch((error: unknown) => {
			logger.warn("ACP extension sendUserMessage failed", { error });
		});
		record.extensionUserMessageTasks.add(tracked);
		void tracked.finally(() => {
			record.extensionUserMessageTasks.delete(tracked);
		});
	}

	async #waitForExtensionUserMessages(
		record: ManagedSessionRecord,
		baseline: ReadonlySet<Promise<void>>,
	): Promise<void> {
		while (true) {
			const pending = Array.from(record.extensionUserMessageTasks).filter(task => !baseline.has(task));
			if (pending.length === 0) {
				return;
			}
			await Promise.allSettled(pending);
		}
	}

	async #runPromptOrCommand(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState,
		text: string,
		images: AgentImageContent[],
	): Promise<void> {
		const skillResult = await this.#tryRunSkillCommand(record, text);
		if (promptTurn.cancelRequested) return;
		if (skillResult) {
			await this.#concludeTurn(record, promptTurn);
			return;
		}

		const builtinResult = await executeAcpBuiltinSlashCommand(text, {
			session: record.session,
			sessionManager: record.session.sessionManager,
			settings: record.session.settings,
			cwd: record.session.sessionManager.getCwd(),
			signal: promptTurn.abortController.signal,
			output: output => this.#emitCommandOutput(record, output),
			refreshCommands: () => this.#emitAvailableCommandsUpdate(record),
			reloadPlugins: () => this.#reloadPluginState(record),
			notifyTitleChanged: async () => {
				await this.#connection.sessionUpdate({
					sessionId: record.protocolSessionId,
					update: {
						sessionUpdate: "session_info_update",
						title: record.session.sessionName,
						updatedAt: new Date().toISOString(),
					},
				});
			},
			notifyConfigChanged: async () => {
				await this.#pushConfigOptionUpdate(record);
			},
		});
		if (promptTurn.cancelRequested) return;
		if (builtinResult !== false) {
			await this.#settleTurn(record, promptTurn, {
				stopReason: "end_turn",
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
			});
			return;
		}

		const extensionPromptBaseline = new Set(record.extensionUserMessageTasks);
		const agentInvoked = await this.#dispatchPrompt(record, promptTurn, text, images);
		if (promptTurn.cancelRequested) return;

		if (!agentInvoked) {
			// A command handled locally can still run the agent through the messages it sends; that run answers.
			await this.#waitForExtensionUserMessages(record, extensionPromptBaseline);
			await this.#waitForPromptEventHandlers(record);
			if (promptTurn.lastAgentEnd === undefined) {
				await this.#settleTurn(record, promptTurn, { stopReason: "end_turn" });
				return;
			}
		}
		await this.#concludeTurn(record, promptTurn);
	}

	/**
	 * Runs the prompt. A run that claimed the session first is interrupted the way a steering prompt interrupts a
	 * turn instead of answering busy: the client may always send another session/prompt (spec: prompt-turn).
	 */
	async #dispatchPrompt(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState,
		text: string,
		images: AgentImageContent[],
	): Promise<boolean> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await record.session.prompt(text, { images });
			} catch (error) {
				if (!(error instanceof AgentBusyError) || promptTurn.cancelRequested) throw error;
				if (attempt >= ACP_DISPATCH_ATTEMPTS) throw this.#sessionNotStoppedError(record);
				promptTurn.interrupting = true;
				try {
					await this.#interruptUnownedRun(record);
				} finally {
					promptTurn.interrupting = false;
				}
				if (promptTurn.cancelRequested) return true;
			}
		}
	}

	/**
	 * Answers a dispatched prompt once the session is idle. An agent_end does not end the turn while recovery retries
	 * it or a continuation or async job delivery follows: answering there left that work running with no turn to
	 * report to, and the client's next prompt found the session busy. The newest agent_end decides the answer; a
	 * prompt the session dropped before it ran (superseded during setup, refused by a usage preflight) reports none.
	 */
	async #concludeTurn(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		await this.#waitForAcpPromptIdle(record, promptTurn);
		if (promptTurn.cancelRequested) return;
		const usage = this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics());
		const final = promptTurn.lastAgentEnd;
		if (!final) {
			await this.#settleTurn(record, promptTurn, { stopReason: "end_turn", usage });
			return;
		}
		const failure = this.#turnFailure(record, final, false);
		if (failure) {
			await this.#settleTurn(record, promptTurn, undefined, failure);
			return;
		}
		await this.#settleTurn(
			record,
			promptTurn,
			{ stopReason: this.#resolveStopReason(final, false), usage },
			undefined,
			{ endOfTurnUpdates: true },
		);
	}

	async #tryRunSkillCommand(record: ManagedSessionRecord, text: string): Promise<boolean> {
		if (!record.session.skillsSettings?.enableSkillCommands) {
			return false;
		}
		const parsed = parseSkillInvocation(text);
		if (!parsed) {
			return false;
		}
		const skill = record.session.skills.find(candidate => candidate.name === parsed.name);
		if (!skill) {
			return false;
		}
		const built = await buildSkillPromptMessage(skill, parsed.args, "user");
		await record.session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
		return true;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		requireStringField("session/cancel", params, "sessionId");
		const record = this.#getSessionRecord(params.sessionId);
		for (const cancellation of record.pendingPromptDispatches) cancellation.cancelled = true;
		const promptTurn = record.promptTurn;
		if (promptTurn && !promptTurn.settled) {
			await this.#cancelTurn(record, promptTurn);
			return;
		}
		// A run no prompt turn owns stops too, so the next prompt finds the session idle.
		if (!record.session.isStreaming) return;
		if (!(await this.#settlesWithinCancelBudget(this.#abortSession(record)))) {
			logger.warn("ACP session did not stop within the cancel budget; it stays open", {
				acpSessionId: record.protocolSessionId,
				timeoutMs: this.#cancelCleanupTimeoutMs,
			});
		}
	}

	/**
	 * Cancels a turn as session/cancel asks (spec: prompt-turn cancellation): stop its work, let the updates the
	 * stopping work produces reach the client, close the tool calls still open, then answer `cancelled`. An abort
	 * that overruns the cancel budget is still answered — the client is waiting — and the session stays registered:
	 * the next prompt waits for that abort instead of finding the session silently closed.
	 */
	#cancelTurn(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		if (promptTurn.cancelling) return promptTurn.cancelling;
		// Already being answered: its work is done, and stopping the idle session would only cost side effects.
		if (promptTurn.closing) return Promise.resolve();
		promptTurn.cancelRequested = true;
		promptTurn.abortController.abort();
		const cleanup = this.#abortSession(record).finally(() => {
			if (promptTurn.cleanup === cleanup) promptTurn.cleanup = undefined;
			if (promptTurn.settled && record.promptTurn === promptTurn) record.promptTurn = undefined;
		});
		promptTurn.cleanup = cleanup;
		promptTurn.cancelling = (async () => {
			if (!(await this.#settlesWithinCancelBudget(cleanup))) {
				logger.warn("ACP turn did not stop within the cancel budget; answering it as cancelled", {
					acpSessionId: record.protocolSessionId,
					timeoutMs: this.#cancelCleanupTimeoutMs,
				});
			}
			await this.#settleTurn(record, promptTurn, {
				stopReason: "cancelled",
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
			});
		})();
		return promptTurn.cancelling;
	}

	#abortSession(record: ManagedSessionRecord): Promise<void> {
		return record.session.abort({ reason: USER_INTERRUPT_LABEL }).catch((error: unknown) => {
			logger.warn("ACP session abort failed", { acpSessionId: record.protocolSessionId, error });
		});
	}

	/** Whether `work` settles within the cancel budget; it keeps running either way. */
	async #settlesWithinCancelBudget(work: Promise<unknown>): Promise<boolean> {
		const budget = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => budget.resolve(false), this.#cancelCleanupTimeoutMs);
		try {
			return await Promise.race([
				work.then(
					() => true,
					() => true,
				),
				budget.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The next prompt waits for a cancelled turn's abort, and fails explicitly when it overruns again. */
	async #awaitTurnStopped(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		const cleanup = promptTurn.cleanup;
		if (cleanup && !(await this.#settlesWithinCancelBudget(cleanup))) throw this.#sessionNotStoppedError(record);
	}

	/**
	 * A run no prompt turn owns — an extension's background turn, a wake, a continuation that outlived its prompt —
	 * would answer this prompt busy. Interrupt it the way a steering prompt interrupts a turn, then run.
	 */
	async #interruptUnownedRun(record: ManagedSessionRecord): Promise<void> {
		for (let attempt = 1; record.session.isStreaming; attempt++) {
			if (attempt > ACP_DISPATCH_ATTEMPTS || !(await this.#settlesWithinCancelBudget(this.#abortSession(record)))) {
				throw this.#sessionNotStoppedError(record);
			}
		}
	}

	#sessionNotStoppedError(record: ManagedSessionRecord): RequestError {
		return RequestError.internalError(
			{ sessionId: record.protocolSessionId, reason: "session_not_stopped" },
			"the session did not stop its running work within the cancel budget, so this prompt was not started",
		);
	}

	async extMethod(method: string, params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		switch (method) {
			case "_proto/sessions/listAll": {
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(5000, params.limit as number)) : 1000;
				const sessions = await SessionManager.listAll();
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return {
					sessions: sorted.map(s => this.#toSessionInfo(s)),
					total: sessions.length,
				};
			}
			case "_proto/projects/list": {
				const sessions = await SessionManager.listAll();
				const buckets = new Map<
					string,
					{ cwd: string; sessionCount: number; lastActivityAt: number; lastTitle: string }
				>();
				for (const s of sessions) {
					if (!s.cwd) continue;
					const ts = s.modified.getTime();
					const existing = buckets.get(s.cwd);
					if (existing) {
						existing.sessionCount += 1;
						if (ts > existing.lastActivityAt) {
							existing.lastActivityAt = ts;
							existing.lastTitle = s.title ?? "";
						}
					} else {
						buckets.set(s.cwd, {
							cwd: s.cwd,
							sessionCount: 1,
							lastActivityAt: ts,
							lastTitle: s.title ?? "",
						});
					}
				}
				const projects = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
				return { projects, totalSessions: sessions.length };
			}
			case "_proto/chats/byCwd": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				if (!cwd) throw RequestError.invalidParams({ method, field: "cwd" }, "cwd required");
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(500, params.limit as number)) : 100;
				const sessions = await SessionManager.list(cwd);
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return { sessions: sorted.map(s => this.#toSessionInfo(s)) };
			}
			case "_proto/usage": {
				const [firstRecord] = this.#sessions.values();
				const target = firstRecord?.session ?? this.#initialSession;
				if (!target) {
					return { reports: [] };
				}
				const reports = await target.fetchUsageReports();
				return { reports: reports ?? [] };
			}
			case "_proto/extensions": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				const sm = await Settings.init();
				const disabledIds = (sm.get("disabledExtensions") as string[] | undefined) ?? [];
				const extensions = await loadAllExtensions(cwd, disabledIds);
				return { extensions: extensions as unknown as Array<{ [key: string]: unknown }> };
			}
			case "_proto/extensions/toggle": {
				const providerId = params.providerId;
				if (typeof providerId !== "string") {
					throw RequestError.invalidParams({ method, field: "providerId" }, "providerId required");
				}
				if (params.enabled === false) {
					disableProvider(providerId);
					return { enabled: false };
				}
				enableProvider(providerId);
				return { enabled: true };
			}
			case SESSION_STEERING_METHOD:
				return await this.#handleSessionSteering(params);
			default:
				throw RequestError.methodNotFound(method);
		}
	}

	async #handleSessionSteering(params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		// A malformed request can carry null/non-object params (the transport hands
		// extension requests through unvalidated): reading `sessionId` below would
		// throw a TypeError surfaced as -32603. Map to the method's invalid-params
		// contract instead.
		if (typeof params !== "object" || params === null) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "params must be an object");
		}
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "sessionId required");
		}
		let record: ManagedSessionRecord;
		try {
			record = this.#getSessionRecord(sessionId);
		} catch {
			// Map unknown sessions to the method's error contract instead of
			// the generic internal error a plain `Error` would surface as.
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, `unknown session: ${sessionId}`);
		}
		this.#throwIfRecordClosed(record);

		const promptBlocks = toSteeringPromptBlocks(params.prompt);
		const converted = this.#convertPromptBlocks(promptBlocks);
		if (converted.text.length === 0 && converted.images.length === 0) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt is empty");
		}
		const queue = steeringQueueFromMeta(params._meta);
		if (!record.promptTurn || record.promptTurn.settled) return { outcome: "promptRequired", queue };

		try {
			const admitted = await record.session.joinActiveTurn(converted.text, converted.images, { queue });
			if (!admitted) {
				// A turn reserved but still dispatching (image preprocessing,
				// `isStreaming` not yet raised) refused the steer because it
				// cannot inject mid-dispatch. The host resubmits this content
				// through `session/prompt`; record the refused steer's content
				// key so that resubmission queues behind the turn instead of
				// implicitly cancelling the run — once dispatch completes —
				// that the steer was rejected in favor of. Keyed per refusal:
				// each refused steer earns exactly one matching resubmission,
				// and an unrelated prompt cannot consume another steer's
				// credit. A refusal while streaming is the abort window and
				// deliberately takes no credit: a prompt then matches the
				// user's stop intent.
				const reserved = record.promptTurn;
				if (reserved && !reserved.settled && !record.session.isStreaming) {
					reserved.awaitingSteerResubmissions = [
						...(reserved.awaitingSteerResubmissions ?? []),
						JSON.stringify(converted),
					];
				}
				return { outcome: "promptRequired", queue };
			}
		} catch (error: unknown) {
			return {
				outcome: "failed",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		return { outcome: "injected", queue };
	}

	#takeSteerResubmissionCredit(promptTurn: PromptTurnState | undefined, prompt: PromptRequest["prompt"]): boolean {
		const credits = promptTurn?.awaitingSteerResubmissions;
		if (!credits || credits.length === 0) return false;
		let converted: { text: string; images: AgentImageContent[] };
		try {
			converted = this.#convertPromptBlocks(prompt);
		} catch {
			// Malformed blocks: no credit matches, and `#queuePrompt` below
			// surfaces the same conversion error through its own call.
			return false;
		}
		const index = credits.indexOf(JSON.stringify(converted));
		if (index === -1) return false;
		credits.splice(index, 1);
		return true;
	}

	async extNotification(_method: string, _params: { [key: string]: unknown }): Promise<void> {}

	get signal(): AbortSignal {
		return this.#connection.signal;
	}

	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#registerConnectionCleanup(): void {
		if (this.#cleanupRegistered) {
			return;
		}
		this.#cleanupRegistered = true;
		this.#connection.signal.addEventListener(
			"abort",
			() => {
				void this.dispose();
			},
			{ once: true },
		);
	}

	async #createNewSessionRecord(cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			await session.sessionManager.ensureOnDisk();
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext);
	}

	async #loadManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findHandleSession(sessionId, cwd);
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #resumeManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findHandleSession(sessionId, cwd);
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #findHandleSession(handle: string, cwd: string): Promise<StoredSessionInfo> {
		await this.#handleWrites;
		const moved = (await readAcpSessionHandles())[handle];
		const stored =
			(moved ? await this.#findStoredSession(moved, cwd) : undefined) ??
			(await this.#findStoredSession(handle, cwd));
		if (!stored) throw RequestError.sessionNotFound(handle);
		return stored;
	}

	#rememberHandleSession(record: ManagedSessionRecord): void {
		const handle = record.protocolSessionId;
		const sessionId = record.session.sessionId;
		this.#handleWrites = this.#handleWrites
			.then(async () => {
				const file = path.join(getAgentDir(), ACP_SESSION_HANDLES_FILE);
				await withFileLock(file, async () => {
					const handles = await readAcpSessionHandles();
					if (sessionId === handle ? !Object.hasOwn(handles, handle) : handles[handle] === sessionId) return;
					if (sessionId === handle) delete handles[handle];
					else handles[handle] = sessionId;
					await atomicWriteJson(file, handles);
				});
			})
			.catch(error => logger.warn("Failed to record ACP session handle", { handle, sessionId, error }));
	}

	async #forkManagedSession(params: ForkSessionRequest): Promise<ManagedSessionRecord> {
		const sourcePath = await this.#resolveForkSourceSessionPath(params.sessionId);
		const { session } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(params.cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		let forked: AgentSession | undefined;
		try {
			const success = await session.switchSession(sourcePath);
			if (!success) {
				throw new Error(`ACP session fork was cancelled: ${params.sessionId}`);
			}
			forked = await session.fork();
			if (!forked) {
				throw new Error(`ACP session fork failed: ${params.sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		await session.dispose({ disposition: "runtime-release" });
		return await this.#registerPreparedSession(forked, params.mcpServers ?? [], forked.setToolUIContext);
	}

	async #openStoredSession(
		sessionPath: string,
		cwd: string,
		mcpServers: McpServer[],
		sessionId: string,
	): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			const success = await session.switchSession(sessionPath);
			if (!success) {
				throw new Error(`ACP session load was cancelled: ${sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext, sessionId);
	}

	async #registerPreparedSession(
		session: AgentSession,
		mcpServers: McpServer[],
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined,
		protocolSessionId = session.sessionId,
	): Promise<ManagedSessionRecord> {
		const record = this.#createManagedSessionRecord(session, setToolUIContext, protocolSessionId);
		session.setMcpServerInstructionsSource(() => record.mcpManager?.getServerInstructions());
		session.registerSessionChangeCallback(() => this.#rememberHandleSession(record));
		session.setClientBridge(
			createAcpClientBridge(this.#connection, record.protocolSessionId, this.#clientCapabilities),
		);

		try {
			await this.#configureExtensions(record);
			await this.#configureMcpServers(record, mcpServers);
			this.#sessions.set(record.protocolSessionId, record);
			return record;
		} catch (error) {
			await this.#disposeSessionRecord(record);
			throw error;
		}
	}

	#createManagedSessionRecord(
		session: AgentSession,
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined = undefined,
		protocolSessionId = session.sessionId,
	): ManagedSessionRecord {
		const record: ManagedSessionRecord = {
			protocolSessionId,
			session,
			setToolUIContext,
			mcpManager: undefined,
			mcpRefreshChain: undefined,
			pendingMcpStartupChunks: [],
			promptTurn: undefined,
			promptQueue: { promise: Promise.resolve(), release: undefined },
			liveMessageId: undefined,
			liveMessageProgress: undefined,
			toolArgsById: new Map(),
			extensionsConfigured: false,
			closedError: undefined,
			promptEventHandlers: new Set(),
			pendingPromptDispatches: [],
			extensionUserMessageTasks: new Set(),
			lifetimeUnsubscribe: undefined,
			lifetimeUpdatesReady: false,
			pendingCompactionNotifications: [],
			lifetimeDeliveries: new Set(),
		};
		record.lifetimeUnsubscribe = session.subscribe(event => {
			const delivery = this.#handleLifetimeEvent(record, event);
			record.lifetimeDeliveries.add(delivery);
			void delivery.finally(() => record.lifetimeDeliveries.delete(delivery));
		});
		return record;
	}

	async #handleLifetimeEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		try {
			let notification: AcpCompactionNotification;
			if (event.type === "auto_compaction_start") {
				notification = {
					method: "_proto/compaction/start",
					params: { sessionId: record.protocolSessionId, reason: event.reason, action: event.action },
				};
			} else if (event.type === "auto_compaction_end") {
				notification = {
					method: "_proto/compaction/end",
					params: {
						sessionId: record.protocolSessionId,
						action: event.action,
						aborted: event.aborted,
						willRetry: event.willRetry,
						skipped: event.skipped,
						errorMessage: event.errorMessage,
						tokensBefore: event.result?.tokensBefore,
					},
				};
			} else {
				if (
					record.lifetimeUpdatesReady &&
					(event.type === "thinking_level_changed" || event.type === "model_changed")
				) {
					await this.#pushConfigOptionUpdate(record);
				}
				return;
			}
			if (record.lifetimeUpdatesReady) {
				await this.#connection.extNotification(notification.method, notification.params);
			} else {
				record.pendingCompactionNotifications.push(notification);
			}
		} catch (error) {
			logger.warn("Failed to deliver ACP lifetime event", {
				acpSessionId: record.protocolSessionId,
				eventType: event.type,
				error,
			});
		}
	}

	#getSessionRecord(sessionId: string): ManagedSessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			throw RequestError.sessionNotFound(sessionId);
		}
		return record;
	}

	#assertMatchingCwd(session: AgentSession, cwd: string): void {
		const expected = path.resolve(cwd);
		const actual = path.resolve(session.sessionManager.getCwd());
		if (actual !== expected) {
			throw RequestError.invalidParams(
				{ field: "cwd", cwd: expected, loadedCwd: actual },
				`session ${session.sessionId} is already loaded for ${actual}, not ${expected}`,
			);
		}
	}

	async #resolveForkSourceSessionPath(sessionId: string): Promise<string> {
		const loaded = this.#sessions.get(sessionId);
		if (loaded) {
			if (isPromptTurnInFlight(loaded.promptTurn)) {
				throw new Error(`ACP session fork is unavailable while a prompt is in progress: ${sessionId}`);
			}
			await loaded.session.sessionManager.flush();
			const sessionPath = loaded.session.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error(`ACP session cannot be forked before it is persisted: ${sessionId}`);
			}
			return sessionPath;
		}

		const storedSession = await this.#findStoredSessionById(sessionId);
		if (!storedSession) {
			throw RequestError.sessionNotFound(sessionId);
		}
		return storedSession.path;
	}

	async #handlePromptEvent(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState,
		event: AgentSessionEvent,
	): Promise<void> {
		// A cancelled turn keeps forwarding while its work stops: those updates must reach the client before the
		// `cancelled` answer (spec: prompt-turn cancellation).
		if (promptTurn.closing || promptTurn.interrupting) {
			return;
		}
		if (event.type === "agent_end") {
			promptTurn.lastAgentEnd = event;
		}

		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			record.toolArgsById.set(event.toolCallId, event.args);
		}

		this.#prepareLiveAssistantMessage(record, event);
		const imageDataCache = new Map<string, string>();
		const resolveImageDataForAcp = (data: string, mimeType: string | undefined): string => {
			const key = `${mimeType ?? ""}\u0000${data}`;
			const cached = imageDataCache.get(key);
			if (cached !== undefined) return cached;
			const resolved = resolveImageDataSync(this.#blobs, data);
			imageDataCache.set(key, resolved);
			return resolved;
		};
		for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, record.protocolSessionId, {
			getMessageId: message => this.#getLiveMessageId(record, message),
			getMessageProgress: message => this.#getLiveMessageProgress(record, message),
			getToolArgs: toolCallId => record.toolArgsById.get(toolCallId),
			cwd: record.session.sessionManager.getCwd(),
			resolveImageData: resolveImageDataForAcp,
		})) {
			await this.#sendTurnUpdate(promptTurn, notification);
		}
		if (event.type === "tool_execution_end") {
			record.toolArgsById.delete(event.toolCallId);
		}
		this.#clearLiveAssistantMessageAfterEvent(record, event);

		// The turn is answered once the session is idle (`#concludeTurn`): recovery or a continuation may still
		// supersede this agent_end.
		if (event.type === "agent_end") {
			if (!promptTurn.cancelRequested) await this.#flushMissedFinalAssistantText(record, event);
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
		}
	}

	/** Forwards a turn's update, tracking the tool calls the client shows as running. */
	async #sendTurnUpdate(promptTurn: PromptTurnState, notification: SessionNotification): Promise<void> {
		const update = notification.update;
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (update.status === "completed" || update.status === "failed") {
				promptTurn.openToolCalls.delete(update.toolCallId);
			} else {
				promptTurn.openToolCalls.add(update.toolCallId);
			}
		}
		await this.#connection.sessionUpdate(notification);
	}

	/**
	 * Answers session/prompt, once. The turn stops forwarding, the updates already on their way reach the client
	 * first, and tool calls it still shows as running are closed as failed: nothing may follow the answer, and the
	 * client would otherwise show them running forever (spec: prompt-turn cancellation).
	 */
	async #settleTurn(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState,
		response?: PromptResponse,
		error?: unknown,
		options?: { endOfTurnUpdates?: boolean },
	): Promise<void> {
		if (promptTurn.closing) return;
		// A cancelled turn answers `cancelled` and nothing else, whatever its aborted work reports.
		if (promptTurn.cancelRequested && response?.stopReason !== "cancelled") return;
		promptTurn.closing = true;
		promptTurn.unsubscribe?.();
		const finalUpdates = (async () => {
			// Handlers that started before `closing` are still sending; the ones after it send nothing.
			await Promise.allSettled(Array.from(record.promptEventHandlers));
			if (options?.endOfTurnUpdates) await this.#emitEndOfTurnUpdates(record);
			await this.#closeOpenToolCalls(record, promptTurn);
		})().catch((updateError: unknown) => {
			logger.warn("ACP end-of-turn updates failed", { acpSessionId: record.protocolSessionId, error: updateError });
		});
		// Bounded: a client that stops reading must not keep session/close and dispose waiting on this answer.
		if (!(await this.#settlesWithinCancelBudget(finalUpdates))) {
			logger.warn("ACP turn updates did not drain before its answer", { acpSessionId: record.protocolSessionId });
		}
		promptTurn.settled = true;
		record.liveMessageId = undefined;
		record.liveMessageProgress = undefined;
		if (!promptTurn.cleanup && record.promptTurn === promptTurn) record.promptTurn = undefined;
		if (error !== undefined) promptTurn.reject(error);
		else promptTurn.resolve(response ?? { stopReason: "end_turn" });
	}

	async #closeOpenToolCalls(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		for (const toolCallId of promptTurn.openToolCalls) {
			promptTurn.openToolCalls.delete(toolCallId);
			record.toolArgsById.delete(toolCallId);
			await this.#connection.sessionUpdate({
				sessionId: record.protocolSessionId,
				update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
			});
		}
	}

	async #flushMissedFinalAssistantText(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const progress = record.liveMessageProgress;
		if (!progress || progress.textEmitted) {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant) {
			return;
		}
		const text = extractAssistantMessageText(lastAssistant);
		if (text.length === 0) {
			return;
		}
		progress.textEmitted = true;
		await this.#connection.sessionUpdate({
			sessionId: record.protocolSessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: record.liveMessageId,
			},
		});
	}

	async #waitForAcpPromptIdle(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		for (let pass = 0; pass < ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES; pass++) {
			await this.#waitForSessionIdle(record);
			if (promptTurn.cancelRequested) return;
			const delivered = await record.session.drainAsyncJobDeliveriesForAcp({
				timeoutMs: ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS,
			});
			if (!delivered) {
				return;
			}
		}

		await this.#waitForSessionIdle(record);
	}

	/**
	 * Idle covers recovery between retries (`waitForIdle`) and submissions that are admitted or dispatched but not
	 * streaming yet, such as a follow-up an extension sends when a run ends.
	 */
	async #waitForSessionIdle(record: ManagedSessionRecord): Promise<void> {
		const session = record.session;
		do {
			await session.waitForAdmittedSubmissions();
			await session.waitForIdle();
			await session.waitForStreamingIdle();
		} while (session.hasAdmittedSubmission || session.isStreaming);
	}

	#prepareLiveAssistantMessage(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type === "message_start" || !record.liveMessageId || !record.liveMessageProgress)
		) {
			record.liveMessageId = crypto.randomUUID();
			record.liveMessageProgress = { textEmitted: false, thoughtEmitted: false };
		}
	}

	#clearLiveAssistantMessageAfterEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
		}
	}

	#getLiveMessageId(record: ManagedSessionRecord, message: unknown): string | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageId ??= crypto.randomUUID();
		return record.liveMessageId;
	}

	#getLiveMessageProgress(
		record: ManagedSessionRecord,
		message: unknown,
	): { textEmitted: boolean; thoughtEmitted: boolean } | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageProgress ??= { textEmitted: false, thoughtEmitted: false };
		return record.liveMessageProgress;
	}

	/**
	 * A provider failure is not a completed turn. Print mode reports these on
	 * stderr with exit 1; over ACP the equivalent is a JSON-RPC error on
	 * session/prompt instead of a successful stopReason with the error text
	 * dressed up as assistant output. A provider refusing its credentials is
	 * told apart by the response's HTTP status, never by the error wording.
	 */
	#turnFailure(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		cancelRequested: boolean,
	): RequestError | undefined {
		if (cancelRequested) return undefined;
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		const reason = lastAssistant?.stopReason;
		if (reason !== "error" && reason !== "aborted") {
			// A provider that answered has accepted its credentials, whatever it refused before.
			if (lastAssistant) this.#credentialRejections.delete(lastAssistant.provider);
			return undefined;
		}
		const errorMessage = lastAssistant?.errorMessage ?? "";
		// A refusal is a legitimate ACP stop reason, not a transport failure.
		if (reason === "error" && /content[_ ]?filter|refus(al|ed)/i.test(errorMessage)) return undefined;
		const details = errorMessage || `turn ended with stopReason ${reason}`;
		const httpStatus = reason === "error" && lastAssistant ? credentialRejectionStatus(lastAssistant) : undefined;
		if (lastAssistant && httpStatus !== undefined) {
			const provider = lastAssistant.provider;
			const model = `${provider}/${lastAssistant.model}`;
			this.#credentialRejections.set(provider, {
				generation: record.session.modelRegistry.authStorage.getGeneration(),
				httpStatus,
			});
			return this.#providerAuthError(
				`${provider} rejected the credentials for ${model} (HTTP ${httpStatus}): ${conciseErrorReason(details)}`,
				{ reason: PROVIDER_AUTH_REASON, provider, model, httpStatus, details },
			);
		}
		return RequestError.internalError({ details }, conciseErrorReason(details));
	}

	#supportsTerminalAuth(): boolean {
		return this.#clientCapabilities?.auth?.terminal === true;
	}

	/**
	 * -32000 promises the client that an advertised auth method can fix the request. Only the terminal login can
	 * replace missing or rejected provider keys; `agent` uses the keys already configured, so without the terminal
	 * method the same failure is -32603.
	 */
	#providerAuthError(message: string, data: ProviderAuthErrorData): RequestError {
		return this.#supportsTerminalAuth()
			? RequestError.authRequired(data, message)
			: RequestError.internalError(data, message);
	}

	/**
	 * Credentials are good enough to authenticate when every open session's model has some, and none is the set its
	 * provider already refused. Before any session exists, check the model a new session would start with.
	 */
	async #verifyLocalCredentials(): Promise<void> {
		const sessions = Array.from(this.#sessions.values(), record => record.session);
		let probe: AgentSession | undefined;
		if (sessions.length === 0) {
			probe = normalizeCreatedAcpSession(
				await this.#createSession(process.cwd(), { interactivePrompts: false }),
			).session;
			sessions.push(probe);
		}
		try {
			for (const session of sessions) await this.#verifySessionCredentials(session);
		} finally {
			if (probe) await this.#disposeStandaloneSession(probe);
		}
	}

	async #verifySessionCredentials(session: AgentSession): Promise<void> {
		const model = session.model;
		if (!model) {
			throw this.#providerAuthError("no model with configured credentials is available", {
				reason: PROVIDER_AUTH_REASON,
			});
		}
		const registry = session.modelRegistry;
		try {
			// Adopt credentials another process committed (`proto login`, a finished terminal login) before judging them.
			await registry.authStorage.pollExternalChanges();
		} catch (error) {
			logger.debug("ACP authenticate could not poll the credential store", { error: String(error) });
		}
		const provider = model.provider;
		const modelId = this.#toModelId(model);
		if (!registry.hasConfiguredAuth(model)) {
			throw this.#providerAuthError(`no credentials are configured for ${modelId}; add them with \`proto login\``, {
				reason: PROVIDER_AUTH_REASON,
				provider,
				model: modelId,
			});
		}
		const rejection = this.#credentialRejections.get(provider);
		if (!rejection) return;
		if (rejection.generation !== registry.authStorage.getGeneration()) {
			this.#credentialRejections.delete(provider);
			return;
		}
		throw this.#providerAuthError(
			`${provider} rejected the configured credentials for ${modelId} (HTTP ${rejection.httpStatus}); replace them with \`proto login\``,
			{ reason: PROVIDER_AUTH_REASON, provider, model: modelId, httpStatus: rejection.httpStatus },
		);
	}

	#resolveStopReason(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		cancelRequested: boolean,
	): PromptResponse["stopReason"] {
		if (cancelRequested) {
			return "cancelled";
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		const reason = lastAssistant?.stopReason;
		switch (reason) {
			case "aborted":
				return "cancelled";
			case "length":
				return "max_tokens";
			case "error": {
				const errorMessage = lastAssistant?.errorMessage ?? "";
				if (/content[_ ]?filter|refus(al|ed)/i.test(errorMessage)) {
					return "refusal";
				}
				return "end_turn";
			}
			default:
				return "end_turn";
		}
	}

	async #emitCommandOutput(record: ManagedSessionRecord, text: string): Promise<void> {
		if (!text) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId: record.protocolSessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: crypto.randomUUID(),
			},
		});
	}

	#requireInitialized(method: string): void {
		if (this.#initialized) return;
		// ACP rejects every request but `initialize` that arrives before initialization with -32600.
		throw RequestError.invalidRequest({ method }, `${method} requires a successful initialize request first`);
	}

	/**
	 * A session is only as good as the directory it runs in: reject anything that
	 * is not an existing absolute directory before a session is created for it.
	 */
	async #requireWorkingDirectory(method: string, params: unknown): Promise<string> {
		const cwd = requireStringField(method, params, "cwd");
		if (!path.isAbsolute(cwd)) {
			throw RequestError.invalidParams({ method, field: "cwd", cwd }, `cwd must be an absolute path: ${cwd}`);
		}
		let stats: Stats;
		try {
			stats = await fs.stat(cwd);
		} catch (error) {
			const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "is not readable";
			throw RequestError.invalidParams({ method, field: "cwd", cwd }, `cwd ${detail}: ${cwd}`);
		}
		if (!stats.isDirectory()) {
			throw RequestError.invalidParams({ method, field: "cwd", cwd }, `cwd is not a directory: ${cwd}`);
		}
		return cwd;
	}

	#convertPromptBlocks(blocks: PromptRequest["prompt"]): { text: string; images: AgentImageContent[] } {
		const textParts: string[] = [];
		const images: AgentImageContent[] = [];
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
					break;
				case "resource": {
					const filePath = promptResourceFilePath(block.resource.uri);
					if ("text" in block.resource) {
						// File content gets the envelope an @-mentioned file gets, so the model knows where it came from.
						textParts.push(
							filePath === undefined
								? `<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`
								: `<file path="${filePath}">\n${block.resource.text}\n</file>`,
						);
						break;
					}
					textParts.push(`[embedded resource: ${filePath ?? block.resource.uri}]`);
					if (typeof block.resource.mimeType === "string" && block.resource.mimeType.startsWith("image/")) {
						images.push({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
					}
					break;
				}
				case "resource_link":
					textParts.push(formatPromptResourceLink(block));
					break;
				case "audio":
					textParts.push("[audio omitted]");
					break;
			}
		}
		return {
			text: textParts.join("\n\n").trim(),
			images,
		};
	}

	async #pushConfigOptionUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: record.protocolSessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: this.#buildConfigOptions(record.session),
			},
		});
	}

	#buildConfigOptions(session: AgentSession): SessionConfigOption[] {
		const currentModeId = this.#getCurrentModeId(session);
		const modeOptions = this.#getAvailableModes(session).map(mode => ({
			value: mode.id,
			name: mode.name,
			description: mode.description,
		}));
		const configOptions: SessionConfigOption[] = [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: currentModeId,
				options: modeOptions,
			},
		];

		const models = session.getAvailableModels();
		const currentModel = session.model;
		if (models.length > 0) {
			configOptions.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel ? this.#toModelId(currentModel) : this.#toModelId(models[0]),
				options: models.map(model => ({
					value: this.#toModelId(model),
					name: model.name,
					description: `${model.provider}/${model.id}`,
				})),
			});
		}

		configOptions.push({
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: this.#toThinkingConfigValue(
				session.model?.reasoning ? this.#getConfiguredThinkingLevel(session) : undefined,
			),
			options: this.#buildThinkingOptions(session),
		});
		return configOptions;
	}

	#buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
		return [
			{ value: THINKING_OFF, name: "Off" },
			...session.getAvailableThinkingLevels().map(level => ({
				value: level,
				name: level,
			})),
		];
	}
	#getConfiguredThinkingLevel(session: AgentSession): string | undefined {
		return session.configuredThinkingLevel();
	}

	#toThinkingConfigValue(value: string | undefined): string {
		return value && value !== "inherit" ? value : THINKING_OFF;
	}

	async #setModelById(session: AgentSession, modelId: string): Promise<void> {
		const model = session.getAvailableModels().find(candidate => this.#toModelId(candidate) === modelId);
		if (!model) {
			throw RequestError.invalidParams(
				{ field: "value", configId: MODEL_CONFIG_ID, value: modelId },
				`unknown model: ${modelId}`,
			);
		}
		await session.setModel(model);
	}

	#setThinkingLevelById(session: AgentSession, value: string): void {
		const thinkingLevel = parseThinkingLevel(value);
		if (!thinkingLevel) {
			throw RequestError.invalidParams(
				{ field: "value", configId: THINKING_CONFIG_ID, value },
				`unknown thinking level: ${value}`,
			);
		}
		session.setThinkingLevel(thinkingLevel);
	}

	#toModelId(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#getAvailableModes(_session: AgentSession): Array<{ id: string; name: string; description: string }> {
		return [{ id: ACP_DEFAULT_MODE_ID, name: "Default", description: "Standard ACP headless mode" }];
	}

	#getCurrentModeId(_session: AgentSession): string {
		return ACP_DEFAULT_MODE_ID;
	}

	#applyModeChange(session: AgentSession, modeId: string): void {
		const availableModes = this.#getAvailableModes(session);
		if (!availableModes.some(mode => mode.id === modeId)) {
			throw RequestError.invalidParams(
				{ modeId, supported: availableModes.map(mode => mode.id) },
				`unknown mode: ${modeId}`,
			);
		}
	}

	#buildModeState(session: AgentSession): SessionModeState {
		return {
			availableModes: this.#getAvailableModes(session),
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	#buildCurrentModeUpdate(session: AgentSession): SessionUpdate {
		return {
			sessionUpdate: "current_mode_update",
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	async #buildAvailableCommands(session: AgentSession): Promise<AvailableCommand[]> {
		return toAcpAvailableCommands(await buildAvailableSlashCommands(session));
	}

	#toSessionInfo(session: StoredSessionInfo): SessionInfo {
		return {
			sessionId: session.id,
			cwd: session.cwd,
			title: session.title,
			updatedAt: session.modified.toISOString(),
			_meta: {
				messageCount: session.messageCount,
				size: session.size,
			},
		};
	}

	#scheduleBootstrapUpdates(sessionId: string): void {
		setTimeout(() => {
			if (this.#connection.signal.aborted) {
				return;
			}
			const record = this.#sessions.get(sessionId);
			if (!record) {
				return;
			}
			void this.#emitBootstrapUpdates(sessionId, record).catch(error => {
				logger.warn("Failed to deliver ACP bootstrap updates", { sessionId, error });
			});
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		// MCP startup failures queued by `#configureMcpServers` flush here,
		// behind the bootstrap race guard, so the client can finally attribute
		// them to a session it knows.
		for (const { name, message } of record.pendingMcpStartupChunks.splice(0)) {
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `MCP server "${name}" failed to connect: ${message}. Its tools are unavailable until it is reauthorized or the client restarts the session.`,
					},
				},
			});
		}
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: record.session.sessionManager.getHeader()?.timestamp,
			},
		});
		while (record.pendingCompactionNotifications.length > 0) {
			const pending = record.pendingCompactionNotifications.splice(0);
			for (const notification of pending) {
				await this.#connection.extNotification(notification.method, notification.params);
			}
		}
		// Events arriving while delivery awaited above joined the queue instead of overtaking it.
		record.lifetimeUpdatesReady = true;
	}

	async #emitAvailableCommandsUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: record.protocolSessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
	}

	async #reloadPluginState(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await refreshAgentDiscovery(cwd);
		resetCapabilities();
		await record.session.refreshSkills();
		const fileCommands = await loadSlashCommands({ cwd });
		record.session.setSlashCommands(fileCommands);
		await this.#emitAvailableCommandsUpdate(record);
	}

	async #emitEndOfTurnUpdates(record: ManagedSessionRecord): Promise<void> {
		const sessionId = record.protocolSessionId;

		const contextUsage = record.session.getContextUsage();
		if (contextUsage) {
			const usageStats = record.session.sessionManager.getUsageStatistics();
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usageStats.cost > 0 ? { amount: usageStats.cost, currency: "USD" } : undefined,
				},
			});
		}

		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: new Date().toISOString(),
			},
		});
	}

	#cloneUsageStatistics(usage: UsageStatistics): UsageStatistics {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			orchestrationInput: usage.orchestrationInput,
			orchestrationOutput: usage.orchestrationOutput,
			orchestrationCacheRead: usage.orchestrationCacheRead,
			premiumRequests: usage.premiumRequests,
			cost: usage.cost,
			subagent: { ...usage.subagent },
		};
	}

	#buildTurnUsage(previous: UsageStatistics, current: UsageStatistics): Usage | undefined {
		const inputTokens = Math.max(0, current.input - previous.input);
		const outputTokens = Math.max(0, current.output - previous.output);
		const cachedReadTokens = Math.max(0, current.cacheRead - previous.cacheRead);
		const cachedWriteTokens = Math.max(0, current.cacheWrite - previous.cacheWrite);
		const totalTokens = Math.max(0, current.totalTokens - previous.totalTokens);

		if (totalTokens === 0) {
			return undefined;
		}

		const usage: Usage = {
			inputTokens,
			outputTokens,
			totalTokens,
		};
		if (cachedReadTokens > 0) {
			usage.cachedReadTokens = cachedReadTokens;
		}
		if (cachedWriteTokens > 0) {
			usage.cachedWriteTokens = cachedWriteTokens;
		}
		return usage;
	}

	async #listStoredSessions(cwd?: string): Promise<StoredSessionInfo[]> {
		const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async #findStoredSession(sessionId: string, cwd: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions(cwd);
		const scoped = sessions.find(session => session.id === sessionId);
		if (scoped) {
			return scoped;
		}

		return this.#findStoredSessionById(sessionId);
	}

	async #findStoredSessionById(sessionId: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions();
		return sessions.find(session => session.id === sessionId);
	}

	#parseCursor(cursor: string | undefined): number {
		if (!cursor) {
			return 0;
		}
		// Cursors are the decimal offsets this method hands out; anything else did not come from here.
		if (!/^\d+$/.test(cursor)) {
			throw RequestError.invalidParams({ field: "cursor", cursor }, `invalid session/list cursor: ${cursor}`);
		}
		return Number.parseInt(cursor, 10);
	}

	async #replaySessionHistory(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const replayedToolCallIds = new Set<string>();
		const replayedToolCallArgs = new Map<string, unknown>();
		for (const message of record.session.sessionManager.buildSessionContext().messages as ReplayableMessage[]) {
			for (const notification of this.#messageToReplayNotifications(
				record.protocolSessionId,
				message,
				cwd,
				replayedToolCallIds,
				replayedToolCallArgs,
			)) {
				await this.#connection.sessionUpdate(notification);
			}
		}
	}

	#messageToReplayNotifications(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(sessionId, message, cwd, replayedToolCallIds, replayedToolCallArgs);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string"
		) {
			return this.#replayToolResult(
				sessionId,
				cwd,
				{
					...message,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				},
				{
					includeStart: !replayedToolCallIds.has(message.toolCallId),
					toolArgs: replayedToolCallArgs.get(message.toolCallId),
				},
			);
		}
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution" ||
			message.role === "compactionSummary"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		return [];
	}

	#replayAssistantMessage(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		const messageId = crypto.randomUUID();
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: item.text },
							messageId,
						},
					});
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					typeof item.data === "string" &&
					"mimeType" in item &&
					typeof item.mimeType === "string"
				) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "image", data: item.data, mimeType: item.mimeType },
							messageId,
						},
					});
					continue;
				}
				if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
					const thinking = canonicalizeMessage(item.thinking);
					if (thinking.length === 0) continue;
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: thinking },
							messageId,
						},
					});
					continue;
				}
				const toolItem = item as ReplayableToolItem;
				if (
					(toolItem.type === "toolCall" || toolItem.type === "tool_use") &&
					typeof toolItem.id === "string" &&
					typeof toolItem.name === "string"
				) {
					const args = this.#buildReplayAssistantToolArgs(toolItem);
					notifications.push(
						...mapAgentSessionEventToAcpSessionUpdates(
							{
								type: "tool_execution_start",
								toolCallId: toolItem.id,
								toolName: toolItem.name,
								args,
							},
							sessionId,
							{ cwd },
						),
					);
					replayedToolCallIds.add(toolItem.id);
					replayedToolCallArgs.set(toolItem.id, args);
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage) {
			notifications.push({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
	}

	#buildReplayAssistantToolArgs(item: ReplayableToolItem): unknown {
		if ("arguments" in item) {
			return normalizeReplayToolArguments(item.arguments).args;
		}
		if (item.type === "tool_use" && "input" in item) {
			return item.input;
		}
		return {};
	}

	#replayToolResult(
		sessionId: string,
		cwd: string,
		message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
		options: { includeStart?: boolean; toolArgs?: unknown } = {},
	): SessionNotification[] {
		const args = this.#buildReplayToolArgs(message.details);
		const startEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
		};
		const endEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError === true,
			result: {
				content: message.content,
				details: message.details,
				errorMessage: message.errorMessage,
			},
		};
		const notifications = mapAgentSessionEventToAcpSessionUpdates(endEvent, sessionId, {
			cwd,
			getToolArgs: toolCallId => (toolCallId === message.toolCallId ? options.toolArgs : undefined),
			resolveImageData: (data, _mimeType) => resolveImageDataSync(this.#blobs, data),
		});
		if (options.includeStart === false) {
			return notifications;
		}
		return [...mapAgentSessionEventToAcpSessionUpdates(startEvent, sessionId, { cwd }), ...notifications];
	}

	#buildReplayToolArgs(details: unknown): { path?: string } {
		if (typeof details !== "object" || details === null || !("path" in details)) {
			return {};
		}
		const value = (details as { path?: unknown }).path;
		return typeof value === "string" && value.length > 0 ? { path: value } : {};
	}

	#wrapReplayContent(
		sessionId: string,
		content: PromptRequest["prompt"],
		kind: "agent_message_chunk" | "user_message_chunk",
		messageId: string,
	): SessionNotification[] {
		return content.map(block => ({
			sessionId,
			update: {
				sessionUpdate: kind,
				content: block,
				messageId,
			},
		}));
	}

	#extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
		const replay: PromptRequest["prompt"] = [];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					replay.push({ type: "text", text: item.text });
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					"mimeType" in item &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "text", text: errorMessage });
		}
		return replay;
	}

	async #configureExtensions(record: ManagedSessionRecord): Promise<void> {
		if (record.extensionsConfigured) {
			return;
		}

		const uiContext =
			this.#clientCapabilities?.elicitation?.form != null
				? createAcpExtensionUiContext(this.#connection, () => record.protocolSessionId, this.#clientCapabilities)
				: undefined;
		if (uiContext) {
			record.setToolUIContext?.(uiContext, true);
			record.session.setUsageFallbackConfirmer((confirmation, signal) => {
				const reserve =
					confirmation.remainingPercent === undefined
						? "inside the configured reserve margin"
						: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
				return uiContext.confirm(
					"Coding-plan reserve reached",
					`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
					{ signal },
				);
			});
		}

		const extensionRunner = record.session.extensionRunner;
		if (!extensionRunner) {
			record.extensionsConfigured = true;
			return;
		}

		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					record.session.sendCustomMessage(message, options).catch((error: unknown) => {
						logger.warn("ACP extension sendMessage failed", { error });
					});
				},
				sendUserMessage: (content, options) => {
					this.#trackExtensionUserMessage(record, record.session.sendUserMessage(content, options));
				},
				appendEntry: (customType, data) => {
					record.session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					record.session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => record.session.getEnabledToolNames(),
				getAllTools: () => record.session.getAllToolInfos(),
				setActiveTools: toolNames => record.session.setActiveToolsByName(toolNames),
				getCommands: () => getSessionSlashCommands(record.session),
				setModel: async model => {
					const apiKey = await record.session.modelRegistry.getApiKey(model);
					if (!apiKey) {
						return false;
					}
					await record.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => record.session.thinkingLevel,
				setThinkingLevel: level => record.session.setThinkingLevel(level),
				getServiceTiers: () => record.session.serviceTierByFamily,
				setServiceTier: (family, tier) => record.session.setServiceTierFamily(family, tier),
				getSessionName: () => record.session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await record.session.sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => record.session.model,
				isIdle: () => !record.session.isStreaming,
				abort: () => {
					void record.session.abort({ reason: USER_INTERRUPT_LABEL });
				},
				hasPendingMessages: () => record.session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => record.session.getContextUsage(),
				getSystemPrompt: () => record.session.systemPrompt,
				compact: (instructionsOrOptions, advisory) =>
					runExtensionCompact(record.session, instructionsOrOptions, advisory),
			},
			{
				getContextUsage: () => record.session.getContextUsage(),
				waitForIdle: () => record.session.agent.waitForIdle(),
				newSession: async options => {
					const success = await record.session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(record.session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await record.session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await record.session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await record.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await record.session.reload();
				},
				compact: (instructionsOrOptions, advisory) =>
					runExtensionCompact(record.session, instructionsOrOptions, advisory),
			},
			uiContext,
			"rpc",
		);
		await extensionRunner.emit({ type: "session_start" });
		record.extensionsConfigured = true;
	}

	async #configureMcpServers(record: ManagedSessionRecord, servers: McpServer[]): Promise<void> {
		if (record.mcpManager) {
			await record.mcpManager.dispose();
		}

		await record.mcpRefreshChain;
		record.mcpRefreshChain = undefined;
		if (servers.length === 0) {
			record.mcpManager = undefined;
			await record.session.refreshMCPTools([]);
			return;
		}

		const manager = new MCPManager(record.session.sessionManager.getCwd());

		const enqueueMcpToolsRefresh = (): Promise<void> => {
			const run = (record.mcpRefreshChain ?? Promise.resolve()).then(async () => {
				if (record.mcpManager !== manager) return;
				await record.session.refreshMCPTools(manager.getTools());
			});
			record.mcpRefreshChain = run.catch(error => {
				logger.warn("ACP MCP tool refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return run;
		};
		manager.setOnToolsChanged(() => {
			enqueueMcpToolsRefresh().catch(() => {});
		});
		const configs: MCPConfigMap = {};
		const sources: MCPSourceMap = {};
		for (const server of servers) {
			configs[server.name] = this.#toMcpConfig(server);
			sources[server.name] = {
				provider: "acp",
				providerName: "ACP Client",
				path: `acp://${server.name}`,
				level: "project",
			};
		}

		const result = await manager.connectServers(configs, sources);
		// A client-declared server whose initial connect fails (e.g. an expired
		// client-owned bearer answering 401 inside the startup window) must not
		// abort session creation: the record keeps the manager with the failed
		// definition, and the client is told through a chunk instead of the
		// session refusing to load. The chunk is queued, not sent, because this
		// runs before the newSession/loadSession response has given the client
		// the session id; `#emitBootstrapUpdates` drains the queue behind the
		// same race guard as the other bootstrap notifications.
		record.mcpManager = manager;
		await enqueueMcpToolsRefresh();
		for (const [name, message] of result.errors) {
			record.pendingMcpStartupChunks.push({ name, message });
		}
	}

	#toMcpConfig(server: McpServer): MCPServerConfig {
		if ("command" in server) {
			return {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: this.#toNameValueMap(server.env),
			};
		}
		if (server.type === "http") {
			return {
				type: "http",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		if (server.type === "sse") {
			return {
				type: "sse",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}

		throw new Error(`Unsupported MCP server transport: ${server.type}`);
	}

	#toNameValueMap(values: Array<{ name: string; value: string }>): { [name: string]: string } {
		const mapped: { [name: string]: string } = {};
		for (const value of values) {
			mapped[value.name] = value.value;
		}
		return mapped;
	}

	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		record.closedError ??= this.#createPromptLifecycleError("ACP session closed before queued prompt could run");
		this.#sessions.delete(sessionId);
		await this.#cancelPromptForClose(record);
		await this.#disposeSessionRecord(record);
	}

	async #cancelPromptForClose(record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!isPromptTurnInFlight(promptTurn)) {
			return;
		}
		// Each wait is bounded by the cancel budget: an abort that overruns it is disposed with the session.
		if (!promptTurn.settled) {
			await this.#cancelTurn(record, promptTurn);
			return;
		}
		if (promptTurn.cleanup && !(await this.#settlesWithinCancelBudget(promptTurn.cleanup))) {
			logger.warn("ACP prompt did not stop before session close", { acpSessionId: record.protocolSessionId });
		}
	}

	async #disposeSessionRecord(record: ManagedSessionRecord, reason?: postmortem.Reason): Promise<void> {
		record.lifetimeUnsubscribe?.();
		await Promise.allSettled(record.lifetimeDeliveries);
		if (record.mcpManager) {
			try {
				await record.mcpManager.dispose();
			} catch (error) {
				logger.warn("Failed to disconnect ACP MCP servers", { error });
			}
			record.mcpManager = undefined;
		}
		try {
			await record.session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeStandaloneSession(session: AgentSession, reason?: postmortem.Reason): Promise<void> {
		try {
			await session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async dispose(reason?: postmortem.Reason): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}

		this.#disposePromise = (async () => {
			const records = Array.from(this.#sessions.entries());
			this.#sessions.clear();
			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						record.closedError ??= this.#createPromptLifecycleError(
							"ACP agent disposed before queued prompt could run",
						);
						await this.#cancelPromptForClose(record);
						await this.#disposeSessionRecord(record, reason);
					} catch (error) {
						logger.warn("Failed to clean up ACP session", { acpSessionId: sessionId, error });
					}
				}),
			);

			const initialSession = this.#initialSession;
			this.#initialSession = undefined;
			if (initialSession) {
				await this.#disposeStandaloneSession(initialSession, reason);
			}
		})();

		await this.#disposePromise;
		await this.#handleWrites;
	}
}
