/**
 * Muse Code (`muse-code`) sends Responses function tools under a `_` prefix.
 *
 * A subscription key answers 403 `client_attestation_denied` when the request
 * declares certain exact tool names (`bash`, `web_search`, …), so every
 * function tool goes out prefixed and returned calls come back under their own
 * names. Names the prefix would push past Meta's 64-character limit stay
 * unprefixed, and Meta pay-as-you-go keys keep plain names.
 */
import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Context, FetchImpl, ModelSpec, Tool, ToolChoice } from "../types";
import { buildParams, mapOpenAIResponsesToolChoiceForTools, streamOpenAIResponses } from "./openai-responses";

function museSpec(provider: "muse-code" | "meta"): ModelSpec<"openai-responses"> {
	return {
		id: "muse-spark-1.3",
		name: "Muse Spark 1.3",
		api: "openai-responses",
		provider,
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	};
}

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sseResponse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Muse Code tool names", () => {
	test("omits tool_choice on api.meta.ai, which accepts only auto", () => {
		// Verified 2026-09-10 against muse-spark-1.3: "none", "required" and named
		// function choices all 400 with `only "auto" is supported for tool_choice`.
		const tool: Tool = { name: "yield", description: "Finish.", parameters: { type: "object", properties: {} } };
		const choices: ToolChoice[] = ["none", "required", { type: "tool", name: "yield" }];
		for (const provider of ["meta", "muse-code"] as const) {
			const model = buildModel(museSpec(provider));
			for (const choice of choices) {
				expect(mapOpenAIResponsesToolChoiceForTools(choice, [tool], model)).toBeUndefined();
			}
		}
	});

	test("declares and replays function tools under `_` and returns calls under their own names", async () => {
		const mcpName = "mcp__long_server_name_tool_name_tool_name_tool_name_too_139vuzq6";
		expect(mcpName).toHaveLength(64);
		const tools: Tool[] = [
			{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: {} } },
			{ name: "web_search", description: "Search the web.", parameters: { type: "object", properties: {} } },
			{ name: mcpName, description: "An MCP tool.", parameters: { type: "object", properties: {} } },
		];
		const runTurn = async (provider: "muse-code" | "meta") => {
			const model = buildModel(museSpec(provider));
			const context: Context = {
				tools,
				messages: [
					{ role: "user", content: "list files", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_ls", name: "bash", arguments: { command: "ls" } }],
						api: "openai-responses",
						provider,
						model: model.id,
						usage,
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call_ls",
						toolName: "bash",
						content: [{ type: "text", text: "README.md" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "search for omp", timestamp: 4 },
				],
			};
			const searchName = provider === "muse-code" ? "_web_search" : "web_search";
			const calls = [
				{ type: "function_call", id: "fc_1", call_id: "call_1", name: searchName, arguments: "" },
				{ type: "function_call", id: "fc_2", call_id: "call_2", name: mcpName, arguments: "" },
			];
			let body: { tools: Array<{ name: string }>; input: Array<{ type?: string; name?: string }> } | undefined;
			const fetch: FetchImpl = async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return sseResponse([
					...calls.flatMap((call, outputIndex) => [
						{ type: "response.output_item.added", output_index: outputIndex, item: call },
						{
							type: "response.output_item.done",
							output_index: outputIndex,
							item: { ...call, arguments: '{"query":"omp"}', status: "completed" },
						},
					]),
					{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
				]);
			};
			const result = await streamOpenAIResponses(model, context, { apiKey: "LLM|key", fetch }).result();
			return { body: body!, result };
		};

		const muse = await runTurn("muse-code");
		expect(muse.body.tools.map(tool => tool.name)).toEqual(["_bash", "_web_search", mcpName]);
		expect(muse.body.input.filter(item => item.type === "function_call").map(item => item.name)).toEqual(["_bash"]);
		expect(muse.result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "web_search", arguments: { query: "omp" } }),
			expect.objectContaining({ type: "toolCall", name: mcpName, arguments: { query: "omp" } }),
		]);

		// Direct Meta API keys are not attested and keep the plain names.
		const meta = await runTurn("meta");
		expect(meta.body.tools.map(tool => tool.name)).toEqual(["bash", "web_search", mcpName]);
		expect(meta.body.input.filter(item => item.type === "function_call").map(item => item.name)).toEqual(["bash"]);
		expect(meta.result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "web_search" }),
			expect.objectContaining({ type: "toolCall", name: mcpName }),
		]);
	});

	test("forces a named tool_choice under the wire name it declares", () => {
		const bash: Tool = {
			name: "bash",
			description: "Run a command.",
			parameters: { type: "object", properties: {} },
		};
		const read: Tool = { name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } };
		const build = (supportsNamedToolChoice: boolean) =>
			buildParams(
				buildModel({
					...museSpec("muse-code"),
					compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice },
				}),
				{ messages: [{ role: "user", content: "list files", timestamp: 1 }], tools: [bash, read] },
				{ toolChoice: { type: "tool", name: "bash" } },
				undefined,
			).params;
		expect(build(true).tool_choice).toEqual({ type: "function", name: "_bash" });
		// A string-only host gets the catalogue restricted to the forced tool instead.
		const stringOnly = build(false);
		expect(stringOnly.tools?.map(tool => (tool as { name?: string }).name)).toEqual(["_bash"]);
		expect(stringOnly.tool_choice).toBe("required");
	});

	test("derives wire names from the tools that survive schema quarantine", () => {
		// A 63-character name prefixes to 64, the wire name of the unprefixable
		// 64-character `_` + name.
		const long63 = "a".repeat(63);
		const good: Tool = { name: long63, description: "valid", parameters: { type: "object", properties: {} } };
		const twin: Tool = { name: `_${long63}`, description: "valid", parameters: { type: "object", properties: {} } };
		const quarantined: Tool = {
			...twin,
			parameters: {
				type: "object",
				properties: { choice: { enum: ["A", "B"], type: "null" } },
				required: ["choice"],
			},
		};
		const model = buildModel({
			...museSpec("muse-code"),
			compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true },
		});
		const build = (tools: Tool[], toolChoice?: ToolChoice) =>
			buildParams(
				model,
				{ messages: [{ role: "user", content: "go", timestamp: 1 }], tools },
				{ toolChoice },
				undefined,
			);

		// Two declared tools on one wire name could not be told apart.
		expect(() => build([twin, good])).toThrow(`both encode as "_${long63}"`);
		// A quarantined twin never reaches the wire: no collision, and forcing it
		// must not resolve to the surviving tool's wire name.
		const { params } = build([quarantined, good], { type: "tool", name: quarantined.name });
		expect(params.tools?.map(tool => (tool as { name?: string }).name)).toEqual([`_${long63}`]);
		expect(params.tool_choice).toBeUndefined();
	});
});
