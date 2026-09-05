import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

test("oversized diagnostic lines are skipped until their newline", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const oversized = `${"x".repeat(16 * 1024)} error: hidden tail`;
	const valid = "src/next.ts:8: error: retained diagnostic";

	sink.push(oversized.slice(0, 4096));
	sink.push(oversized.slice(4096));
	sink.push(`\n${valid}\n`);
	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([valid]);
	expect(summary.output).toContain(valid);
	expect(summary.output).not.toContain("hidden tail");
});

test("diagnostic byte limits stay UTF-8 correct across chunks", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const line = `error: ${"😀".repeat((16 * 1024 - 1 - 7) / 4)}`;
	const oneByteOver = `${line}x`;
	const chunkBoundary = "error: ".length + 2_000 * 2;

	expect(Buffer.byteLength(line, "utf-8")).toBe(16 * 1024 - 1);
	expect(Buffer.byteLength(oneByteOver, "utf-8")).toBe(16 * 1024);
	sink.push(line.slice(0, -2));
	sink.push(line.slice(-2));
	sink.push("\n");
	sink.push(oneByteOver.slice(0, chunkBoundary));
	sink.push(oneByteOver.slice(chunkBoundary));
	sink.push("\n");
	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([line]);
});

test("replace resets pending and oversized diagnostic state", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	sink.push(`${"x".repeat(16 * 1024)} error: stale tail`);
	sink.replace("replacement");
	sink.push("src/fresh.ts:3: error: fresh diagnostic\n");

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual(["src/fresh.ts:3: error: fresh diagnostic"]);
	expect(summary.output).not.toContain("stale tail");
});

test("complete diagnostics are deduplicated while retained", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const retained = "error: retained diagnostic";
	sink.push(`${retained}\n${retained}\n`);

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([retained]);
});

test("complete diagnostics stay within the FIFO byte budget", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const first = `error: ${"a".repeat(12_000)}`;
	const second = `warning: ${"b".repeat(7_000)}`;
	sink.push(`${first}\n${second}\n`);

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([second]);
});

test("diagnostic collection leaves raw artifact bytes unchanged", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-artifact-"));
	const artifactPath = path.join(directory, "raw-output.log");
	const oversized = `${"😀".repeat(9_000)} error: hidden artifact tail`;
	const valid = "src/subsequent.ts:4: error: retained artifact diagnostic";
	const raw = `${oversized}\n${valid}\n`;

	try {
		const sink = new OutputSink({ artifactPath, artifactId: "raw-output", spillThreshold: 1 });
		sink.push(oversized);
		sink.push(`\n${valid}\n`);
		const summary = await sink.dump();

		expect(summary.actionableDiagnostics).toEqual([valid]);
		expect(await fs.readFile(artifactPath, "utf8")).toBe(raw);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
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
