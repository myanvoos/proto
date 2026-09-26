import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { AsyncJobManager } from "../async/job-manager";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import {
	disposeSessionExecutionEvents,
	type ExecutionEvent,
	type ExecutionEventCancellation,
	type ExecutionEventHandle,
	type ExecutionEventPage,
	runExecutionEvents,
} from "./execution-events";

const ok: AgentToolResult = { content: [{ type: "text", text: "finished" }] };

function sessionWith(execute: AgentTool["execute"], manager?: AsyncJobManager): ToolSession {
	const tool = {
		name: "fixture",
		label: "fixture",
		description: "",
		parameters: { type: "object", properties: {} },
		execute,
	};
	return {
		asyncJobManager: manager,
		getToolByName: (name: string) => (name === "fixture" ? tool : undefined),
	} as unknown as ToolSession;
}

async function start(
	session: ToolSession,
	signal?: AbortSignal,
	tool = "fixture",
	args = {},
): Promise<ExecutionEventHandle> {
	return (await runExecutionEvents({ op: "events_start", tool, args }, { session, signal })) as ExecutionEventHandle;
}

async function read(
	session: ToolSession,
	id: string,
	cursor = 0,
	limit = 128,
	waitMs = 0,
	signal?: AbortSignal,
): Promise<ExecutionEventPage> {
	return (await runExecutionEvents(
		{ op: "events_read", id, cursor, limit, waitMs },
		{ session, signal },
	)) as ExecutionEventPage;
}

async function drain(session: ToolSession, handle: ExecutionEventHandle): Promise<ExecutionEvent[]> {
	const events: ExecutionEvent[] = [];
	let cursor = handle.cursor;
	for (let attempts = 0; attempts < 20; attempts++) {
		const page = await read(session, handle.id, cursor, 128, 1000);
		events.push(...page.events);
		cursor = page.cursor;
		if (page.done) return events;
	}
	throw new Error("Execution failed to settle");
}

test("subscribers receive tool progress before the tool finishes and can react to release it", async () => {
	const finish = Promise.withResolvers<void>();
	const session = sessionWith(async (_id, _args, _signal, onUpdate) => {
		onUpdate?.({ content: [{ type: "text", text: "ready for consumer" }] });
		await finish.promise;
		return ok;
	});
	try {
		const handle = await start(session);
		const before = await read(session, handle.id);
		expect(before.done).toBe(false);
		expect(
			before.events.some(
				event => event.kind === "update" && JSON.stringify(event.data).includes("ready for consumer"),
			),
		).toBe(true);
		expect(before.events.some(event => event.kind === "result" || event.terminal)).toBe(false);
		const waiting = read(session, handle.id, before.cursor, 128, 1000);
		finish.resolve();
		const after = await waiting;
		expect(after.events.map(event => event.kind)).toEqual(["result", "complete"]);
		expect(after.done).toBe(true);
		expect(after.status).toBe("completed");
	} finally {
		finish.resolve();
		await disposeSessionExecutionEvents(session);
	}
});

test("cursor replay reports exact dropped prefix and paginated reads retain the terminal result", async () => {
	const finish = Promise.withResolvers<void>();
	let emit: AgentToolUpdateCallback | undefined;
	const session = sessionWith(async (_id, _args, _signal, onUpdate) => {
		emit = onUpdate;
		await finish.promise;
		return ok;
	});
	try {
		const handle = await start(session);
		for (let index = 0; index < 300; index++) emit?.({ content: [{ type: "text", text: `update ${index}` }] });
		const first = await read(session, handle.id, 0, 1);
		expect(first.gap).toEqual({ from: 1, to: 173, count: 173 });
		expect(first.events[0].sequence).toBe(174);
		expect(first.done).toBe(false);
		expect(await read(session, handle.id, 0, 1)).toEqual(first);
		finish.resolve();
		await drain(session, handle);
		let cursor = 0;
		let last: ExecutionEventPage;
		const kinds: string[] = [];
		do {
			last = await read(session, handle.id, cursor, 1);
			kinds.push(...last.events.map(event => event.kind));
			cursor = last.cursor;
			if (last.events[0]?.kind === "result") expect(last.done).toBe(false);
		} while (!last.done);
		expect(kinds.slice(-2)).toEqual(["result", "complete"]);
		expect((await read(session, handle.id, cursor - 2)).events.map(event => event.kind)).toEqual([
			"result",
			"complete",
		]);
		expect((await read(session, handle.id, cursor)).done).toBe(true);
	} finally {
		finish.resolve();
		await disposeSessionExecutionEvents(session);
	}
});

