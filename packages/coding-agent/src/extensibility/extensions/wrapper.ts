/**
 * Tool wrappers for extensions.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { withFileMutationSession } from "../../tools/file-write-fallback";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	declare description: string;
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;
	readonly loadMode: ToolLoadMode;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);
		this.loadMode = defaultLoadModeForToolName(registeredTool.definition.name, registeredTool.definition.loadMode);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		context?: AgentToolContext,
	) {
		// Bind the extension context to this tool's own name so `ctx.invokeTool` delegates to the
		// native built-in of the same name (present only when this tool re-registers a built-in). The
		// wrapper's own context, abort signal, and progress callback are inherited by the delegated
		// call, so a bare `ctx.invokeTool(params)` keeps the caller's `toolCall`/provider metadata
		// (write/edit LSP batching, computer safety acknowledgement), stops when the outer call is
		// aborted, and still streams native progress.
		return this.registeredTool.definition.execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			this.runner.createContext(undefined, {
				toolName: this.registeredTool.definition.name,
				context,
				signal,
				onUpdate,
			}),
		);
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

function toolEventArgs(params: unknown, context: AgentToolContext | undefined): Record<string, unknown> {
	const metadata = context?.toolCall?.providerMetadata;
	if (metadata?.type === "computer") {
		return {
			actions: metadata.actions,
			pendingSafetyChecks: metadata.pendingSafetyChecks,
		};
	}
	return params as Record<string, unknown>;
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// The agent loop emits `tool_call` at arg-prep time (session
		// `beforeToolCall` wiring) so a handler revision lands before concurrency
		// scheduling and `tool_execution_start`. Consume the marker
		// unconditionally so it cannot go stale; emit here only for dispatches
		// the loop never saw — nested xd:// device dispatches and direct
		// (non-loop) execution such as Cursor exec handlers.
		const loopEmittedToolCall = this.runner.consumeToolCallEmitted(toolCallId, this.tool.name);
		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with, so execution always sees `effectiveParams`.
		let effectiveParams = params;
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall(
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						input: normalizeToolEventInput(
							this.tool.name,
							resolveToolEventInput(this.tool, toolEventArgs(params, context)),
						),
					},
					signal,
				)) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
				// A non-blocking handler may replace the execution input. The returned object is the raw
				// input passed to `execute` (handler-owned; not re-normalized). Skipped for `computer`
				// tool calls, whose event input is a synthetic {actions,pendingSafetyChecks} view
				// (see toolEventArgs) rather than the real execution params.
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as typeof params;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}

		// Execute the actual tool
		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			// A denied file write or delete inside this tool can be brokered to an
			// extension handler, and that registry is PROCESS-WIDE — so the session is
			// named here, the one place where every tool's execution and the runner
			// that owns the handlers are both in scope (`sdk.ts` wraps the whole tool
			// registry with this class whenever a runner exists). Inert with no
			// fallback registered: no scope is entered.
			result = await withFileMutationSession(this.runner.sessionId, () =>
				this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context),
			);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: normalizeToolEventInput(
					this.tool.name,
					resolveToolEventInput(this.tool, toolEventArgs(effectiveParams, context)),
				),
				content: result.content,
				details: result.details,
				isError: !!executionError,
			});

			if (resultResult) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Effective error state: an explicit handler override wins; otherwise the
				// original execution outcome stands. This lets a handler rewrite a failed
				// call's model-visible content/details while keeping it an error, flip a
				// failure to success, or flag a success as an error.
				const effectiveError = resultResult.isError ?? !!executionError;

				// Return the (possibly modified) result carrying the error flag rather than
				// rethrowing the original exception. The agent loop honors
				// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
				// `coerceToolResult` in agent-loop), so replacement failure content reaches
				// the model while the call remains an error — the original exception text is
				// no longer forced through, which previously discarded the replacement.
				return {
					content: modifiedContent,
					details: modifiedDetails,
					providerMetadata: result.providerMetadata,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		// No extension modification
		if (executionError) {
			throw executionError;
		}
		return result;
	}
}
