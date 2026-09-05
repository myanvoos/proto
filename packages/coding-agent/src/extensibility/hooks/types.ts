import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as zod from "@oh-my-pi/omptype/zod";
import type { ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { logger as PiLogger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type * as PiCodingAgent from "../../index";
import type { Theme } from "../../modes/theme/theme";
import type { CustomMessagePayload, HookMessage } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type { BashToolDetails, ReadToolDetails } from "../../tools";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	SessionBeforeBranchEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

export type { ExecOptions, ExecResult } from "../../exec/exec";

export interface HookUIContext {
	select(title: string, options: string[]): Promise<string | undefined>;

	confirm(title: string, message: string): Promise<boolean>;

	input(title: string, placeholder?: string): Promise<string | undefined>;

	notify(message: string, type?: "info" | "warning" | "error"): void;

	setStatus(key: string, text: string | undefined): void;

	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T>;

	setEditorText(text: string): void;

	getEditorText(): string;

	editor(
		title: string,
		prefill?: string,
		options?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	readonly theme: Theme;
}

export interface HookContext {
	ui: HookUIContext;

	hasUI: boolean;

	cwd: string;

	sessionManager: ReadonlySessionManager;

	modelRegistry: ModelRegistry;

	model: Model | undefined;

	isIdle(): boolean;

	abort(): void;

	hasQueuedMessages(): boolean;
}

export interface HookCommandContext extends HookContext {
	waitForIdle(): Promise<void>;

	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	branch(entryId: string): Promise<{ cancelled: boolean }>;

	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

export type {
	ContextEvent,
	SessionBeforeBranchEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionCompactingEvent,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TreePreparation,
} from "../shared-events";

export interface BeforeAgentStartEvent {
	type: "before_agent_start";

	prompt: string;

	images?: ImageContent[];
}

export type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

export interface ToolCallEvent {
	type: "tool_call";

	toolName: string;

	toolCallId: string;

	input: Record<string, unknown>;
}

interface ToolResultEventBase {
	type: "tool_result";

	toolCallId: string;

	input: Record<string, unknown>;

	content: (TextContent | ImageContent)[];

	isError?: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

export type ToolResultEvent = BashToolResultEvent | ReadToolResultEvent | CustomToolResultEvent;

export type HookEvent =
	| SessionEvent
	| ContextEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| ToolCallEvent
	| ToolResultEvent;

export interface ContextEventResult {
	messages?: Message[];
}

export type { ToolCallEventResult, ToolResultEventResult } from "../shared-events";

export interface BeforeAgentStartEventResult {
	message?: CustomMessagePayload;
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

type HookHandler<E, R = undefined> = (event: E, ctx: HookContext) => Promise<R | void> | R | void;

interface HookMessageRenderOptions {
	expanded: boolean;
}

export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
	name: string;
	description?: string;

	handler: (args: string, ctx: HookCommandContext) => Promise<void>;
}

export interface HookAPI {
	on(event: "session_start", handler: HookHandler<SessionStartEvent>): void;
	on(event: "session_before_switch", handler: HookHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
	on(event: "session_switch", handler: HookHandler<SessionSwitchEvent>): void;
	on(event: "session_before_branch", handler: HookHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>): void;
	on(event: "session_branch", handler: HookHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: HookHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: HookHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: HookHandler<SessionCompactEvent>): void;
	on(event: "session_compact_failed", handler: HookHandler<SessionCompactFailedEvent>): void;
	on(event: "session_shutdown", handler: HookHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: HookHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: HookHandler<SessionTreeEvent>): void;

	on(event: "context", handler: HookHandler<ContextEvent, ContextEventResult>): void;
	on(event: "before_agent_start", handler: HookHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: HookHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: HookHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: HookHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: HookHandler<TurnEndEvent>): void;
	on(event: "auto_compaction_start", handler: HookHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: HookHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: HookHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: HookHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: HookHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: HookHandler<TodoReminderEvent>): void;
	on(event: "tool_call", handler: HookHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: HookHandler<ToolResultEvent, ToolResultEventResult>): void;

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
	): void;

	appendEntry<T = unknown>(customType: string, data?: T): void;

	registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void;

	registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	logger: typeof PiLogger;

	arktype: typeof ArkType;

	zod: typeof zod;

	pi: typeof PiCodingAgent;
}

export type HookFactory = (pi: HookAPI) => void;

export interface HookError {
	hookPath: string;
	event: string;
	error: string;
}