test("oversized or cyclic updates are explicitly omitted without losing completion or final errors", async () => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	const session = sessionWith(async (_id, _args, _signal, onUpdate) => {
		onUpdate?.({ content: [{ type: "text", text: "x".repeat(100_000) }] });
		onUpdate?.({ content: [], details: cycle });
		return { content: [{ type: "text", text: "actual failure" }], isError: true };
	});
	try {
		const events = await drain(session, await start(session));
		expect(events.filter(event => event.kind === "update").map(event => event.omitted?.reason)).toEqual([
			"payload_too_large",
			"not_json_serializable",
		]);
		expect(events.slice(-3).map(event => event.kind)).toEqual(["result", "error", "complete"]);
		expect(events.at(-1)?.data).toEqual({ status: "failed" });
	} finally {
		await disposeSessionExecutionEvents(session);
	}
});

test("cancellation remains pending until actual cleanup and does not turn late progress into success", async () => {
	const cleanup = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const session = sessionWith(async (_id, _args, signal, onUpdate) => {
		signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
		onUpdate?.({ content: [{ type: "text", text: "all checks passed" }] });
		await cleanup.promise;
		return ok;
	});
	try {
		const handle = await start(session);
		const pending = (await runExecutionEvents(
			{ op: "events_cancel", id: handle.id },
			{ session },
		)) as ExecutionEventCancellation;
		await aborted.promise;
		expect(pending).toEqual({ id: handle.id, status: "cancelling", done: false });
		cleanup.resolve();
		const events = await drain(session, handle);
		expect(events.some(event => event.kind === "result")).toBe(false);
		expect(events.at(-1)?.data).toEqual({ status: "cancelled" });
	} finally {
		cleanup.resolve();
		aborted.resolve();
		await disposeSessionExecutionEvents(session);
	}
});

test("handles cannot be read, cancelled or disposed by another session and read abort does not cancel the tool", async () => {
	const parent = new AbortController();
	const toolAborted = Promise.withResolvers<void>();
	const session = sessionWith(async (_id, _args, signal) => {
		signal?.addEventListener("abort", () => toolAborted.resolve(), { once: true });
		await toolAborted.promise;
		return ok;
	});
	const other = sessionWith(async () => ok);
	try {
		const handle = await start(session, parent.signal);
		for (const op of ["events_read", "events_cancel", "events_dispose"]) {
			await expect(runExecutionEvents({ op, id: handle.id }, { session: other })).rejects.toThrow(
				"for this session",
			);
		}
		const first = await read(session, handle.id);
		const controller = new AbortController();
		const wait = read(session, handle.id, first.cursor, 128, 1000, controller.signal);
		controller.abort(new Error("reader stopped"));
		await expect(wait).rejects.toThrow("reader stopped");
		expect((await read(session, handle.id)).status).toBe("running");
		parent.abort();
		await toolAborted.promise;
		expect((await drain(session, handle)).at(-1)?.data).toEqual({ status: "cancelled" });
	} finally {
		parent.abort();
		await disposeSessionExecutionEvents(session);
		await disposeSessionExecutionEvents(other);
	}
});

test("disposal wakes readers and waits for job cleanup rather than abandoning an async descendant", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const cleanup = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const session = sessionWith(async () => {
		manager.register("worker", "child", async ({ signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			await cleanup.promise;
			return "cancelled child";
		});
		return ok;
	}, manager);
	try {
		const handle = await start(session);
		const first = await read(session, handle.id);
		const reader = read(session, handle.id, first.cursor, 128, 1000);
		let disposed = false;
		const disposal = runExecutionEvents({ op: "events_dispose", id: handle.id }, { session }).then(value => {
			disposed = true;
			return value;
		});
		await aborted.promise;
		await expect(reader).rejects.toThrow("disposed execution");
		expect(disposed).toBe(false);
		cleanup.resolve();
		expect(await disposal).toEqual({ disposed: true });
		expect(manager.getAllJobs()).toEqual([]);
	} finally {
		cleanup.resolve();
		aborted.resolve();
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
	}
});

