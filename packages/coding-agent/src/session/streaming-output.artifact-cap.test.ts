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

	expect(sink.retainedBytes()).toBe(100);
	sink.release();
	expect(sink.retainedBytes()).toBe(0);

	// Releasing is opt-in and does not disable retention for later chunks.
	sink.push("late output");
	expect(sink.retainedBytes()).toBe(Buffer.byteLength("late output", "utf8"));
});
