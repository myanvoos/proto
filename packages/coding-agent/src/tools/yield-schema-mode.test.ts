import { expect, test } from "bun:test";
import type { ToolSession } from ".";
import { YieldTool } from "./yield";

// Contract: the retry hint must describe what actually happens when the budget runs out.
// Permissive mode drops the schema and accepts the result; strict mode never drops it and the
// turn ends as a schema_violation (see finalizeSubprocessOutput in task/executor.ts).
const SCHEMA = {
	type: "object",
	properties: { count: { type: "number" } },
	required: ["count"],
	additionalProperties: false,
};

function yieldTool(mode: "strict" | "permissive"): YieldTool {
	return new YieldTool({ outputSchema: SCHEMA, outputSchemaMode: mode } as unknown as ToolSession);
}

async function badYield(tool: YieldTool): Promise<string> {
	try {
		const result = await tool.execute("yield-call", { result: { data: { count: "not a number" } } });
		return result.content[0]?.type === "text" ? result.content[0].text : "";
	} catch (error) {
		return (error as Error).message;
	}
}

test("strict mode promises the schema_violation it actually delivers, never a dropped constraint", async () => {
	const tool = yieldTool("strict");
	const messages = [await badYield(tool), await badYield(tool), await badYield(tool), await badYield(tool)];
	for (const message of messages.slice(0, 3)) {
		expect(message).toContain("does not match schema");
		expect(message).toContain("the turn fails with schema_violation");
		expect(message).not.toContain("schema constraint is dropped");
	}
	expect(messages[0]).toContain("2 retry attempt(s) remain");
	expect(messages[1]).toContain("1 retry attempt(s) remain");
	expect(messages[2]).toContain("this is the final retry");
	// The fourth call is accepted by the tool so the turn can be finalized, but the response must
	// not claim the result was submitted: strict mode fails it.
	expect(messages[3]).toContain("strict mode fails this turn with schema_violation");
	expect(messages[3]).not.toContain("Result submitted");
});

test("permissive mode still promises the dropped constraint it honours", async () => {
	const tool = yieldTool("permissive");
	const messages = [await badYield(tool), await badYield(tool), await badYield(tool), await badYield(tool)];
	expect(messages[0]).toContain("2 retry attempt(s) remain before the schema constraint is dropped");
	expect(messages[2]).toContain("this is the final retry before the schema constraint is dropped");
	expect(messages[3]).toContain("schema validation overridden");
	for (const message of messages) expect(message).not.toContain("schema_violation");
});