test("managed monitor events and nested jobs are live and their delivery remains available to Fleet", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0, deliveryRetentionMs: 10_000 });
	manager.registerDeliverySink("owner", () => {});
	const release = Promise.withResolvers<void>();
	const nested = Promise.withResolvers<void>();
	let monitorId = "";
	const session = sessionWith(async () => {
		monitorId = manager.register(
			"monitor",
			"watcher",
			async ({ emitEvent }) => {
				emitEvent("output", "ready");
				await release.promise;
				manager.register("worker", "descendant", async ({ reportProgress }) => {
					await reportProgress("nested progress");
					await nested.promise;
					return "nested terminal";
				});
				return "monitor terminal";
			},
			{ ownerId: "owner" },
		);
		return ok;
	}, manager);
	try {
		const handle = await start(session);
		const first = await read(session, handle.id);
		expect(first.done).toBe(false);
		expect(JSON.stringify(first.events)).toContain("ready");
		expect(manager.takeEvents([monitorId], { ownerId: "owner" }).map(event => event.text)).toEqual(["ready"]);
		release.resolve();
		let page = await read(session, handle.id, first.cursor, 128, 1000);
		if (!JSON.stringify(page.events).includes("nested progress"))
			page = await read(session, handle.id, page.cursor, 128, 1000);
		expect(JSON.stringify(page.events)).toContain("nested progress");
		expect(page.done).toBe(false);
		nested.resolve();
		const events = await drain(session, handle);
		expect(events.at(-1)?.data).toEqual({ status: "completed" });
		expect(JSON.stringify(events.find(event => event.kind === "result")?.data)).toContain("nested terminal");
	} finally {
		release.resolve();
		nested.resolve();
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
	}
});

test("real async Bash streams before completion and reports the final failed command rather than background admission", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "execution-events-bash-"));
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const session = {
		cwd,
		asyncJobManager: manager,
		settings: { get: (key: string) => key === "async.enabled", getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `execution-events:${cwd}`,
		getEvalKernelOwnerId: () => `execution-events:${cwd}`,
	} as unknown as ToolSession;
	const bash = new BashTool(session);
	session.getToolByName = name => (name === "bash" ? (bash as Tool) : undefined);
	try {
		const handle = await start(session, undefined, "bash", {
			async: true,
			command: "printf 'ready\n'; while [ ! -f release ]; do sleep 0.02; done; printf 'final failure\n'; exit 7",
			timeout: 10,
		});
		let cursor = 0;
		let live: ExecutionEventPage | undefined;
		for (let attempt = 0; attempt < 10; attempt++) {
			const page = await read(session, handle.id, cursor, 128, 1000);
			cursor = page.cursor;
			if (page.events.some(event => event.kind === "update" && JSON.stringify(event.data).includes("ready"))) {
				live = page;
				break;
			}
		}
		expect(live?.status).toBe("running");
		expect(live?.done).toBe(false);
		await Bun.write(path.join(cwd, "release"), "go");
		const events = await drain(session, handle);
		expect(events.at(-1)?.data).toEqual({ status: "failed" });
		const result = events.find(event => event.kind === "result");
		expect(JSON.stringify(result?.data)).toContain('"exitCode":7');
		expect(JSON.stringify(result?.data)).toContain("final failure");
		expect(events.some(event => event.kind === "error")).toBe(true);
	} finally {
		await Bun.write(path.join(cwd, "release"), "go");
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 20_000);

test("real async Bash cancellation reaps its shell descendants before reporting completion", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "execution-events-cancel-"));
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const session = {
		cwd,
		asyncJobManager: manager,
		settings: { get: (key: string) => key === "async.enabled", getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `execution-events-cancel:${cwd}`,
		getEvalKernelOwnerId: () => `execution-events-cancel:${cwd}`,
	} as unknown as ToolSession;
	const bash = new BashTool(session);
	session.getToolByName = name => (name === "bash" ? (bash as Tool) : undefined);
	try {
		const handle = await start(session, undefined, "bash", {
			async: true,
			command:
				"sh -c 'echo $$ > child-pid; printf ready; while [ ! -f trigger ]; do sleep 0.02; done; printf orphan > escaped' & wait",
			timeout: 10,
		});
		let cursor = 0;
		let observed = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			const page = await read(session, handle.id, cursor, 128, 1000);
			cursor = page.cursor;
			if (page.events.some(event => event.kind === "update" && JSON.stringify(event.data).includes("ready"))) {
				observed = true;
				break;
			}
		}
		expect(observed).toBe(true);
		const child = Process.fromPid(Number(await Bun.file(path.join(cwd, "child-pid")).text()));
		expect(child?.status()).toBe(ProcessStatus.Running);
		const result = await runExecutionEvents({ op: "events_cancel", id: handle.id, waitMs: 5000 }, { session });
		expect(result).toEqual({ id: handle.id, status: "cancelled", done: true });
		expect(manager.getAllJobs()).toEqual([]);
		await Bun.write(path.join(cwd, "trigger"), "go");
		expect(child?.status()).toBe(ProcessStatus.Exited);
		expect(await Bun.file(path.join(cwd, "escaped")).exists()).toBe(false);
		expect((await drain(session, handle)).at(-1)?.data).toEqual({ status: "cancelled" });
	} finally {
		await Bun.write(path.join(cwd, "trigger"), "go");
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}, 20_000);

