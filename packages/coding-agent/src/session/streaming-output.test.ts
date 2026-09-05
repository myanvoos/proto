import { expect, test } from "bun:test";
import { OutputSink } from "./streaming-output";

test("diagnostic summary preserves file, line, category, and message across chunk boundaries", async () => {
	const sink = new OutputSink({ spillThreshold: 64, headBytes: 0 });
	sink.push("noise before\nsrc/check.ts:17: error: actionable failure\n".slice(0, 23));
	sink.push("noise before\nsrc/check.ts:17: error: actionable failure\n".slice(23));
	sink.push("incidental output\n".repeat(20));
	const summary = await sink.dump();
	expect(summary.truncated).toBe(true);
	expect(summary.actionableDiagnostics).toContain("src/check.ts:17: error: actionable failure");
	expect(summary.output).toContain("ACTIONABLE DIAGNOSTICS");
	expect(summary.output).toContain("src/check.ts:17: error: actionable failure");
});

test("summarized output has an explicit summarized disposition", async () => {
	const sink = new OutputSink({ spillThreshold: 64 });
	sink.replace("compact summary", { summarized: true });
	const summary = await sink.dump();
	expect(summary.outputDisposition).toBe("summarized");
	expect(summary.summarized).toBe(true);
});

test("collector failure with no retained bytes is explicitly unavailable", async () => {
	const sink = new OutputSink({
		spillThreshold: 0,
		artifactPath: "/dev/null/proto-output.log",
		artifactId: "missing",
	});
	sink.push("unavailable output");
	const summary = await sink.dump();
	expect(summary.collector?.state).toBe("failed");
	expect(summary.outputDisposition).toBe("unavailable");
});
