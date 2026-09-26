import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Tool as AiTool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { bunBackend } from "../eval/js";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { kernelLaneSessionId, resolveKernelLaneConfiguration } from "../eval/kernel-control";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { type BashResult, disposeBashSessions, executeBash } from "../exec/bash-executor";
import { withExecutionOrigin } from "../jobs/origin";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import {
	ContextTool,
	type ContextToolDetails,
	handleContextControl,
	type LaneControlResult,
	parseContextArgs,
} from "./context";
import { JobsTool } from "./jobs";
import { parseXdevCliArgs } from "./xdev-cli";

const sessions = new Set<string>();
afterEach(async () => {
	await Promise.all(
		[...sessions].flatMap(id => [
			disposeBashSessions(id),
			disposeKernelSessionsByOwner(id),
			disposeVmContextsByOwner(id),
		]),
	);
	sessions.clear();
});

async function createSession(cwd: string): Promise<ToolSession> {
	const id = `context-control:${crypto.randomUUID()}`;
	sessions.add(id);
	return {
		cwd,
		hasUI: false,
		settings: await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true }),
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getEvalKernelOwnerId: () => id,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function run(session: ToolSession, lane: string, command: string, onChunk?: (chunk: string) => void) {
	return executeBash(command, { cwd: session.cwd, sessionKey: session.getSessionId!()!, lane, onChunk });
}

/** Starts a command that blocks the lane and resolves once it is really executing. */
async function occupy(session: ToolSession, lane: string): Promise<{ result: Promise<BashResult> }> {
	const running = Promise.withResolvers<void>();
	const result = run(session, lane, "echo RUNNING; sleep 30", chunk => {
		if (chunk.includes("RUNNING")) running.resolve();
	});
	await Promise.race([
		running.promise,
		result.then(r => Promise.reject(new Error(`lane command ended: ${r.output}`))),
	]);
	// Wrapped: an async function returning the bare promise would wait for the command itself.
	return { result };
}

async function lane(session: ToolSession, args: Record<string, unknown>): Promise<LaneControlResult> {
	const result: ContextToolDetails = await handleContextControl(session, { resource: "lane", ...args });
	if (result.resource !== "lane") throw new Error("expected a lane result");
	return result;
}

