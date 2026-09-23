import { describe, expect, test } from "bun:test";
import { normalizeTools } from "./agent-loop";
import type { AgentTool } from "./types";

const tool: AgentTool = {
	name: "demo",
	label: "Demo",
	description: "top-level tool description",
	parameters: {
		type: "object",
		properties: { path: { type: "string", description: "where to read" } },
		required: ["path"],
	} as AgentTool["parameters"],
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

describe("normalizeTools intent injection", () => {
	test("reuses injected parameters by identity across calls so downstream schema memos hit", () => {
		for (const pruneDescriptions of [false, true]) {
			const first = normalizeTools([tool], { injectIntent: true, pruneDescriptions })?.[0]?.parameters;
			const second = normalizeTools([tool], { injectIntent: true, pruneDescriptions })?.[0]?.parameters;
			expect(first).toBeDefined();
			expect(second).toBe(first);
		}
		const bare = normalizeTools([tool], { injectIntent: true, pruneDescriptions: true })?.[0]?.parameters;
		const described = normalizeTools([tool], { injectIntent: true })?.[0]?.parameters;
		expect(described).not.toBe(bare);
	});
});