test("concurrent sessions sharing one job manager cannot observe or cancel each other's jobs", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const finish = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	const make = (label: string, wait: Promise<void>) =>
		sessionWith(async () => {
			manager.register("worker", label, async ({ signal, reportProgress }) => {
				signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
				await reportProgress(label);
				await wait;
				return label;
			});
			return ok;
		}, manager);
	const first = make("one", cancelled.promise);
	const second = make("two", finish.promise);
	try {
		const [one, two] = await Promise.all([start(first), start(second)]);
		const onePage = await read(first, one.id);
		const twoPage = await read(second, two.id);
		const text = (page: ExecutionEventPage) => JSON.stringify(page.events.filter(event => event.kind === "update"));
		expect(text(onePage)).toContain("one");
		expect(text(onePage)).not.toContain("two");
		expect(text(twoPage)).toContain("two");
		expect(text(twoPage)).not.toContain("one");
		await runExecutionEvents({ op: "events_cancel", id: one.id, waitMs: 1000 }, { session: first });
		expect(manager.getRunningJobs().map(job => job.label)).toEqual(["two"]);
		finish.resolve();
		expect((await drain(second, two)).at(-1)?.data).toEqual({ status: "completed" });
	} finally {
		finish.resolve();
		cancelled.resolve();
		await disposeSessionExecutionEvents(first);
		await disposeSessionExecutionEvents(second);
		await manager.dispose();
	}
});

test("a failed parent cancels descendants but retains the parent's failed terminal status", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const aborted = Promise.withResolvers<void>();
	const session = sessionWith(async () => {
		manager.register("worker", "child", async ({ signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return "child cleanup";
		});
		throw new Error("parent failed");
	}, manager);
	try {
		const events = await drain(session, await start(session));
		expect(events.find(event => event.kind === "error")?.data).toEqual({
			message: "parent failed",
			cancelled: false,
		});
		expect(events.at(-1)?.data).toEqual({ status: "failed" });
		expect(manager.getAllJobs()).toEqual([]);
	} finally {
		aborted.resolve();
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
	}
});

test("retained handles are bounded without silently discarding terminal events, and disposal restores admission", async () => {
	const session = sessionWith(async () => ok);
	try {
		const handles: ExecutionEventHandle[] = [];
		for (let index = 0; index < 64; index++) {
			const handle = await start(session);
			await drain(session, handle);
			handles.push(handle);
		}
		await expect(start(session)).rejects.toThrow("handle limit");
		expect((await read(session, handles[0].id)).events.at(-1)?.kind).toBe("complete");
		await runExecutionEvents({ op: "events_dispose", id: handles[0].id }, { session });
		expect((await drain(session, await start(session))).at(-1)?.kind).toBe("complete");
	} finally {
		await disposeSessionExecutionEvents(session);
	}
});

test("session disposal cancels live work and closes new starts even when the session lacks an isDisposed hook", async () => {
	const callbacks = new Set<() => void>();
	const aborted = Promise.withResolvers<void>();
	const session = sessionWith(async (_id, _args, signal) => {
		signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
		return ok;
	});
	session.registerDisposeCallback = callback => {
		callbacks.add(callback);
		return () => {
			callbacks.delete(callback);
		};
	};
	try {
		const handle = await start(session);
		for (const callback of callbacks) callback();
		await aborted.promise;
		await disposeSessionExecutionEvents(session);
		await expect(start(session)).rejects.toThrow("session is disposed");
		await expect(read(session, handle.id)).rejects.toThrow("disposed execution");
	} finally {
		aborted.resolve();
		await disposeSessionExecutionEvents(session);
	}
});

