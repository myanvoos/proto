import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonRpcResult } from "./protocol";

interface ProbeResult {
	publishedAfterClose: number;
	cancelledStartPublished: boolean;
	stoppedAfterLastClose: boolean;
	parallelStreams: Extract<DaemonRpcResult, { op: "logs" }>[];
	historicalWait: Extract<DaemonRpcResult, { op: "wait" }>;
	recoveredWait: Extract<DaemonRpcResult, { op: "wait" }>;
	previousGenerationWait: Extract<DaemonRpcResult, { op: "wait" }>;
	recoveredPreviousGenerationWait: Extract<DaemonRpcResult, { op: "wait" }>;
}

test("parallel stream owners survive client churn, release the broker, and recover generation-scoped pattern waits", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-daemon-lifecycle-test-"));
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../../scripts/bench-daemon-memory.ts"),
				"--clients",
				"4",
				"--terminal",
				"1",
			],
			{
				env: { ...Bun.env, HOME: agentDir, PI_CODING_AGENT_DIR: path.join(agentDir, "agent") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Isolated daemon lifecycle failed: ${stderr}`);
		const result = JSON.parse(stdout) as ProbeResult;
		expect(result.publishedAfterClose).toBe(0);
		expect(result.cancelledStartPublished).toBe(false);
		expect(result.stoppedAfterLastClose).toBe(true);
		expect(result.parallelStreams).toHaveLength(4);
		for (const stream of result.parallelStreams) {
			expect(stream.state).toBe("ready");
			expect(stream.text).toContain("stream");
			expect(stream.cursor).toBeGreaterThan(0);
		}
		expect(result.historicalWait).toMatchObject({ matched: "DONE", timedOut: false });
		expect(result.recoveredWait).toMatchObject({ matched: "DONE", timedOut: false });
		expect(result.previousGenerationWait).toMatchObject({ timedOut: true });
		expect(result.previousGenerationWait.matched).toBeUndefined();
		expect(result.recoveredPreviousGenerationWait).toMatchObject({ timedOut: true });
		expect(result.recoveredPreviousGenerationWait.matched).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);