async function within<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
	const gate = Promise.withResolvers<T>();
	// Bounds real shell/process teardown; fake time cannot advance an OS process.
	const timer = setTimeout(() => gate.reject(new Error("lane control did not settle")), timeoutMs);
	try {
		return await Promise.race([promise, gate.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("context argument validation", () => {
	test("rejects fields and operations that do not belong to the resource before any effect", () => {
		for (const args of [
			{ op: "list" },
			{ resource: "lanes", op: "list" },
			{ resource: "lane", op: "start", lane: "x" },
			{ resource: "lane", op: "keepalive", lane: "x" },
			{ resource: "lane", op: "reset" },
			{ resource: "lane", op: "list", lane: "x" },
			{ resource: "lane", op: "reset", lane: "x", force: true },
			{ resource: "lane", op: "inspect", lane: "x", language: "python" },
			{ resource: "lane", op: "close", lane: "x", ttlMs: 5 },
			{ resource: "lane", op: "close", lane: "x\n" },
		])
			expect(() => parseContextArgs(args)).toThrow();
	});

	test("XD CLI flags from the flat schema reach per-resource control", async () => {
		using temp = TempDir.createSync("@context-cli-");
		const session = await createSession(temp.path());
		const tool = new ContextTool(session);
		const schema = toolWireSchema(tool as unknown as AiTool) as Record<string, unknown>;
		const cli = (argv: string[]) => parseXdevCliArgs(schema, argv, { deviceName: "context" }).args;
		await run(session, "work", "true");
		const listed = await tool.execute("cli", cli(["--resource", "lane", "--op", "list"]) as never);
		expect(listed.details).toMatchObject({ resource: "lane", lanes: [{ lane: "work", state: "idle" }] });
		const closed = await tool.execute(
			"cli",
			cli(["--resource", "lane", "--op", "close", "--lane", "work", "--force"]) as never,
		);
		expect(closed.details).toMatchObject({ resource: "lane", closed: true });
		await expect(
			tool.execute(
				"cli",
				cli(["--resource", "lane", "--op", "inspect", "--lane", "work", "--language", "bun"]) as never,
			),
		).rejects.toThrow("language is not valid for resource lane");
	});

	test("kernel resource keeps kernel validation", async () => {
		using temp = TempDir.createSync("@context-kernel-validation-");
		const session = await createSession(temp.path());
		await expect(handleContextControl(session, { resource: "kernel", op: "start" })).rejects.toThrow(
			"language is required",
		);
		await expect(handleContextControl(session, { resource: "kernel", op: "list", force: true })).rejects.toThrow(
			"force is only valid for close",
		);
	});
});

describe("lane control", () => {
	test("reset reports active and queued async commands as cancelled jobs, not failures", async () => {
		using temp = TempDir.createSync("@context-async-reset-");
		const session = await createSession(temp.path());
		session.settings = Settings.isolated({ "async.enabled": true, "bash.autoBackground.enabled": false });
		const manager = new AsyncJobManager({});
		session.asyncJobManager = manager;
		const bash = new BashTool(session);
		const jobs = new JobsTool(session);
		const entered = Promise.withResolvers<void>();
		try {
			const active = await manager.withJobObserver(
				event => {
					if (event.kind === "progress" && event.text.includes("RUNNING")) entered.resolve();
				},
				() => bash.execute("active", { command: "echo RUNNING; sleep 30", lane: "work", async: true }),
			);
			await within(entered.promise);
			const queued = await bash.execute("queued", { command: "export QUEUED_RAN=yes", lane: "work", async: true });
			expect((await lane(session, { op: "inspect", lane: "work" })).lane).toMatchObject({
				state: "busy",
				queued: 1,
			});
			await within(lane(session, { op: "reset", lane: "work" }));
			for (const result of [active, queued]) {
				const id = result.details!.async!.jobId;
				await manager.getJob(id)!.promise;
				const inspected = await jobs.execute("inspect", { op: "inspect", target: { kind: "job", id } });
				expect(inspected.details?.jobs?.[0]).toMatchObject({ status: "cancelled", settled: true });
				expect(inspected.details?.jobs?.[0]?.errorText).toContain("lane work was reset");
			}
			expect((await run(session, "work", 'printf "[%s]" "$QUEUED_RAN"')).output).toBe("[]");
		} finally {
			await manager.dispose();
		}
	}, 15_000);
	test("reset cancels the running and pre-reset queued commands; later work runs on a fresh shell", async () => {
		using temp = TempDir.createSync("@context-lane-reset-");
		const session = await createSession(temp.path());
		const marker = path.join(temp.path(), "queued-ran");
		expect((await run(session, "work", "export LANE_STATE=kept")).exitCode).toBe(0);
		const { result: active } = await occupy(session, "work");
		const queued = run(session, "work", `touch '${marker}'`);
		expect((await lane(session, { op: "inspect", lane: "work" })).lane).toMatchObject({
			state: "busy",
			queued: 1,
			shell: "live",
		});

		const reset = lane(session, { op: "reset", lane: "work" });
		// Issued after the barrier went up: it waits for teardown and runs in the new generation,
		// which the reset notice (written only after the shells are discarded) proves.
		const later = run(session, "work", 'printf "[%s]" "$LANE_STATE"');
		const result = await within(reset);
		expect(result.cancelled).toEqual({ active: 1, queued: 1 });
		expect((await active).output).toContain("lane work was reset");
		expect((await queued).cancelled).toBe(true);
		const fresh = await within(later);
		expect(fresh.output).toBe("[]");
		expect(fresh.shellStateLost).toContain("lane work was reset by context control");
		expect(await Bun.file(marker).exists()).toBe(false);
	}, 30_000);

	test("a separate lane controls a busy target; the target lane cannot control itself", async () => {
		using temp = TempDir.createSync("@context-lane-origin-");
		const session = await createSession(temp.path());
		const { result: active } = await occupy(session, "work");
		for (const op of ["reset", "close"] as const)
			await expect(
				withExecutionOrigin({ lane: "work", kind: "shell" }, () =>
					lane(session, { op, lane: "work", ...(op === "close" ? { force: true } : {}) }),
				),
			).rejects.toThrow(`Cannot ${op} lane work`);
		// Rejection happened before side effects: the command still runs and holds the lane.
		expect((await lane(session, { op: "inspect", lane: "work" })).lane).toMatchObject({ state: "busy" });
		const closed = await within(
			withExecutionOrigin({ lane: "control", kind: "shell" }, () =>
				lane(session, { op: "close", lane: "work", force: true }),
			),
		);
		expect(closed.cancelled).toEqual({ active: 1, queued: 0 });
		expect((await active).output).toContain("lane work was closed");
	}, 30_000);

	test("close refuses a busy lane without force and forgets it; reset keeps kernel environments", async () => {
		using temp = TempDir.createSync("@context-lane-config-");
		const session = await createSession(temp.path());
		const cwd = path.join(temp.path(), "env");
		await fs.mkdir(cwd);
		const started = await handleContextControl(session, {
			resource: "kernel",
			op: "start",
			language: "bun",
			lane: "cfg",
			cwd,
		});
		if (started.resource !== "kernel") throw new Error("expected a kernel result");
		const execute = (code: string) =>
			bunBackend.execute(code, {
				cwd,
				runCwd: cwd,
				sessionId: kernelLaneSessionId(session, "cfg"),
				kernelOwnerId: session.getEvalKernelOwnerId!()!,
				sessionFile: undefined,
				session,
				reset: false,
				onChunk: () => {},
			});
		await execute("var marker = 7");
		const { result: active } = await occupy(session, "cfg");
		await expect(lane(session, { op: "close", lane: "cfg" })).rejects.toThrow("close requires force:true");
		expect((await lane(session, { op: "inspect", lane: "cfg" })).lane).toMatchObject({ state: "busy" });

		const reset = await within(lane(session, { op: "reset", lane: "cfg" }));
		expect((await active).cancelled).toBe(true);
		expect(reset.kernelsReleased?.map(kernel => kernel.generation)).toEqual([started.kernel!.generation]);
		expect(reset.retained).toEqual(["bun"]);
		expect(resolveKernelLaneConfiguration(session, "bun", "cfg")?.cwd).toBe(cwd);
		const after = (await lane(session, { op: "inspect", lane: "cfg" })).lane;
		expect(after).toMatchObject({ state: "idle", kernels: [], configured: ["bun"] });
		const probe = await execute("console.log(typeof marker, process.cwd(), kernelState().generation)");
		const [markerType, probeCwd, generation] = probe.output.trim().split(" ");
		expect([markerType, probeCwd]).toEqual(["undefined", cwd]);
		expect(generation).not.toBe(started.kernel?.generation);

		const closed = await within(lane(session, { op: "close", lane: "cfg" }));
		expect(closed.forgotten).toEqual(["bun"]);
		expect(resolveKernelLaneConfiguration(session, "bun", "cfg")).toBeUndefined();
		expect((await lane(session, { op: "list" })).lanes?.map(item => item.lane)).not.toContain("cfg");
	}, 40_000);

	test("lanes are owner-scoped", async () => {
		using temp = TempDir.createSync("@context-lane-owner-");
		const first = await createSession(temp.path());
		const second = await createSession(temp.path());
		await run(first, "work", "export OWNER_STATE=first");
		expect((await lane(second, { op: "list" })).lanes).toEqual([]);
		await expect(lane(second, { op: "reset", lane: "work" })).rejects.toThrow("Unknown lane: work");
		expect((await run(first, "work", 'printf "%s" "$OWNER_STATE"')).output).toBe("first");
		expect((await lane(first, { op: "list" })).lanes).toMatchObject([
			{ lane: "work", state: "idle", queued: 0, shell: "live" },
		]);
	}, 30_000);

	test("session disposal cancels queued lane work instead of leaving it waiting", async () => {
		using temp = TempDir.createSync("@context-lane-dispose-");
		const session = await createSession(temp.path());
		const { result: active } = await occupy(session, "work");
		const queued = run(session, "work", "true");
		await within(disposeBashSessions(session.getSessionId!()!));
		expect((await within(queued)).output).toContain("disposed session");
		expect((await within(active)).cancelled).toBe(true);
	}, 30_000);
});

test("a kernel cell cannot reset or close its own kernel; a shell command on the lane can", async () => {
	using temp = TempDir.createSync("@context-kernel-origin-");
	const session = await createSession(temp.path());
	const started = await handleContextControl(session, { resource: "kernel", op: "start", language: "bun" });
	if (started.resource !== "kernel") throw new Error("expected a kernel result");
	for (const op of ["reset", "close"] as const)
		await expect(
			withExecutionOrigin({ lane: "main", kind: "kernel", language: "bun" }, () =>
				handleContextControl(session, { resource: "kernel", op, language: "bun" }),
			),
		).rejects.toThrow(`Cannot ${op} the bun kernel of lane main`);
	const reset = await withExecutionOrigin({ lane: "main", kind: "shell" }, () =>
		handleContextControl(session, { resource: "kernel", op: "reset", language: "bun" }),
	);
	if (reset.resource !== "kernel") throw new Error("expected a kernel result");
	expect(reset.kernel?.generation).not.toBe(started.kernel?.generation);
}, 30_000);
