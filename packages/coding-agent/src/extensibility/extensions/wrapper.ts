import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema, UserContent } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Second `renderCall` argument serving both renderer contracts: proto calls `renderCall(args, options, theme)`,
 * while pi-era renderers declare `renderCall(args, theme, context)`. Own keys stay the render options; every other
 * property resolves against the live theme, with methods bound to the theme (it keeps state in `#private` fields).
 */
function renderOptionsWithTheme<T extends object>(options: T, theme: Theme): T & Theme {
	const delegates = new Map<PropertyKey, unknown>();
	return new Proxy(options, {
		get(target, prop, receiver) {
			if (Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver);
			const delegate = delegates.get(prop);
			if (delegate !== undefined) return delegate;
			const value = Reflect.get(theme, prop, theme);
			if (typeof value !== "function") return value;
			const bound = value.bind(theme);
			delegates.set(prop, bound);
			return bound;
		},
	}) as T & Theme;
}

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

		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(
					args,
					renderOptionsWithTheme(options, theme as Theme),
					theme as Theme,
				);
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

export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

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
		const loopEmittedToolCall = this.runner.consumeToolCallEmitted(toolCallId, this.tool.name);

		let effectiveParams = params;
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall(
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						input: toolEventArgs(params, context),
					},
					signal,
				)) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}

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

		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: toolEventArgs(effectiveParams, context),
				content: result.content,
				details: result.details,
				isError: !!executionError || result.isError === true,
			});

			if (resultResult) {
				const modifiedContent: UserContent[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				const effectiveError = resultResult.isError ?? !!executionError;

				return {
					content: modifiedContent,
					details: modifiedDetails,
					providerMetadata: result.providerMetadata,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		if (executionError) {
			throw executionError;
		}
		return result;
	}
}
