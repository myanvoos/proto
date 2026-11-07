import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { type AsyncJobEvent, AsyncJobManager } from "../../async";
import { Settings } from "../../config/settings";
import { IrcBus } from "../../irc/bus";
import { OrchestratorRuntime } from "../../orchestrator/runtime";
import { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import { type JobsParams, type JobsResult, JobsTool } from ".";

const FLEET_ROOT = "/jobs-test/fleet";
const OWNER = "jobs-owner";
const managers: AsyncJobManager[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 3_000 });
	OrchestratorRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

interface Harness {
	manager: AsyncJobManager;
	jobs: JobsTool;
	delivered: string[];
	events: AsyncJobEvent[];
	run(params: JobsParams, signal?: AbortSignal): Promise<JobsResult>;
}

function harness(
	options: { ownerId?: string; manager?: AsyncJobManager; messaging?: boolean; failFirstDelivery?: boolean } = {},
): Harness {
	const manager = options.manager ?? new AsyncJobManager({ retentionMs: 60_000 });
	if (!options.manager) managers.push(manager);
	const ownerId = options.ownerId ?? OWNER;
	const delivered: string[] = [];
	const events: AsyncJobEvent[] = [];
	let failed = !options.failFirstDelivery;
	cleanups.push(
		manager.registerDeliverySink(ownerId, (jobId, _text, _job, event) => {
			if (!failed) {
				failed = true;
				throw new Error("sink not ready");
			}
			if (event) events.push(event);
			else delivered.push(jobId);
		}),
	);
	const session = {
		cwd: os.tmpdir(),
		settings: Settings.isolated({ "launch.enabled": false }),
		getSessionFile: () => null,
		getSessionId: () => ownerId,
		getAsyncJobOwnerId: () => ownerId,
		asyncJobManager: manager,
		...(options.messaging
			? { getAgentId: () => "Main", getAgentFleetRoot: () => FLEET_ROOT, agentRegistry: AgentRegistry.global() }
			: {}),
	} as unknown as ToolSession;
	const jobs = new JobsTool(session);
	return { manager, jobs, delivered, events, run: (params, signal) => jobs.execute("call", params, signal) };
}

function text(result: JobsResult): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/** The progress reminder an elapsed wait appends after its own report, if any. */
function notice(result: JobsResult): string | undefined {
	return result.content.slice(1).find(part => part.type === "text")?.text;
}

/** Runs one wait that elapses with nothing new, advancing fake timers by its window. */
async function elapseWait(run: Harness["run"], windowMs: number): Promise<JobsResult> {
	const waiting = run({ op: "wait" });
	vi.advanceTimersByTime(windowMs);
	return waiting;
}

function pendingJob(
	manager: AsyncJobManager,
	type: "bash" | "worker" = "bash",
	options: { id?: string; agentId?: string; ownerId?: string } = {},
) {
	const finish = Promise.withResolvers<string>();
	const id = manager.register(type, `${type} job`, async () => finish.promise, {
		ownerId: options.ownerId ?? OWNER,
		...options,
	});
	return { id, finish };
}

function monitorJob(manager: AsyncJobManager, ownerId = OWNER) {
	const finish = Promise.withResolvers<string>();
	let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
	const id = manager.register(
		"monitor",
		"watch",
		async ({ emitEvent }) => {
			emit = emitEvent;
			return finish.promise;
		},
		{ ownerId },
	);
	return { id, finish, emit: (value: string) => emit("output", value) };
}

test("running worker snapshots match progress by agent identity and show finite live metrics", async () => {
	const { manager, run } = harness();
	const job = pendingJob(manager, "worker", { agentId: "worker-a", id: "worker-a-t2" });
	try {
		manager.getJob(job.id)!.latestDetails = {
			progress: [
				{ id: "different-worker", resolvedModel: "wrong", requests: 99 },
				{
					id: "worker-a",
					resolvedModel: "test/model",
					requests: 12,
					cost: 0.25,
					contextTokens: 160_000,
					contextWindow: 1_000_000,
					currentTool: "read",
					invalid: Number.NaN,
				},
			],
		};
		const running = await run({ op: "inspect", target: { kind: "job", id: job.id } });
		expect(running.details?.jobs?.[0]).toMatchObject({
			resolvedModel: "test/model",
			progress: { requests: 12, cost: 0.25, contextTokens: 160_000, contextWindow: 1_000_000, stage: "read" },
		});
		expect(text(running)).toContain("12 req");
		expect(text(running)).toContain("$0.25");
		expect(text(running)).not.toContain("99 req");
		job.finish.resolve("finished");
		await manager.getJob(job.id)!.promise;
		const settled = await run({ op: "inspect", target: { kind: "job", id: job.id } });
		expect(settled.details?.jobs?.[0]?.progress).toBeUndefined();
	} finally {
		job.finish.resolve("done");
	}
});

