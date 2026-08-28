import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { HookRunner } from "./runner";
import type { ToolCallEventResult, ToolResultEventResult } from "./types";

export class HookToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private hookRunner: HookRunner,
	) {
		applyToolProxy(tool, this);
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		let effectiveParams = params;
		if (this.hookRunner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.hookRunner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by a hook";
					throw new Error(reason);
				}

				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as Static<TParameters>;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Hook failed, blocking execution: ${String(err)}`);
			}
		}

		try {
			const result = await this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context);

			if (this.hookRunner.hasHandlers("tool_result")) {
				const resultResult = (await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, effectiveParams as Record<string, unknown>),
					),
					content: result.content,
					details: result.details,
					isError: false,
				})) as ToolResultEventResult | undefined;

				if (resultResult) {
					return {
						content: resultResult.content ?? result.content,
						details: (resultResult.details ?? result.details) as TDetails,
					};
				}
			}

			return result;
		} catch (err) {
			if (this.hookRunner.hasHandlers("tool_result")) {
				await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, effectiveParams as Record<string, unknown>),
					),
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					details: undefined,
					isError: true,
				});
			}
			throw err;
		}
	}
}
