import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime";
import type { ToolSession } from "../../src/tools";
import { OrchestrateWaitTool } from "../../src/tools/orchestrate";

const OWNER = "test-owner";
const WORKER = "test-worker";

interface TestTurn {
	jobId: string;
	complete: (text: string) => void;
}

let manager: AsyncJobManager;
let session: ToolSession;

function startTurn(options?: { onDelivery?: (jobId: string, text: string) => void }): TestTurn {
	const completion = Promise.withResolvers<string>();
	if (options?.onDelivery) manager.registerDeliverySink(OWNER, options.onDelivery);
	const jobId = manager.register(
		"worker",
		"test worker turn",
		async ({ signal }) => {
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(new Error("cancelled"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([completion.promise, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		{ ownerId: OWNER },
	);
	OrchestratorRuntime.global().registerRecordForTests({ id: WORKER, ownerId: OWNER, jobId });
	return { jobId, complete: completion.resolve };
}

beforeEach(() => {
	manager = new AsyncJobManager({});
	session = {
		getAgentId: () => OWNER,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
});

afterEach(async () => {
	vi.useRealTimers();
	await manager.dispose({ timeoutMs: 100 });
	OrchestratorRuntime.resetGlobalForTests();
});

describe("orchestrate_wait", () => {
	it("distinguishes timer expiry from a settled turn", async () => {
		vi.useFakeTimers();
		startTurn();
		const pending = OrchestratorRuntime.global().wait(session, { timeoutMs: 10 });
		vi.advanceTimersByTime(10);

		const outcome = await pending;

		expect(outcome).toMatchObject({ timedOut: true, settled: [], stillRunning: [WORKER] });
	});

	it("returns each settled turn exactly once", async () => {
		const turn = startTurn();
		const pending = OrchestratorRuntime.global().wait(session, { sessions: [WORKER], timeoutMs: 1_000 });
		turn.complete("worker result");

		const first = await pending;
		const second = await OrchestratorRuntime.global().wait(session, { sessions: [WORKER], timeoutMs: 1 });

		expect(first.settled).toEqual([
			{ id: WORKER, jobId: turn.jobId, status: "completed", resultText: "worker result" },
		]);
		expect(second.settled).toEqual([]);
	});

	it("restores async delivery after an interrupted wait", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const turn = startTurn({ onDelivery: (jobId, text) => deliveries.push({ jobId, text }) });
		const controller = new AbortController();
		const pending = OrchestratorRuntime.global().wait(session, {
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		controller.abort();
		expect((await pending).timedOut).toBe(false);

		turn.complete("delivered later");
		await manager.getJob(turn.jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		expect(deliveries).toEqual([{ jobId: turn.jobId, text: "delivered later" }]);
	});

	it("renders an interrupted wait as still running rather than timed out", async () => {
		startTurn();
		const controller = new AbortController();
		controller.abort();

		const result = await new OrchestrateWaitTool(session).execute("wait-call", { timeout: 900 }, controller.signal);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details?.wait?.timedOut).toBe(false);
		expect(text).toContain("Still running");
		expect(text).not.toContain("Wait window elapsed");
	});
});