test("list observes a settled job without consuming its automatic delivery", async () => {
	const { manager, run, delivered } = harness({ failFirstDelivery: true });
	const job = pendingJob(manager);
	job.finish.resolve("done");
	await manager.getJob(job.id)!.promise;
	const listed = await run({ op: "list", kind: "job" });
	expect(listed.details?.jobs?.map(snapshot => snapshot.ref)).toEqual([{ kind: "job", id: job.id }]);
	expect(manager.isDeliverySuppressed(job.id)).toBe(false);
	// The first delivery attempt failed; its retry must still arrive after the snapshot.
	await manager.drainDeliveries({ timeoutMs: 5_000 });
	expect(delivered).toEqual([job.id]);
});

test("a wait woken by one job collects a sibling that settles within the settle window", async () => {
	const { manager, run } = harness();
	const first = pendingJob(manager);
	const second = pendingJob(manager);
	const waiting = run({
		op: "wait",
		targets: [
			{ kind: "job", id: first.id },
			{ kind: "job", id: second.id },
		],
		timeoutMs: 5_000,
	});
	first.finish.resolve("first done");
	await Bun.sleep(20);
	second.finish.resolve("second done");
	const result = await waiting;
	expect(result.details?.jobs?.map(job => job.ref.id)).toEqual([first.id, second.id]);
	expect(result.details?.jobs?.every(job => job.status === "completed")).toBe(true);
});

test("back-to-back idle waits climb the smart ladder and remind the agent to work from the 10s rung", async () => {
	vi.useFakeTimers();
	const { manager, run } = harness();
	const job = pendingJob(manager);
	try {
		const first = await elapseWait(run, 5_000);
		expect(first.details?.timedOut).toBe(true);
		expect(notice(first)).toBeUndefined();

		const second = await elapseWait(run, 10_000);
		expect(notice(second)).toContain("15.0s");

		const third = await elapseWait(run, 30_000);
		expect(notice(third)).toContain("45.0s");

		// News resets the ladder: a completed job returns at once, and the next idle wait starts at 5s.
		const done = pendingJob(manager);
		done.finish.resolve("done");
		await manager.getJob(done.id)!.promise;
		await run({ op: "wait", targets: [{ kind: "job", id: done.id }] });
		const restarted = await elapseWait(run, 5_000);
		expect(restarted.details?.timedOut).toBe(true);
		expect(notice(restarted)).toBeUndefined();
	} finally {
		job.finish.resolve("done");
		vi.useRealTimers();
	}
});

test("a mailbox-only reply wait uses the same smart ladder and reminder", async () => {
	vi.useFakeTimers();
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		label: "Main",
		kind: "main",
		session: null,
		fleetRoot: FLEET_ROOT,
		status: "idle",
	});
	registry.register({
		id: "peer",
		label: "peer",
		kind: "sub",
		parentId: "Main",
		session: null,
		fleetRoot: FLEET_ROOT,
		status: "idle",
	});
	const { run } = harness({ messaging: true });
	try {
		const first = await elapseWait(run, 5_000);
		expect(first.details?.timedOut).toBe(true);
		expect(notice(first)).toBeUndefined();

		const second = await elapseWait(run, 10_000);
		expect(notice(second)).toContain("15.0s");
	} finally {
		vi.useRealTimers();
	}
});

test("a wait consumes its winning job once so automatic delivery never repeats it", async () => {
	const { manager, run, delivered } = harness();
	const job = pendingJob(manager);
	const waiting = run({ op: "wait", targets: [{ kind: "job", id: job.id }], timeoutMs: 5_000 });
	job.finish.resolve("finished output");
	const result = await waiting;
	expect(result.details?.jobs).toMatchObject([
		{ ref: { kind: "job", id: job.id }, status: "completed", settled: true },
	]);
	expect(text(result)).toContain("finished output");
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	expect(delivered).toEqual([]);
});

