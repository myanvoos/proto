import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AgentMessage,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { CredentialDisabledEvent, ImageContent, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AsyncJobSnapshot } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { addFileDeleteFallback, addFileWriteFallback } from "../../tools/file-write-fallback";
import type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";
import { ManagedTimers } from "./managed-timers";
import { createExtensionModelQuery } from "./model-api";
import type {
	AfterProviderResponseEvent,
	AssistantThinkingRenderer,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	InputEvent,
	InputEventResult,
	McpNotificationEvent,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	SessionStopEvent,
	SessionStopEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolRegistrationListener,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";

interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

type ExtensionErrorListener = (error: ExtensionError) => void;

export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

function throwUnsupportedServiceTierAction(): never {
	throw new Error("This extension host does not support service-tier actions");
}

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

function normalizeHandlerTimeout(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : EXTENSION_HANDLER_TIMEOUT_MS;
}

export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

function handlerTimeoutForEvent(eventType: string): number {
	return eventType === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");
const EXTENSION_HANDLER_ABORTED = Symbol("extensionHandlerAborted");

interface HandlerTimeoutBudget {
	pause(): void;
	resume(): void;
}

function attachHandlerSignal(
	dialogOptions: ExtensionUIDialogOptions | undefined,
	handlerSignal: AbortSignal,
): ExtensionUIDialogOptions {
	if (!dialogOptions) return { signal: handlerSignal };
	if (!dialogOptions.signal) return { ...dialogOptions, signal: handlerSignal };
	if (dialogOptions.signal === handlerSignal) return dialogOptions;
	return { ...dialogOptions, signal: AbortSignal.any([dialogOptions.signal, handlerSignal]) };
}

function createHandlerUIContext(
	ui: ExtensionUIContext,
	handlerSignal: AbortSignal,
	timeoutBudget?: HandlerTimeoutBudget,
): ExtensionUIContext {
	const askDialog = ui.askDialog;
	const runDialog = async <T>(dialog: () => Promise<T>): Promise<T> => {
		timeoutBudget?.pause();
		try {
			return await dialog();
		} finally {
			timeoutBudget?.resume();
		}
	};
	const dialogMethods = {
		select: (title, options, dialogOptions) =>
			runDialog(() => ui.select(title, options, attachHandlerSignal(dialogOptions, handlerSignal))),
		confirm: (title, message, dialogOptions) =>
			runDialog(() => ui.confirm(title, message, attachHandlerSignal(dialogOptions, handlerSignal))),
		input: (title, placeholder, dialogOptions) =>
			runDialog(() => ui.input(title, placeholder, attachHandlerSignal(dialogOptions, handlerSignal))),
		askDialog: askDialog
			? (questions, dialogOptions) =>
					runDialog(() => askDialog.call(ui, questions, attachHandlerSignal(dialogOptions, handlerSignal)))
			: undefined,
		custom: async (factory, options) => {
			let customSettled = false;
			let componentReady = false;
			try {
				return await ui.custom(
					async (...args) => {
						const component = await factory(...args);
						if (!customSettled) {
							timeoutBudget?.pause();
							componentReady = true;
						}
						return component;
					},
					{
						...options,
						signal: options?.signal ? AbortSignal.any([options.signal, handlerSignal]) : handlerSignal,
					},
				);
			} finally {
				customSettled = true;
				if (componentReady) timeoutBudget?.resume();
			}
		},
		editor: (title, prefill, dialogOptions, editorOptions) =>
			runDialog(() => ui.editor(title, prefill, attachHandlerSignal(dialogOptions, handlerSignal), editorOptions)),
	} satisfies Pick<ExtensionUIContext, "select" | "confirm" | "input" | "askDialog" | "custom" | "editor">;
	const delegatedMethods = new Map<PropertyKey, unknown>();

	return new Proxy(ui, {
		get(target, property) {
			if (Object.hasOwn(dialogMethods, property)) {
				return Reflect.get(dialogMethods, property, dialogMethods);
			}
			const cached = delegatedMethods.get(property);
			if (cached) return cached;
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const delegated: unknown = value.bind(target);
			delegatedMethods.set(property, delegated);
			return delegated;
		},
	});
}

function createHandlerContext(
	ctx: ExtensionContext,
	handlerSignal: AbortSignal,
	timeoutBudget?: HandlerTimeoutBudget,
): ExtensionContext {
	const scoped: ExtensionContext = Object.create(ctx);
	Object.defineProperty(scoped, "ui", {
		value: createHandlerUIContext(ctx.ui, handlerSignal, timeoutBudget),
		enumerable: true,
		configurable: true,
	});
	return scoped;
}

async function raceHandlerWithTimeout<T>(
	work: (handlerSignal: AbortSignal, timeoutBudget: HandlerTimeoutBudget) => Promise<T> | T,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T | typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED> {
	if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;

	const timeoutController = new AbortController();
	const handlerSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
	const { promise: interruptPromise, resolve: resolveInterrupt } = Promise.withResolvers<
		typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED
	>();
	const onAbort = () => resolveInterrupt(EXTENSION_HANDLER_ABORTED);
	signal?.addEventListener("abort", onAbort, { once: true });
	let timer: Timer | undefined;
	let remainingMs = timeoutMs;
	let activeSince = performance.now();
	let pauseDepth = 0;
	let settled = false;
	const clearTimer = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};
	const expire = () => {
		if (settled) return;
		settled = true;
		clearTimer();
		timeoutController.abort(new DOMException(`Handler timed out after ${timeoutMs}ms`, "TimeoutError"));
		resolveInterrupt(EXTENSION_HANDLER_TIMEOUT);
	};
	const armTimer = () => {
		if (settled || pauseDepth > 0) return;
		activeSince = performance.now();
		timer = setTimeout(expire, Math.max(0, remainingMs));
	};
	const settle = () => {
		if (settled) return;
		settled = true;
		clearTimer();
	};
	const timeoutBudget: HandlerTimeoutBudget = {
		pause: () => {
			if (settled) return;
			pauseDepth++;
			if (pauseDepth !== 1) return;
			remainingMs = Math.max(0, remainingMs - (performance.now() - activeSince));
			clearTimer();
			if (remainingMs <= 0) expire();
		},
		resume: () => {
			if (settled || pauseDepth === 0) return;
			pauseDepth--;
			if (pauseDepth === 0) armTimer();
		},
	};
	armTimer();
	try {
		if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;
		const workPromise = Promise.resolve(work(handlerSignal, timeoutBudget));
		const result = await Promise.race([workPromise, interruptPromise]);
		if (result === EXTENSION_HANDLER_TIMEOUT) {
			await Promise.race([
				workPromise.then(
					() => undefined,
					() => undefined,
				),
				Bun.sleep(0),
			]);
		}
		return result;
	} finally {
		settle();
		signal?.removeEventListener("abort", onAbort);
	}
}

const MAX_PENDING_CREDENTIAL_DISABLED = 32;

const MAX_PENDING_MCP_NOTIFICATIONS = 100;

type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: TEvent extends { type: "session_stop" }
						? SessionStopEventResult | undefined
						: undefined;

export type { BranchHandler, NavigateTreeHandler, NewSessionHandler };

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

type ShutdownHandler = () => void;

export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (!extensionRunner) return false;
	try {
		if (!extensionRunner.hasHandlers("session_shutdown")) return false;
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	} finally {
		extensionRunner.disposeFileFallbacks();
		extensionRunner.clearManagedTimers();
	}
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

interface ToolRegistrationScope {
	pending: Set<Promise<void>>;
	signal?: AbortSignal;
	closed: boolean;
}

export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#mode: ExtensionMode = "print";
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#getAsyncJobSnapshotFn: () => AsyncJobSnapshot | null = () => null;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	#toolRegistrationScope = new AsyncLocalStorage<ToolRegistrationScope>();
	#toolRegistrationBarrier: Promise<void> | undefined;
	#initialized = false;

	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	#pendingMcpNotifications: Array<Omit<McpNotificationEvent, "type">> = [];

	#managedTimers = new ManagedTimers((event, error, stack) =>
		this.emitError({ extensionPath: "<timer>", event, error, stack }),
	);

	#fileFallbackDisposers: Array<() => void> = [];

	#emittedToolCalls = new Set<string>();

	markToolCallEmitted(toolCallId: string, toolName: string): void {
		if (this.#emittedToolCalls.size >= 512) {
			const oldest = this.#emittedToolCalls.values().next().value;
			if (oldest !== undefined) this.#emittedToolCalls.delete(oldest);
		}
		this.#emittedToolCalls.add(`${toolCallId}:${toolName}`);
	}

	consumeToolCallEmitted(toolCallId: string, toolName: string): boolean {
		return this.#emittedToolCalls.delete(`${toolCallId}:${toolName}`);
	}

	#nativeToolResolver?: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined;

	setNativeToolResolver(
		resolve: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined,
	): void {
		this.#nativeToolResolver = resolve;
	}

	hasNativeTool(name: string): boolean {
		return this.#nativeToolResolver?.(name) !== undefined;
	}

	async invokeNativeTool<TDetails = unknown>(
		name: string,
		params: Record<string, unknown>,
		options?: {
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback<TDetails>;
			depth?: number;

			callerContext?: AgentToolContext;
		},
	): Promise<AgentToolResult<TDetails>> {
		const resolved = this.#nativeToolResolver?.(name);
		if (!resolved) throw new Error(`invokeTool: no native built-in named "${name}" to delegate to`);
		const depth = options?.depth ?? 0;
		if (depth >= 8) {
			throw new Error(`invokeTool: delegation depth exceeded 8 (recursive invokeTool for "${name}"?)`);
		}
		const toolCallId = `invoke-${name}-${Date.now().toString(36)}-${depth}`;
		return (await resolved.tool.execute(
			toolCallId,
			params as never,
			options?.signal,
			options?.onUpdate as never,
			options?.callerContext ?? resolved.makeContext(),
		)) as AgentToolResult<TDetails>;
	}

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,

		_initialCwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		private readonly settings?: Settings,
		private readonly localProtocolOptions?: LocalProtocolOptions,
		getAsyncJobSnapshot?: () => AsyncJobSnapshot | null,
	) {
		this.#uiContext = noOpUIContext;
		this.#getAsyncJobSnapshotFn = getAsyncJobSnapshot ?? (() => null);
	}

	get cwd(): string {
		return this.sessionManager.getCwd();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
		mode: ExtensionMode = "print",
	): void {
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = async toolNames => {
			const registrationBarrier = this.#toolRegistrationBarrier;
			if (registrationBarrier) await registrationBarrier;
			await actions.setActiveTools(toolNames);
		};
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.getServiceTiers = actions.getServiceTiers ?? throwUnsupportedServiceTierAction;
		this.runtime.setServiceTier = actions.setServiceTier ?? throwUnsupportedServiceTierAction;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.registerProvider = (name, config, sourceId) => {
			this.modelRegistry.registerProvider(name, config, sourceId);
		};
		this.runtime.unregisterProvider = name => {
			this.modelRegistry.unregisterProvider(name);
		};

		this.#getModel = contextActions.getModel;
		this.#isIdleFn = contextActions.isIdle;
		this.#abortFn = contextActions.abort;
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#shutdownHandler = contextActions.shutdown;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;

		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		}

		this.#uiContext = uiContext ?? noOpUIContext;
		this.#mode = mode;
		this.#initialized = true;

		this.disposeFileFallbacks();
		for (const ext of this.extensions) {
			if (ext.fileWriteFallbackHandlers.length === 0 && ext.fileDeleteFallbackHandlers.length === 0) continue;

			if (ext.fileWriteFallbackHandlers.length > 0) {
				this.#fileFallbackDisposers.push(
					addFileWriteFallback(async req => {
						const ctx = this.createContext();
						for (const handler of ext.fileWriteFallbackHandlers) {
							try {
								if (await handler(req, ctx)) return true;
							} catch (error) {
								logger.warn("Extension file write fallback handler threw; trying next handler", {
									extension: ext.path,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
						return false;
					}),
				);
			}
			if (ext.fileDeleteFallbackHandlers.length > 0) {
				this.#fileFallbackDisposers.push(
					addFileDeleteFallback(async req => {
						const ctx = this.createContext();
						for (const handler of ext.fileDeleteFallbackHandlers) {
							try {
								if (await handler(req, ctx)) return true;
							} catch (error) {
								logger.warn("Extension file delete fallback handler threw; trying next handler", {
									extension: ext.path,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
						return false;
					}),
				);
			}
		}

		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});

		const pendingMcp = this.#pendingMcpNotifications.splice(0);
		queueMicrotask(() => {
			for (const event of pendingMcp) {
				this.emit({ type: "mcp_notification", ...event }).catch((error: unknown) => {
					logger.warn("mcp_notification handler threw during initialize flush", {
						server: event.server,
						method: event.method,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	async emitMcpNotification(event: Omit<McpNotificationEvent, "type">): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingMcpNotifications.length >= MAX_PENDING_MCP_NOTIFICATIONS) {
				this.#pendingMcpNotifications.shift();
			}
			this.#pendingMcpNotifications.push(event);
			return;
		}
		await this.emit({ type: "mcp_notification", ...event });
	}

	async emitSessionStop(event: Omit<SessionStopEvent, "type">): Promise<SessionStopEventResult | undefined> {
		if (event.signal.aborted) return undefined;
		return await this.emit({ type: "session_stop", ...event });
	}
	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	getRegisteredTool(name: string): RegisteredTool | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const tool = this.extensions[index]?.tools.get(name);
			if (tool) return tool;
		}
		return undefined;
	}

	onToolRegistered(listener: (tool: RegisteredTool, signal?: AbortSignal) => void | Promise<void>): () => void {
		const subscriptions: Array<{ extension: Extension; listener: ToolRegistrationListener }> = [];
		for (const extension of this.extensions) {
			const trackRegistration = (pending: Promise<void>): void => {
				const registrationBarrier = pending.then(
					() => undefined,
					() => undefined,
				);
				this.#toolRegistrationBarrier = registrationBarrier;
				void registrationBarrier.then(() => {
					if (this.#toolRegistrationBarrier === registrationBarrier) this.#toolRegistrationBarrier = undefined;
				});
				const scope = this.#toolRegistrationScope.getStore();
				if (scope && !scope.closed) {
					scope.pending.add(pending);
					void pending.then(
						() => scope.pending.delete(pending),
						() => {},
					);
					return;
				}
				void pending.catch(error => {
					this.emitError({
						extensionPath: extension.path,
						event: "tool_registration",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				});
			};
			const wrapped: ToolRegistrationListener = toolName => {
				const tool = extension.tools.get(toolName);
				if (!tool) return;
				try {
					const scope = this.#toolRegistrationScope.getStore();
					const registrationSignal =
						scope && !scope.closed ? scope.signal : AbortSignal.timeout(extensionHandlerTimeoutMs);
					const pending = listener(tool, registrationSignal);
					if (pending) trackRegistration(pending);
				} catch (error) {
					trackRegistration(Promise.reject(error));
				}
			};
			extension.toolRegistrationListeners ??= new Set();
			extension.toolRegistrationListeners.add(wrapped);
			subscriptions.push({ extension, listener: wrapped });
		}
		return () => {
			for (const subscription of subscriptions) {
				subscription.extension.toolRegistrationListeners?.delete(subscription.listener);
			}
		};
	}

	async #flushToolRegistrations(pendingRegistrations: Set<Promise<void>>): Promise<void> {
		let firstFailure: PromiseRejectedResult | undefined;
		while (pendingRegistrations.size > 0) {
			const pending = Array.from(pendingRegistrations);
			const settled = await Promise.allSettled(pending);
			for (let index = 0; index < settled.length; index += 1) {
				pendingRegistrations.delete(pending[index]);
				const result = settled[index];
				if (!firstFailure && result?.status === "rejected") firstFailure = result;
			}
		}
		if (firstFailure) throw firstFailure.reason;
	}

	static aggregateFlags(extensions: readonly Extension[]): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlags(): Map<string, ExtensionFlag> {
		return ExtensionRunner.aggregateFlags(this.extensions);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS: Record<string, true> = {
		"ctrl+c": true,
		"ctrl+d": true,
		"ctrl+z": true,
		"ctrl+k": true,
		"ctrl+p": true,
		"ctrl+l": true,
		"ctrl+o": true,
		"ctrl+t": true,
		"ctrl+g": true,
		"alt+m": true,

		"ctrl+q": true,
		"shift+tab": true,
		"shift+ctrl+p": true,
		"alt+enter": true,
		escape: true,
		enter: true,
	};

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS[normalizedKey]) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getAssistantThinkingRenderers(): AssistantThinkingRenderer[] {
		return this.extensions.flatMap(ext => ext.assistantThinkingRenderers);
	}

	getRegisteredCommands(reserved?: ReadonlySet<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	createContext(
		model?: Model,
		delegation?: {
			toolName: string;
			depth?: number;
			context?: AgentToolContext;
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback;
		},
	): ExtensionContext {
		const getModel = model ? () => model : this.#getModel;
		return {
			ui: this.#uiContext,
			mode: this.#mode,
			getContextUsage: () => this.#getContextUsageFn(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
			getAsyncJobSnapshot: () => this.#getAsyncJobSnapshotFn(),
			hasUI: this.hasUI(),
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			isProjectTrusted: () => true,
			get model() {
				return getModel();
			},
			models: createExtensionModelQuery(this.modelRegistry, this.settings, getModel),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasPendingMessages: () => this.#hasPendingMessagesFn(),
			shutdown: () => this.#shutdownHandler(),
			getSystemPrompt: () => this.#getSystemPromptFn(),
			localProtocolOptions: this.localProtocolOptions,
			setInterval: (callback, ms, ...args) => this.#managedTimers.setInterval(callback, ms, ...args),
			setTimeout: (callback, ms, ...args) => this.#managedTimers.setTimeout(callback, ms, ...args),
			clearTimer: timer => this.#managedTimers.clear(timer),
			invokeTool:
				delegation !== undefined && this.hasNativeTool(delegation.toolName)
					? (params, options) =>
							this.invokeNativeTool(delegation.toolName, params, {
								signal: options?.signal ?? delegation.signal,
								onUpdate: options?.onUpdate ?? delegation.onUpdate,
								depth: (delegation.depth ?? 0) + 1,
								callerContext: delegation.context,
							})
					: undefined,
		};
	}

	shutdown(): void {
		this.#shutdownHandler();
	}

	clearManagedTimers(): void {
		this.#managedTimers.clearAll();
	}

	disposeFileFallbacks(): void {
		for (const dispose of this.#fileFallbackDisposers.splice(0)) dispose();
	}

	createCommandContext(): ExtensionCommandContext {
		return {
			...this.createContext(),
			getContextUsage: () => this.#getContextUsageFn(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
			switchSession: sessionPath => this.#switchSessionHandler(sessionPath),
			reload: () => this.#reloadHandler(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
		};
	}

	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}
	#isSessionShutdownEvent(event: RunnerEmitEvent): event is Extract<RunnerEmitEvent, { type: "session_shutdown" }> {
		return event.type === "session_shutdown";
	}
	async #runHandlerWithTimeout<TEvent extends { type: string }, TResult>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<TResult | undefined> | TResult | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number,
		onFailure?: (kind: "timeout" | "error", message: string) => TResult,
		outerSignal?: AbortSignal,
	): Promise<TResult | undefined> {
		const sessionStopSignal =
			event.type === "session_stop" && "signal" in event && event.signal instanceof AbortSignal
				? event.signal
				: undefined;
		const signals = [outerSignal, sessionStopSignal].filter((s): s is AbortSignal => s !== undefined);
		const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		if (signal?.aborted) return undefined;
		const registrationScope: ToolRegistrationScope = { pending: new Set(), closed: false };
		let handlerResult: TResult | typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED | undefined;
		let handlerFailure: { error: unknown } | undefined;
		try {
			handlerResult = await raceHandlerWithTimeout(
				async (handlerSignal, budget) => {
					registrationScope.signal = handlerSignal;
					let result: TResult | undefined;
					try {
						result = await this.#toolRegistrationScope.run(registrationScope, () =>
							handler(
								event,
								createHandlerContext(ctx, handlerSignal, event.type === "tool_call" ? budget : undefined),
							),
						);
					} catch (error) {
						handlerFailure = { error };
					} finally {
						registrationScope.closed = true;
					}
					try {
						await this.#flushToolRegistrations(registrationScope.pending);
					} catch (error) {
						handlerFailure ??= { error };
					}
					return result;
				},
				timeoutMs,
				signal,
			);
		} catch (error) {
			handlerFailure = { error };
		} finally {
			registrationScope.closed = true;
		}
		if (handlerResult === EXTENSION_HANDLER_ABORTED) return undefined;
		if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
			const error = `handler timed out after ${timeoutMs}ms`;
			logger.warn("Extension handler timed out", {
				extensionPath: ext.path,
				event: event.type,
				timeoutMs,
			});
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error,
			});
			return onFailure?.("timeout", error);
		}
		if (handlerFailure) {
			const message =
				handlerFailure.error instanceof Error ? handlerFailure.error.message : String(handlerFailure.error);
			const stack = handlerFailure.error instanceof Error ? handlerFailure.error.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return onFailure?.("error", message);
		}
		return handlerResult as TResult | undefined;
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		let ctx: ExtensionContext | undefined;
		let result: SessionBeforeEventResult | SessionCompactingResult | SessionStopEventResult | undefined;

		if (this.#isSessionShutdownEvent(event)) {
			const timeoutMs = handlerTimeoutForEvent(event.type);
			const promises: Promise<unknown>[] = [];
			for (const ext of this.extensions) {
				const handlers = ext.handlers.get(event.type);
				if (!handlers || handlers.length === 0) continue;
				ctx ??= this.createContext();
				for (const handler of handlers) {
					promises.push(this.#runHandlerWithTimeout(handler, event, ctx, ext, timeoutMs));
				}
			}
			if (promises.length > 0) await Promise.all(promises);
			return result as RunnerEmitResult<TEvent>;
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;
			ctx ??= this.createContext();

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					handlerTimeoutForEvent(event.type),
				);

				if (this.#isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}

				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}

				if (event.type === "session_stop" && handlerResult) {
					result = handlerResult as SessionStopEventResult;
					const hasContinuationContext =
						(typeof result.additionalContext === "string" && result.additionalContext.length > 0) ||
						(typeof result.reason === "string" && result.reason.length > 0);
					if ((result.continue === true || result.decision === "block") && hasContinuationContext) {
						return result as RunnerEmitResult<TEvent>;
					}
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					currentEvent,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			}
		}

		if (!modified) return undefined;

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		const timeoutMs = normalizeHandlerTimeout(
			this.settings?.get("extensionHandlers.toolCallTimeoutMs") ?? extensionHandlerTimeoutMs,
		);
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					timeoutMs,
					(kind, message) => ({
						block: true,
						reason:
							kind === "timeout"
								? `Extension ${ext.path} timed out after ${timeoutMs}ms`
								: `Extension ${ext.path} failed: ${message}`,
					}),
					signal,
				);

				if (handlerResult) {
					result = handlerResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		if (signal?.aborted) {
			return { block: true, reason: `Tool execution was cancelled while an extension handler was pending` };
		}
		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventName);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult) {
					return handlerResult as R;
				}
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
				const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
					| InputEventResult
					| undefined;
				if (result?.handled) return result;
				if (result?.text !== undefined) currentText = result.text;
				if (result?.images !== undefined) currentImages = result.images;
			}
		}
		const transformed: InputEventResult = {};
		if (currentText !== text) transformed.text = currentText;
		if (currentImages !== images) transformed.images = currentImages;
		return transformed;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();

		let hasContextHandlers = false;
		for (const ext of this.extensions) {
			if (ext.handlers.get("context")?.length) {
				hasContextHandlers = true;
				break;
			}
		}
		if (!hasContextHandlers) return messages;

		let currentMessages: AgentMessage[];
		try {
			currentMessages = structuredClone(messages);
		} catch {
			currentMessages = [...messages];
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown, model?: Model): Promise<BeforeProviderRequestEventResult> {
		const ctx = this.createContext(model);
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			}
		}

		return currentPayload;
	}

	async emitAfterProviderResponse(response: ProviderResponseMetadata, model?: Model): Promise<void> {
		const ctx = this.createContext(model);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("after_provider_response");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: AfterProviderResponseEvent = {
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
					requestId: response.requestId,
					metadata: response.metadata,
				};
				await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt =
							typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt;
						systemPromptModified = true;
					}
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}
}
