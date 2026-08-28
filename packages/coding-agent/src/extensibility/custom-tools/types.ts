import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as zod from "@oh-my-pi/omptype/zod";
import type { AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { FetchImpl, Model, Static, TSchema } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import type { logger as PiLogger } from "@oh-my-pi/pi-utils";
import type { Rule } from "../../capability/rule";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import type * as PiCodingAgent from "../../index";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { Theme } from "../../modes/theme/theme";
import type { ReadonlySessionManager } from "../../session/session-manager";
import type { TodoItem } from "../../tools/todo";
import type { RetryErrorUpdate } from "../shared-events";

export type CustomToolUIContext = HookUIContext;

export type { ExecOptions, ExecResult } from "../../exec/exec";

export type { AgentToolResult, AgentToolUpdateCallback };

interface CustomToolPendingAction {
	label: string;

	apply(reason: string): Promise<AgentToolResult<unknown>>;

	reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;

	details?: unknown;

	sourceToolName?: string;
}

export interface CustomToolAPI {
	cwd: string;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	ui: CustomToolUIContext;

	hasUI: boolean;

	logger: typeof PiLogger;

	arktype: typeof ArkType;

	zod: typeof zod;

	pi: typeof PiCodingAgent;

	pushPendingAction(action: CustomToolPendingAction): void;
}

export interface CustomToolContext {
	sessionManager: ReadonlySessionManager;

	modelRegistry: ModelRegistry;

	model: Model | undefined;

	isIdle(): boolean;

	hasQueuedMessages(): boolean;

	abort(): void;

	settings?: Settings;

	fetch?: FetchImpl;

	localProtocolOptions?: LocalProtocolOptions;
}

export type CustomToolSessionEvent =
	| {
			reason: "start" | "switch" | "branch" | "tree" | "shutdown";

			previousSessionFile: string | undefined;
	  }
	| {
			reason: "auto_compaction_start";
			trigger: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote";
	  }
	| {
			reason: "auto_compaction_end";
			action: "context-full" | "remote";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			reason: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			reason: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| {
			reason: "ttsr_triggered";
			rules: Rule[];
	  }
	| {
			reason: "todo_reminder";
			todos: TodoItem[];
			attempt: number;
			maxAttempts: number;
	  };

export interface RenderResultOptions {
	expanded: boolean;

	isPartial: boolean;

	spinnerFrame?: number;

	argsComplete?: boolean;

	executionStarted?: boolean;
}

export type CustomToolResult<TDetails = any> = AgentToolResult<TDetails>;

export interface CustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	name: string;

	label: string;

	strict?: boolean;

	description: string;

	parameters: TParams;

	hidden?: boolean;

	loadMode?: ToolLoadMode;

	deferrable?: boolean;

	mcpServerName?: string;

	mcpToolName?: string;

	execute(
		toolCallId: string,
		params: Static<TParams>,
		onUpdate: AgentToolUpdateCallback<TDetails, TParams> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TDetails, TParams>>;

	onSession?: (event: CustomToolSessionEvent, ctx: CustomToolContext) => void | Promise<void>;

	renderCall?: (args: Static<TParams>, options: RenderResultOptions, theme: Theme) => Component;

	renderResult?: (
		result: CustomToolResult<TDetails>,
		options: RenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

export type CustomToolFactory = (
	pi: CustomToolAPI,
) => CustomTool<any, any> | CustomTool<any, any>[] | Promise<CustomTool<any, any> | CustomTool<any, any>[]>;

export interface LoadedCustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	path: string;

	resolvedPath: string;

	tool: CustomTool<TParams, TDetails>;

	source?: { provider: string; providerName: string; level: "user" | "project" };
}

export interface ToolLoadError {
	path: string;
	error: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}