test("a message and a job settling together are each reported exactly once", async () => {
	const registry = AgentRegistry.global();
	registry.register({ id: "Main", label: "Main", kind: "main", session: null, fleetRoot: FLEET_ROOT, status: "idle" });
	registry.register({
		id: "peer",
		label: "peer",
		kind: "sub",
		parentId: "Main",
		session: null,
		fleetRoot: FLEET_ROOT,
		status: "running",
	});
	const { manager, run, delivered } = harness({ messaging: true });
	const job = pendingJob(manager);
	const waiting = run({ op: "wait", targets: [{ kind: "job", id: job.id }], mailbox: {}, timeoutMs: 5_000 });
	await Bun.sleep(0);
	job.finish.resolve("photo finish");
	await IrcBus.global().send({ from: "peer", to: "Main", body: "hello" }, { fleetRoot: FLEET_ROOT });
	const result = await waiting;
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	const jobReports =
		(result.details?.jobs?.some(snapshot => snapshot.ref.id === job.id && snapshot.status === "completed") &&
		!result.details?.messages?.length
			? 1
			: 0) + delivered.filter(id => id === job.id).length;
	const messageReports =
		(result.details?.messages?.some(message => message.body === "hello") ? 1 : 0) +
		IrcBus.global()
			.inbox("Main", { fleetRoot: FLEET_ROOT })
			.filter(message => message.body === "hello").length;
	expect(jobReports).toBe(1);
	expect(messageReports).toBe(1);
});

test("an interrupted wait consumes nothing and leaves the watch event for automatic delivery", async () => {
	const { manager, run, events } = harness();
	const watch = monitorJob(manager);
	const abort = new AbortController();
	const waiting = run({ op: "wait", targets: [{ kind: "watch", id: watch.id }], timeoutMs: 5_000 }, abort.signal);
	watch.emit("preserve during steering");
	abort.abort();
	const result = await waiting;
	expect(result.details?.jobs?.[0]?.events).toBeUndefined();
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	expect(events.map(event => event.text)).toEqual(["preserve during steering"]);
	watch.finish.resolve("done");
});

test("foreign and mistyped references fail without touching the other owner's work", async () => {
	const { manager, run } = harness();
	const foreign = pendingJob(manager, "bash", { ownerId: "someone-else" });
	const own = monitorJob(manager);
	for (const params of [
		{ op: "cancel", target: { kind: "job", id: foreign.id } },
		{ op: "inspect", target: { kind: "job", id: foreign.id } },
		{ op: "wait", targets: [{ kind: "job", id: foreign.id }], timeoutMs: 5_000 },
		// A watch addressed as a job is a different reference, not a guess.
		{ op: "inspect", target: { kind: "job", id: own.id } },
	] satisfies JobsParams[]) {
		const result = await run(params);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("No owned");
	}
	expect(manager.getJob(foreign.id)?.status).toBe("running");
	const listed = await run({ op: "list" });
	expect(listed.details?.jobs?.map(snapshot => snapshot.ref.id)).toEqual([own.id]);
	foreign.finish.resolve("done");
	own.finish.resolve("done");
});

test("per-op validation rejects irrelevant fields and wrong reference kinds before side effects", async () => {
	const { manager, run } = harness();
	const job = pendingJob(manager);
	const watch = monitorJob(manager);
	const rejected: [JobsParams, RegExp][] = [
		[{ op: "cancel", target: { kind: "job", id: job.id }, command: "true" }, /does not accept command/],
		[{ op: "cancel", target: { kind: "watch", id: watch.id } }, /unwatch/],
		[{ op: "unwatch", target: { kind: "job", id: job.id } }, /cancel/],
		[{ op: "watch", command: "true", source: { kind: "job", id: job.id } }, /exactly one/],
		[{ op: "logs", target: { kind: "process", id: "p" } }, /requires name/],
		[{ op: "wait", targets: [] }, /must not be empty/],
	];
	for (const [params, message] of rejected) {
		const result = await run(params);
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(message);
	}
	expect(manager.getJob(job.id)?.status).toBe("running");
	expect(manager.getJob(watch.id)?.status).toBe("running");
	expect(manager.getAllJobs()).toHaveLength(2);
	job.finish.resolve("done");
	watch.finish.resolve("done");
});

test("cancelling a worker turn never terminates the agent, and an agent id is not a job reference", async () => {
	const registry = AgentRegistry.global();
	registry.register({
		id: "worker-a",
		label: "A",
		kind: "sub",
		parentId: "Main",
		session: null,
		fleetRoot: FLEET_ROOT,
		status: "running",
	});
	const { manager, run } = harness();
	const turn = manager.register(
		"worker",
		"turn",
		({ signal }) =>
			new Promise<string>((_, reject) =>
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			),
		{ id: "worker-a-t1", agentId: "worker-a", ownerId: OWNER },
	);
	const byAgent = await run({ op: "cancel", target: { kind: "job", id: "worker-a" } });
	expect(byAgent.isError).toBe(true);
	expect(manager.getJob(turn)?.status).toBe("running");

	const cancelled = await run({ op: "cancel", target: { kind: "job", id: turn } });
	expect(cancelled.details?.receipt).toMatchObject({ ref: { kind: "job", id: turn }, status: "settled" });
	expect(manager.getJob(turn)?.status).toBe("cancelled");
	expect(registry.get("worker-a")?.status).toBe("running");
});

