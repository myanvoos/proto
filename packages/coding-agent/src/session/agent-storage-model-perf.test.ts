import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// AgentStorage.close is process-wide: exercise a dedicated process instead of closing other tests' stores.
test("standard model performance excludes priority and ultrafast serving paths", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-perf-tiers-"));
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
			import { AgentStorage } from ${JSON.stringify(path.join(import.meta.dir, "agent-storage.ts"))};
			const storage = await AgentStorage.open(${JSON.stringify(path.join(dir, "agent.db"))});
			await Promise.all([
				storage.recordModelPerf("openai/model", { outputTokens: 100, durationMs: 4000 }),
				storage.recordModelPerf("openai/model", { outputTokens: 100, durationMs: 4000 }, "default"),
				storage.recordModelPerf("openai/model", { outputTokens: 100, durationMs: 4000 }, "auto"),
				storage.recordModelPerf("openai/model", { outputTokens: 3000, durationMs: 10000 }, "ultrafast"),
				storage.recordModelPerf("openai/model", { outputTokens: 1000, durationMs: 10000 }, "priority"),
			]);
			console.log(JSON.stringify(Object.fromEntries(storage.getModelPerf())));
			AgentStorage.close();
		`,
			],
			{ cwd: path.resolve(import.meta.dir, "../../../.."), stdout: "pipe", stderr: "pipe" },
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		const rows = JSON.parse(stdout) as Record<string, { samples: number; tps: number }>;
		expect(rows["openai/model"]).toMatchObject({ samples: 3, tps: 25 });
		expect(rows["openai/model@ultrafast"]).toMatchObject({ samples: 1, tps: 300 });
		expect(rows["openai/model@priority"]).toMatchObject({ samples: 1, tps: 100 });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
