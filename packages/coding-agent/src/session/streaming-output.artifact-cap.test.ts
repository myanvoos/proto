import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "./streaming-output";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("OutputSink artifact spill bounds", () => {
	test("default artifact cap keeps noisy output bounded and marks omitted bytes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-default-cap-"));
		temporaryDirectories.push(directory);
		const artifactPath = path.join(directory, "output.log");
		const sink = new OutputSink({ artifactPath, artifactId: "output", spillThreshold: 128, headBytes: 32 });
		const repeated = "x".repeat(64 * 1024);

		for (let index = 0; index < 80; index++) sink.push(repeated);
		const summary = await sink.dump();
		const artifact = await Bun.file(artifactPath).text();

		expect(summary.truncated).toBe(true);
		expect(summary.outputBytes).toBeLessThanOrEqual(128 + 256);
		expect(artifact).toContain("[ARTIFACT TRUNCATED:");
		expect(artifact).toContain("elided from the middle]");
		expect(Buffer.byteLength(artifact, "utf8")).toBeLessThan(4 * 1024 * 1024 + 256);
		expect(artifact.startsWith("x".repeat(32))).toBe(true);
		expect(artifact.endsWith("x".repeat(4 * 1024 * 1024 - 3 * 1024 * 1024))).toBe(true);
	});
});

test("retained byte accounting includes the head and tail windows and release frees them", () => {
	const sink = new OutputSink({ spillThreshold: 100, headBytes: 20 });
	sink.push("a".repeat(200));

	expect(sink.retainedBytes()).toBe(300); // inline window plus pending diagnostic line
	sink.release();
	expect(sink.retainedBytes()).toBe(0);

	// Releasing is opt-in and does not disable retention for later chunks.
	sink.push("late output");
	expect(sink.retainedBytes()).toBe(2 * Buffer.byteLength("late output", "utf8"));
});

test("artifact-tail bytes are accounted before finalization and released after finalization", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-release-"));
	temporaryDirectories.push(directory);
	const artifactPath = path.join(directory, "output.log");
	const sink = new OutputSink({ artifactPath, spillThreshold: 128, maxColumns: 64 });
	sink.push(`first:${"x".repeat(5 * 1024 * 1024)}:last`);
	expect(sink.retainedBytes()).toBeGreaterThanOrEqual(1024 * 1024);
	// Releasing a live consumer must not discard the artifact's unwritten tail.
	sink.release();
	expect(sink.retainedBytes()).toBe(1024 * 1024);
	sink.push("\nlate-output");
	await sink.dump();
	await sink.dispose();
	sink.release();
	expect(sink.retainedBytes()).toBe(0);
	const artifact = await Bun.file(artifactPath).text();
	expect(artifact.startsWith("first:")).toBe(true);
	expect(artifact.endsWith(":last\nlate-output")).toBe(true);
	expect(artifact).toContain("ARTIFACT TRUNCATED");
});

test("consumer release racing finalization cannot erase the pending artifact tail", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-finalizing-"));
	temporaryDirectories.push(directory);
	const artifactPath = path.join(directory, "output.log");
	const sink = new OutputSink({ artifactPath, spillThreshold: 128 });
	sink.push(`${"x".repeat(5 * 1024 * 1024)}FINAL-TAIL`);
	const dumped = sink.dump();
	sink.release();
	await dumped;
	expect((await Bun.file(artifactPath).text()).endsWith("FINAL-TAIL")).toBe(true);
	expect(sink.retainedBytes()).toBe(0);
});