test("invalid cursors and unbounded waits fail without starting or mutating another execution", async () => {
	const session = sessionWith(async () => ok);
	try {
		const handle = await start(session);
		await drain(session, handle);
		await expect(read(session, handle.id, 10_000)).rejects.toThrow("cursor is ahead");
		await expect(read(session, handle.id, 0, 128, 30_001)).rejects.toThrow("waitMs");
		await expect(read(session, handle.id, 0, 0)).rejects.toThrow("limit");
		await expect(
			runExecutionEvents({ op: "events_start", tool: "__runtime__", args: {} }, { session }),
		).rejects.toThrow("internal bridge");
		expect((await read(session, handle.id)).status).toBe("completed");
	} finally {
		await disposeSessionExecutionEvents(session);
	}
});

test("capacity wakeups retain the waiting session's ownership instead of joining the releasing execution", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 0 });
	const releaseFirst = Promise.withResolvers<void>();
	const releaseSecond = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	const first = sessionWith(async () => {
		manager.register("worker", "first", async () => {
			await releaseFirst.promise;
			return "first result";
		});
		return ok;
	}, manager);
	const second = sessionWith(async () => {
		manager.onCapacityAvailable(error => {
			if (error) {
				admitted.reject(error);
				return;
			}
			manager.register("worker", "queued-second", async ({ reportProgress }) => {
				await reportProgress("queued-second output");
				await releaseSecond.promise;
				return "second result";
			});
			admitted.resolve();
		});
		await admitted.promise;
		return ok;
	}, manager);
	try {
		const one = await start(first);
		const two = await start(second);
		releaseFirst.resolve();
		await admitted.promise;
		const oneEvents = await drain(first, one);
		expect(oneEvents.at(-1)?.data).toEqual({ status: "completed" });
		expect(JSON.stringify(oneEvents)).not.toContain("queued-second");
		const twoPage = await read(second, two.id);
		expect(twoPage.status).toBe("running");
		expect(JSON.stringify(twoPage.events)).toContain("queued-second output");
		releaseSecond.resolve();
		expect((await drain(second, two)).at(-1)?.data).toEqual({ status: "completed" });
	} finally {
		releaseFirst.resolve();
		releaseSecond.resolve();
		await disposeSessionExecutionEvents(first);
		await disposeSessionExecutionEvents(second);
		await manager.dispose();
	}
});

test("cancelled scopes reject late job admission before starting orphan work", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const proceed = Promise.withResolvers<void>();
	let started = false;
	let admissionFailed = false;
	const session = sessionWith(async () => {
		await proceed.promise;
		try {
			manager.register("worker", "late child", async () => {
				started = true;
				return "should not start";
			});
		} catch {
			admissionFailed = true;
		}
		return ok;
	}, manager);
	try {
		const handle = await start(session);
		await runExecutionEvents({ op: "events_cancel", id: handle.id }, { session });
		proceed.resolve();
		expect((await drain(session, handle)).at(-1)?.data).toEqual({ status: "cancelled" });
		expect(admissionFailed).toBe(true);
		expect(started).toBe(false);
		expect(manager.getAllJobs()).toEqual([]);
	} finally {
		proceed.resolve();
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
	}
});

test("detached continuations cannot admit jobs after the owning execution completed", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const continueLate = Promise.withResolvers<void>();
	let lateAdmission: Promise<string | Error> | undefined;
	const session = sessionWith(async () => {
		lateAdmission = continueLate.promise
			.then(() => manager.register("worker", "detached", async () => "orphan"))
			.catch(error => (error instanceof Error ? error : new Error(String(error))));
		return ok;
	}, manager);
	try {
		const handle = await start(session);
		expect((await drain(session, handle)).at(-1)?.data).toEqual({ status: "completed" });
		continueLate.resolve();
		expect(await lateAdmission).toBeInstanceOf(Error);
		expect(manager.getAllJobs()).toEqual([]);
		expect((await read(session, handle.id)).status).toBe("completed");
	} finally {
		continueLate.resolve();
		await lateAdmission;
		await disposeSessionExecutionEvents(session);
		await manager.dispose();
	}
});
