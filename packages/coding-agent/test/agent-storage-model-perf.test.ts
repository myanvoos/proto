import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

const MODEL_PERF_FLUSH_DELAY_MS = 100;

async function flushPerf(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(MODEL_PERF_FLUSH_DELAY_MS);
	await Promise.all(writes);
}
describe("AgentStorage model perf aggregates", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		AgentStorage.resetInstance();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	async function openStorage(): Promise<AgentStorage> {
		tempDir = TempDir.createSync("@proto-agent-storage-perf-");
		return AgentStorage.open(path.join(tempDir.path(), "agent.db"));
	}

	it("averages TPS over total request duration and TTFT over reporting samples", async () => {
		const storage = await openStorage();

		// 1000 tokens over 6000ms + 500 tokens over 3000ms → 1500 tokens / 9s → 166.67 t/s
		// Back-to-back samples join one deferred batch; awaiting the shared flush
		// promise makes both visible.
		const first = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 1000,
			durationMs: 6000,
			ttftMs: 1000,
		});
		const second = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 500,
			durationMs: 3000,
			ttftMs: 500,
		});
		await flushPerf(first, second);

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats).toBeDefined();
		expect(stats?.samples).toBe(2);
		expect(stats?.tps).toBeCloseTo(1500000 / 9000, 5);
		expect(stats?.ttftMs).toBeCloseTo(750, 5);
	});

	it("records worker samples in the shared model performance aggregate", async () => {
		tempDir = TempDir.createSync("@proto-subagent-perf-");
		const parent = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const subagent = createSubagentSettings(parent);

		const write = subagent.getStorage()!.recordModelPerf("opencode-go/deepseek-v4-flash", {
			outputTokens: 130,
			durationMs: 2989.23775,
			ttftMs: 2324.873,
		});
		await flushPerf(write);

		const stats = parent.getStorage()?.getModelPerf().get("opencode-go/deepseek-v4-flash");
		expect(stats?.samples).toBe(1);
		expect(stats?.tps).toBeCloseTo(130000 / 2989.23775, 5);
		expect(stats?.ttftMs).toBeCloseTo(2324.873, 5);
	});

	it("keeps TTFT null when no sample reported one and uses full duration for TPS", async () => {
		const storage = await openStorage();

		// No ttft → 1000 tokens / 4s → 250 t/s
		const write = storage.recordModelPerf("zai/glm-5", { outputTokens: 1000, durationMs: 4000 });
		await flushPerf(write);

		const stats = storage.getModelPerf().get("zai/glm-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("reports identical TPS regardless of TTFT (hidden-reasoning regression)", async () => {
		const storage = await openStorage();

		// Same duration and token count, wildly different TTFT: a provider that
		// hides reasoning until late (ttft ~ duration) must not report inflated
		// throughput vs one that streams from the start.
		const hiddenWrite = storage.recordModelPerf("google/gemini", {
			outputTokens: 1020,
			durationMs: 7000,
			ttftMs: 5700,
		});
		const streamedWrite = storage.recordModelPerf("google-vertex/gemini", {
			outputTokens: 1020,
			durationMs: 7000,
			ttftMs: 1700,
		});
		await flushPerf(hiddenWrite, streamedWrite);

		const hidden = storage.getModelPerf().get("google/gemini");
		const streamed = storage.getModelPerf().get("google-vertex/gemini");
		expect(hidden?.tps).toBeCloseTo(1020000 / 7000, 5);
		expect(streamed?.tps).toBeCloseTo(1020000 / 7000, 5);
	});

	it("drops unmeasurable samples instead of polluting the aggregates", async () => {
		const storage = await openStorage();

		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 0, durationMs: 4000 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 100, durationMs: 0 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: Number.NaN, durationMs: 4000 });

		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);
	});

	it("ignores out-of-range TTFT but keeps the throughput sample", async () => {
		const storage = await openStorage();

		// ttft >= duration is bogus latency data; the sample still measures TPS.
		const write = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 1000,
			durationMs: 4000,
			ttftMs: 5000,
		});
		await flushPerf(write);

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("defers the write off the record path and lands it once the flush promise resolves", async () => {
		const storage = await openStorage();

		const flushed = storage.recordModelPerf("openai/gpt-5", { outputTokens: 1000, durationMs: 4000 });
		// Recording is deferred: nothing is visible before the batch flushes.
		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);

		await flushPerf(flushed);
		expect(storage.getModelPerf().get("openai/gpt-5")?.tps).toBeCloseTo(250, 5);
	});
});
