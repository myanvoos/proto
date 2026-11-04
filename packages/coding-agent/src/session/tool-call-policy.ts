import type { AgentTool, AgentToolCall, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "../extensibility/extensions";

/** Direct and bridged invocations share extension policy and its exactly-once wrapper marker. */
export async function authorizeSessionToolCall(
	runner: ExtensionRunner | undefined,
	toolCall: AgentToolCall,
	tool: AgentTool,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
	if (!runner?.hasHandlers("tool_call")) return undefined;
	const metadata = toolCall.providerMetadata;
	const computer = metadata?.type === "computer" ? metadata : undefined;
	const input = computer ? { actions: computer.actions, pendingSafetyChecks: computer.pendingSafetyChecks } : args;
	const result = await runner.emitToolCall(
		{ type: "tool_call", toolName: tool.name, toolCallId: toolCall.id, input },
		signal,
	);
	if (result?.block) return { block: true, reason: result.reason || "Tool execution was blocked by an extension" };
	runner.markToolCallEmitted(toolCall.id, tool.name);
	if (result?.input !== undefined && !computer) return { args: result.input };
	return undefined;
}