test("inspect pages retained watch events without consuming them and reports expired sequences", async () => {
	const { manager, run, events } = harness();
	const watch = monitorJob(manager);
	manager.watchJobs([watch.id]);
	for (let i = 1; i <= 70; i++) watch.emit(`event ${i}`);
	const page = await run({ op: "inspect", target: { kind: "watch", id: watch.id }, afterEvent: 2 });
	expect(page.details?.events?.gap).toEqual({ from: 3, to: 6 });
	expect(page.details?.events?.events[0]?.sequence).toBe(7);
	const later = await run({ op: "inspect", target: { kind: "watch", id: watch.id }, afterEvent: 69 });
	expect(later.details?.events?.events.map(event => event.text)).toEqual(["event 70"]);
	expect(later.details?.events?.gap).toBeUndefined();
	manager.unwatchJobs([watch.id]);
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	expect(events.length).toBeGreaterThan(0);
	expect(events.at(-1)?.text).toBe("event 70");
	watch.finish.resolve("done");
});

test("a job-source watch reports progress lines and unwatch leaves the job and its delivery intact", async () => {
	const { manager, run, delivered } = harness();
	const finish = Promise.withResolvers<string>();
	let report: (text: string) => Promise<void> = async () => {};
	const id = manager.register(
		"bash",
		"build",
		async ({ reportProgress }) => {
			report = text => reportProgress(text);
			return finish.promise;
		},
		{ ownerId: OWNER },
	);
	const started = await run({ op: "watch", source: { kind: "job", id }, match: "error" });
	const watchRef = started.details?.ref;
	expect(watchRef?.kind).toBe("watch");
	const waiting = run({ op: "wait", targets: [watchRef!], timeoutMs: 5_000 });
	await report("compiling\n");
	await report("compiling\nerror: missing semicolon\n");
	const woke = await waiting;
	expect(woke.details?.jobs?.[0]?.events?.map(event => event.text)).toEqual(["error: missing semicolon"]);

	const stopped = await run({ op: "unwatch", target: watchRef! });
	expect(stopped.details?.receipt?.status).toBe("settled");
	expect(manager.getJob(id)?.status).toBe("running");
	finish.resolve("build ok");
	await manager.getJob(id)!.promise;
	await manager.drainDeliveries({ timeoutMs: 1_000 });
	expect(delivered).toEqual([id]);
});

test("unwatching a command probe reaps its helper process", async () => {
	const { run } = harness();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-jobs-probe-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const pidFile = path.join(dir, "pid");
	const started = await run({
		op: "watch",
		command: `printf '%s' "$$" > "${pidFile}"; echo READY; exec sleep 30`,
		match: "READY",
	});
	const ref = started.details!.ref!;
	await run({ op: "wait", targets: [ref], timeoutMs: 5_000 });
	const pid = Number(fs.readFileSync(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).not.toThrow();
	const stopped = await run({ op: "unwatch", target: ref });
	expect(stopped.details?.receipt?.status).toBe("settled");
	expect(() => process.kill(pid, 0)).toThrow();
});

test("an already interrupted empty wait is not reported as idle or useless", async () => {
	const { run } = harness();
	const controller = new AbortController();
	controller.abort();
	const result = await run({ op: "wait" }, controller.signal);
	expect(result.useless).not.toBe(true);
	expect(text(result)).toContain("Wait interrupted");
	expect(result.details?.timedOut).not.toBe(true);
});

test("only tool-interrupt wakeups may drain a queued watch event after their signal is aborted", async () => {
	for (const toolInterrupt of [false, true]) {
		const { manager, run, events } = harness();
		const watch = monitorJob(manager);
		watch.emit("queued wake");
		const abort = new AbortController();
		abort.abort(toolInterrupt ? TOOL_INTERRUPT_ABORT_REASON : new Error("user cancelled"));
		const result = await run({ op: "wait", targets: [{ kind: "watch", id: watch.id }] }, abort.signal);
		if (toolInterrupt) {
			expect(result.details?.jobs?.[0]?.events?.map(event => event.text)).toEqual(["queued wake"]);
		} else {
			expect(text(result)).toContain("Wait interrupted");
		}
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(events.map(event => event.text)).toEqual(toolInterrupt ? [] : ["queued wake"]);
		watch.finish.resolve("done");
	}
});
