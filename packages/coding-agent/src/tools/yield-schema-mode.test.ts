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

test("an empty-string error beside valid data is accepted as success", async () => {
	const tool = yieldTool("strict");
	const result = await tool.execute("yield-call", { result: { data: { count: 3 }, error: "" } });
	expect(result.details).toMatchObject({ status: "success", data: { count: 3 } });
});

test("strict provider optional nulls are omitted while explicit nullable fields remain null", async () => {
	const tool = new YieldTool({
		outputSchemaMode: "strict",
		outputSchema: {
			properties: { count: { type: "int32" } },
			optionalProperties: { omitted: { type: "string" }, nullable: { type: "string", nullable: true } },
		},
	} as unknown as ToolSession);
	const result = await tool.execute("strict-nulls", {
		result: { data: { count: 3, omitted: null, nullable: null } },
	});
	expect(result.details).toMatchObject({ status: "success", data: { count: 3, nullable: null } });
	expect(result.details?.data).not.toHaveProperty("omitted");
});

test("placeholder errors beside data do not discard the result but real errors remain conflicts", async () => {
	const tool = yieldTool("strict");
	for (const error of ["  ", " Unused ", "N/A"]) {
		const result = await tool.execute("placeholder", { result: { data: { count: 3 }, error } });
		expect(result.details).toMatchObject({ status: "success", data: { count: 3 } });
	}
	await expect(
		tool.execute("real-error", { result: { data: { count: 3 }, error: "failed to save" } }),
	).rejects.toThrow("both data and error");
	const failed = await tool.execute("error-only", { result: { error: "unused" } });
	expect(failed.details).toMatchObject({ status: "aborted", error: "unused" });
});

test("strict-provider null data placeholders do not conflict with a genuine failure outcome", async () => {
	const result = await yieldTool("strict").execute("strict-error", {
		result: { data: null, error: "failed to save" },
	});
	expect(result.details).toMatchObject({ status: "aborted", error: "failed to save" });
});
