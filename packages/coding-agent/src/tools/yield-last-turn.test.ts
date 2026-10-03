import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from ".";
import { resetYieldTurnState, resolveYieldReportText, YieldTool } from "./yield";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return { ...overrides } as unknown as ToolSession;
}

function assistant(
	text: string,
	calls: string[] = [],
	stopReason = calls.length > 0 ? "toolUse" : "stop",
): AgentMessage {
	const content = [
		...(text ? [{ type: "text", text }] : []),
		...calls.map(id => ({ type: "toolCall", id, name: id.startsWith("yield") ? "yield" : "bash", arguments: {} })),
	];
	return { role: "assistant", content, stopReason } as unknown as AgentMessage;
}

function reminder(): AgentMessage {
	return {
		role: "developer",
		content: [{ type: "text", text: "<system-reminder>\nMUST yield\n</system-reminder>" }],
	} as unknown as AgentMessage;
}

describe("resolveYieldReportText", () => {
	it("uses the yield turn's own prose", () => {
		expect(resolveYieldReportText([assistant("final report", ["yield-1"])], "yield-1")).toBe("final report");
	});

	it("falls back to the prose turn before the yield, skipping synthetic reminders", () => {
		const messages = [assistant("the report"), reminder(), assistant("", ["yield-1"])];
		expect(resolveYieldReportText(messages, "yield-1")).toBe("the report");
	});

	it("finds no report when the previous turn started more work or the yield is batched", () => {
		expect(resolveYieldReportText([assistant("narration", ["bash-1"]), assistant("", ["yield-1"])], "yield-1")).toBe(
			undefined,
		);
		expect(resolveYieldReportText([assistant("text", ["bash-1", "yield-1"])], "yield-1")).toBe(undefined);
	});
});

describe("data-less yield", () => {
	it("adopts the report text as the result data", async () => {
		const tool = new YieldTool(session({ getYieldReportText: () => "the actual answer" }));
		const result = await tool.execute("yield-1", { type: "result" });
		expect(result.details).toMatchObject({ data: "the actual answer", status: "success" });
		expect(result.details?.useLastTurn).toBeUndefined();
	});

	it("rejects a finalize with no report text, then aborts instead of retrying forever", async () => {
		const tool = new YieldTool(session({ getYieldReportText: () => undefined }));
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(tool.execute("yield-1", { type: "result" })).rejects.toThrow(/retries remaining before abort/);
		}
		const aborted = await tool.execute("yield-1", { type: "result" });
		expect(aborted.details?.status).toBe("aborted");
		expect(aborted.details?.error).toMatch(/empty last-turn result after 4 consecutive attempt/);
	});

	it("rejects an empty incremental section instead of letting it mask an empty finalize", async () => {
		const tool = new YieldTool(session({ getYieldReportText: () => undefined }));
		await expect(tool.execute("yield-1", { type: ["notes"] })).rejects.toThrow(/has no text/);
		await expect(tool.execute("yield-2", { type: "result" })).rejects.toThrow(/has no text/);
	});

	it("re-arms the guard for the next run once the reused tool is reset", async () => {
		let report: string | undefined = "notes";
		const tool = new YieldTool(session({ getYieldReportText: () => report }));
		await tool.execute("yield-1", { type: ["notes"] });
		report = undefined;
		// Same run: accumulated sections close without reading last-turn text.
		expect((await tool.execute("yield-2", { type: "result" })).details?.status).toBe("success");
		resetYieldTurnState(tool);
		await expect(tool.execute("yield-3", { type: "result" })).rejects.toThrow(/has no text/);
	});
});

describe("schema retries", () => {
	const SCHEMA = {
		type: "object",
		properties: { verdict: { enum: ["correct", "incorrect"] }, count: { type: "number" }, note: { type: "string" } },
	};
	const tool = () => new YieldTool(session({ outputSchema: SCHEMA }));

	it("resets the retry budget after a schema-valid section", async () => {
		const yieldTool = tool();
		await expect(yieldTool.execute("y", { type: ["verdict"], result: { data: "Correct" } })).rejects.toThrow(
			/2 retry attempt\(s\) remain/,
		);
		await yieldTool.execute("y", { type: ["verdict"], result: { data: "correct" } });
		await expect(yieldTool.execute("y", { type: ["verdict"], result: { data: "approved" } })).rejects.toThrow(
			/2 retry attempt\(s\) remain/,
		);
	});

	it("recovers JSON-encoded primitives only when the raw value fails", async () => {
		const yieldTool = tool();
		expect((await yieldTool.execute("y", { type: ["verdict"], result: { data: '"correct"' } })).details?.data).toBe(
			"correct",
		);
		expect((await yieldTool.execute("y", { type: ["count"], result: { data: "42" } })).details?.data).toBe(42);
		expect((await yieldTool.execute("y", { type: ["note"], result: { data: "42" } })).details?.data).toBe("42");
		await expect(yieldTool.execute("y", { type: ["verdict"], result: { data: "null" } })).rejects.toThrow(
			/does not match schema/,
		);
	});
});
