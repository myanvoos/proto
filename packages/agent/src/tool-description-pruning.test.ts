import { expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "./agent";
import type { AgentTool } from "./types";

test("changing description pruning updates subsequent provider requests rather than an unused public property", async () => {
	const provider = createMockModel({ handler: { content: ["done"] } });
	const tool: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "Provider-visible description",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Path to inspect" } },
		} as AgentTool["parameters"],
		execute: async () => ({ content: [] }),
	};
	const agent = new Agent({ initialState: { model: provider, tools: [tool] }, streamFn: provider.stream });
	await agent.prompt("first");
	agent.setPruneToolDescriptions(true);
	await agent.prompt("second");
	agent.setPruneToolDescriptions(false);
	await agent.prompt("third");
	expect(provider.calls.map(call => call.context.tools?.[0]?.description)).toEqual([
		"Provider-visible description",
		"",
		"Provider-visible description",
	]);
});
