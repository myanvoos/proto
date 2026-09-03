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
		"Python code to run in the persistent kernel, verbatim. Top-level `await` is available. Verbatim `#@embed NAME … #@end` blocks bind NAME without any escaping.",
	),
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe(
		"timeout for this call in seconds (default 30; time spent inside agent()/completion() does not count); 0 disables the cell timeout",
	),
	"reset?": type("boolean").describe("wipe the kernel before running"),
	"files?": type({
		path: type("string").describe("file path, absolute or relative to cwd"),
		content: type("string").describe("full file contents, written verbatim as UTF-8 text"),
	})
		.array()
		.describe(
			"files written to disk before the code runs. The quoting-safe channel for file creation: content is a raw JSON string — no string-literal nesting, heredocs, or escaping gymnastics. Each write emits a write event with diff.",
		),
});

type KernelToolParams = typeof kernelSchema.infer;

export class KernelTool implements AgentTool<typeof kernelSchema> {
	readonly name = "kernel";
	readonly label = "Kernel";
	readonly loadMode = "discoverable";
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
				code: "data = json.loads(Path('package.json').read_text())\ndisplay(data)",
			},
		},
		{
			caption: "Third call — reuse the loaded config",
			call: {
				title: "scan deps",
				code: "display(sorted(data['dependencies']))",
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

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		const code = (args as Record<string, unknown>).code;
		if (typeof code !== "string" || code.length === 0) return undefined;
		return [{ path: "cell.py", digest: code }];
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
				files: params.files,
			},
			signal,
			onUpdate,
			ctx,
		);
	}
}
