import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { handleKernelControl, type KernelControlResult } from "../eval/kernel-control";
import kernelDescription from "../prompts/tools/kernel.md" with { type: "text" };
import type { ToolSession } from ".";

const targetOptions = {
	"cwd?": type("string > 0").describe("Absolute directory on the target"),
	"interpreter?": type("string > 0").describe("Interpreter executable on the target"),
	"hostCommand?": type("string[]").describe("Installed compatible proto CLI argv for a remote bun kernel"),
	"+": "reject",
} as const;
const targetSchema = type({ kind: "'local'", "+": "reject" })
	.or(type({ kind: "'container'", container: "string > 0", "engine?": "'docker' | 'podman'", ...targetOptions }))
	.or(type({ kind: "'ssh'", host: "string > 0", ...targetOptions }));

export const kernelSchema = type({
	op: type("'list' | 'start' | 'inspect' | 'close' | 'reset' | 'keepalive'").describe(
		"Named kernel lifecycle operation",
	),
	"language?": type("'python' | 'node' | 'bun'").describe("Required except when listing every language"),
	"lane?": type("1 <= string <= 128").describe("Kernel lane; defaults to main, or all lanes for list"),
	"interpreter?": type("string > 0").describe("Interpreter executable; start/reset only"),
	"cwd?": type("string > 0").describe("Lane working directory; start/reset only"),
	"target?": targetSchema.describe("Execution environment; defaults to local; start/reset only"),
	"ttlMs?": type("1 <= number <= 3600000").describe(
		"Integer keepalive lease in milliseconds; required for keepalive, optional for start/reset",
	),
	"force?": type("boolean").describe("Close an executing kernel and cancel its work; close only"),
	"+": "reject",
});

type KernelParams = typeof kernelSchema.infer;
export type KernelToolDetails = KernelControlResult;

export class KernelTool implements AgentTool<typeof kernelSchema, KernelToolDetails> {
	readonly name = "kernel";
	readonly label = "Kernel";
	readonly summary = "Manage named Python, Node.js, and Bun kernels outside executing cells";
	readonly description: string;
	readonly parameters = kernelSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<KernelParams>): string =>
		`${args.op ?? "inspecting"} kernel ${args.lane ?? "main"}`;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(kernelDescription);
	}

	static createIf(session: ToolSession): KernelTool {
		return new KernelTool(session);
	}

	async execute(
		_toolCallId: string,
		params: KernelParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<KernelToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<KernelToolDetails>> {
		const result = await handleKernelControl(this.session, params, signal);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	}
}
