import { expect, spyOn, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentOptions, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { captureToolList, createAutoLearnCaptureRunner } from "./sdk";

test("capture turns retain primary request schemas while refusing every non-capture side effect", async () => {
	let writes = 0;
	let captures = 0;
	const write: AgentTool = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: type({ path: "string" }),
		execute: async () => {
			writes++;
			return { content: [] };
		},
	};
	const capture: AgentTool = {
		name: "capture",
		label: "Capture",
		description: "Capture learning",
		parameters: type({ note: "string" }),
		execute: async () => {
			captures++;
			return { content: [] };
		},
	};
	const [refused, allowed] = captureToolList([write, capture], [capture]);
	// The provider's schema prefix must be unchanged, not merely the tools' names.
	expect(toolWireSchema(refused!)).toEqual(toolWireSchema(write));
	const refusedResult = await refused!.execute("write", { path: "would-mutate" });
	await allowed!.execute("capture", { note: "learned" });
	expect(refusedResult.isError).toBe(true);
	expect(writes).toBe(0);
	expect(captures).toBe(1);
});

test("capture reuses the primary cache key and snapshots its turn before asynchronous header resolution", async () => {
	const headers = Promise.withResolvers<Record<string, string>>();
	const started = Promise.withResolvers<void>();
	const model = buildModel({
		id: "capture-test",
		name: "Capture",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	model.resolveHeaders = async () => {
		started.resolve();
		return await headers.promise;
	};
	const tool: AgentTool = {
		name: "capture",
		label: "Capture",
		description: "Capture",
		parameters: type({ note: "string" }),
		execute: async () => ({ content: [] }),
	};
	const source = new Agent({
		sessionId: "primary-session",
		promptCacheKey: "primary-cache",
		initialState: {
			model,
			systemPrompt: ["original prompt"],
			messages: [{ role: "user", content: "original turn", timestamp: 1 }],
			tools: [tool],
		},
	});
	let captured: AgentOptions | undefined;
	const capture = createAutoLearnCaptureRunner({
		sourceAgent: source,
		captureTools: [tool],
		createSessionId: () => "isolated-capture",
		createAgent: options => {
			captured = options;
			const agent = new Agent(options);
			spyOn(agent, "prompt").mockResolvedValue(undefined);
			return agent;
		},
	});
	const pending = capture("learn");
	await started.promise;
	source.setSystemPrompt(["next prompt"]);
	source.replaceMessages([{ role: "user", content: "next turn", timestamp: 2 }]);
	headers.resolve({ "X-Capture": "resolved" });
	await pending;
	expect(captured?.sessionId).toBe("isolated-capture");
	expect(captured?.promptCacheKey).toBe("primary-cache");
	expect(captured?.initialState?.systemPrompt).toEqual(["original prompt"]);
	expect(captured?.initialState?.messages?.[0]).toMatchObject({ content: "original turn" });
	expect(captured?.initialState?.model?.headers).toEqual({ "X-Capture": "resolved" });
	expect(captured?.initialState?.model?.resolveHeaders).toBeUndefined();
});
