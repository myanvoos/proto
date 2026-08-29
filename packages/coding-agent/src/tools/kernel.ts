import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalToolDetails } from "../eval/types";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { EvalTool } from "./eval";
import { resolveEvalBackends } from "./eval-backends";
import "./kernel-prelude";
import kernelDescription from "../prompts/tools/kernel.md" with { type: "text" };
import type { ToolSession } from ".";

const kernelSchema = type({
	code: type("string").describe(
		"Python code to run in the persistent kernel, verbatim. Top-level `await` is available.",
	),
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe("timeout for this call in seconds; 0 disables the cell timeout"),
	"reset?": type("boolean").describe("wipe the kernel before running"),
});

type KernelToolParams = typeof kernelSchema.infer;

export class KernelTool implements AgentTool<typeof kernelSchema> {
	readonly name = "kernel";
	readonly label = "Kernel";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	get summary(): string {
		return "Do all work in a persistent Python kernel";
	}

	get description(): string {
		const session = this.session;
		if (!session) {
			return prompt.render(kernelDescription, { py: true });
		}
		const spawnPolicy = resolveSpawnPolicy(session.getSessionSpawns?.() ?? "*");
		return prompt.render(kernelDescription, {
			py: true,
			spawns: spawnPolicy.enabled,
			spawnDefaultAgent: spawnPolicy.defaultAgent,
			spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
			autoBackgroundEnabled: session.settings.get("eval.autoBackground.enabled"),
		});
	}

	get parameters(): typeof kernelSchema {
		return kernelSchema;
	}

	readonly intent = (args: Partial<KernelToolParams>): string | undefined => {
		return args.title || "working in kernel";
	};

	private static readonly ALL_EXAMPLES: readonly ToolExample<KernelToolParams>[] = [
		{
			caption: "First call — set up once",
			call: {
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "Second call — reuse, do NOT re-import",
			call: {
				title: "load config",
				code: "data = json.loads(read('package.json'))\ndisplay(data)",
			},
		},
		{
			caption: "Third call — run project commands and reuse state",
			call: {
				title: "scan deps",
				code: "result = await bash('bun pm ls --all')\ndisplay(sorted(data['dependencies']))",
			},
		},
	];

	get examples(): readonly ToolExample<KernelToolParams>[] {
		return KernelTool.ALL_EXAMPLES;
	}

	readonly #eval: EvalTool;

	constructor(private readonly session: ToolSession | null) {
		this.#eval = new EvalTool(session);
	}

	static createIf(session: ToolSession): KernelTool | null {
		return resolveEvalBackends(session).python ? new KernelTool(session) : null;
	}

	async execute(
		toolCallId: string,
		params: KernelToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		return await this.#eval.execute(
			toolCallId,
			{
				language: "py",
				code: params.code,
				title: params.title,
				timeout: params.timeout,
				reset: params.reset,
			},
			signal,
			onUpdate,
			ctx,
		);
	}
}
