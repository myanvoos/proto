import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { SessionManager } from "../../session/session-manager";
import { dispatchHandlerWithTimeout, EXTENSION_HANDLER_TIMEOUT_MS } from "../extensions/runner";
import { createNoOpUIContext } from "../utils";
import type {
	AppendEntryHandler,
	BranchHandler,
	LoadedHook,
	NavigateTreeHandler,
	NewSessionHandler,
	SendMessageHandler,
} from "./loader";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	HookCommandContext,
	HookContext,
	HookError,
	HookEvent,
	HookMessageRenderer,
	HookUIContext,
	RegisteredCommand,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEventResult,
} from "./types";

type HookErrorListener = (error: HookError) => void;
type HookHandler = (...args: unknown[]) => Promise<unknown>;

export { execCommand } from "../../exec/exec";

export const HOOK_HANDLER_TIMEOUT_MS = EXTENSION_HANDLER_TIMEOUT_MS;

export class HookRunner {
	#uiContext: HookUIContext;
	#hasUI: boolean;
	#errorListeners: Set<HookErrorListener> = new Set();
	#quarantinedHooks = new Set<LoadedHook>();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasQueuedMessagesFn: () => boolean = () => false;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });

	constructor(
		private readonly hooks: LoadedHook[],
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
	) {
		this.#uiContext = createNoOpUIContext();
		this.#hasUI = false;
	}

	initialize(options: {
		getModel: () => Model | undefined;

		sendMessageHandler: SendMessageHandler;

		appendEntryHandler: AppendEntryHandler;

		newSessionHandler?: NewSessionHandler;

		branchHandler?: BranchHandler;

		navigateTreeHandler?: NavigateTreeHandler;

		isIdle?: () => boolean;

		waitForIdle?: () => Promise<void>;

		abort?: () => void;

		hasQueuedMessages?: () => boolean;

		uiContext?: HookUIContext;

		hasUI?: boolean;
	}): void {
		this.#getModel = options.getModel;
		this.#isIdleFn = options.isIdle ?? (() => true);
		this.#waitForIdleFn = options.waitForIdle ?? (async () => {});
		this.#abortFn = options.abort ?? (() => {});
		this.#hasQueuedMessagesFn = options.hasQueuedMessages ?? (() => false);

		if (options.newSessionHandler) {
			this.#newSessionHandler = options.newSessionHandler;
		}
		if (options.branchHandler) {
			this.#branchHandler = options.branchHandler;
		}
		if (options.navigateTreeHandler) {
			this.#navigateTreeHandler = options.navigateTreeHandler;
		}

		for (const hook of this.hooks) {
			hook.setSendMessageHandler(options.sendMessageHandler);
			hook.setAppendEntryHandler(options.appendEntryHandler);
		}
		this.#uiContext = options.uiContext ?? createNoOpUIContext();
		this.#hasUI = options.hasUI ?? false;
	}

	getUIContext(): HookUIContext | null {
		return this.#uiContext;
	}

	getHasUI(): boolean {
		return this.#hasUI;
	}

	getHookPaths(): string[] {
		return this.hooks.map(h => h.path);
	}

	onError(listener: HookErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: HookError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const hook of this.hooks) {
			if (this.#quarantinedHooks.has(hook)) continue;
			const handlers = hook.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): HookMessageRenderer | undefined {
		for (const hook of this.hooks) {
			const renderer = hook.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getRegisteredCommands(): RegisteredCommand[] {
		const commands: RegisteredCommand[] = [];
		for (const hook of this.hooks) {
			for (const command of hook.commands.values()) {
				commands.push(command);
			}
		}
		return commands;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (const hook of this.hooks) {
			const command = hook.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	#createContext(): HookContext {
		return {
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.#getModel(),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasQueuedMessages: () => this.#hasQueuedMessagesFn(),
		};
	}

	createCommandContext(): HookCommandContext {
		return {
			...this.#createContext(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
		};
	}

	#isSessionBeforeEvent(
		type: string,
	): type is "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" {
		return (
			type === "session_before_switch" ||
			type === "session_before_branch" ||
			type === "session_before_compact" ||
			type === "session_before_tree"
		);
	}

	async #runHandler(
		hook: LoadedHook,
		handler: HookHandler,
		event: HookEvent,
		ctx: HookContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.#quarantinedHooks.has(hook) || signal?.aborted) return undefined;
		try {
			const outcome = await dispatchHandlerWithTimeout(() => handler(event, ctx), HOOK_HANDLER_TIMEOUT_MS, signal);
			if (outcome.status === "aborted") return undefined;
			if (outcome.status === "timed-out") {
				this.#quarantinedHooks.add(hook);
				this.emitError({
					hookPath: hook.path,
					event: event.type,
					error: `handler timed out after ${HOOK_HANDLER_TIMEOUT_MS}ms`,
				});
				return undefined;
			}
			return outcome.value;
		} catch (error) {
			this.emitError({
				hookPath: hook.path,
				event: event.type,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	async emit(
		event: HookEvent,
	): Promise<
		SessionBeforeCompactResult | SessionBeforeTreeResult | SessionCompactingResult | ToolResultEventResult | undefined
	> {
		const ctx = this.#createContext();
		let result:
			| SessionBeforeCompactResult
			| SessionBeforeTreeResult
			| SessionCompactingResult
			| ToolResultEventResult
			| undefined;

		for (const hook of this.hooks) {
			if (this.#quarantinedHooks.has(hook)) continue;
			const handlers = hook.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandler(hook, handler, event, ctx);

				if (this.#isSessionBeforeEvent(event.type) && handlerResult) {
					result = handlerResult as SessionBeforeCompactResult | SessionBeforeTreeResult;
					if (result.cancel) return result;
				}
				if (event.type === "tool_result" && handlerResult) {
					result = handlerResult as ToolResultEventResult;
				}
				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}
			}
		}

		return result;
	}

	async emitToolCall(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult | undefined> {
		if (signal?.aborted) return undefined;
		const ctx = this.#createContext();
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks) {
			if (this.#quarantinedHooks.has(hook)) continue;
			const handlers = hook.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandler(hook, handler, event, ctx, signal);
				if (signal?.aborted) return undefined;
				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) return result;
				}
			}
		}

		return result;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.#createContext();
		let currentMessages = messages;

		for (const hook of this.hooks) {
			if (this.#quarantinedHooks.has(hook)) continue;
			const handlers = hook.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await this.#runHandler(hook, handler, event, ctx);
				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images?: ImageContent[],
	): Promise<BeforeAgentStartEventResult | undefined> {
		const ctx = this.#createContext();
		let result: BeforeAgentStartEventResult | undefined;

		for (const hook of this.hooks) {
			if (this.#quarantinedHooks.has(hook)) continue;
			const handlers = hook.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt, images };
				const handlerResult = await this.#runHandler(hook, handler, event, ctx);
				if (handlerResult && (handlerResult as BeforeAgentStartEventResult).message && !result) {
					result = handlerResult as BeforeAgentStartEventResult;
				}
			}
		}

		return result;
	}
}
