import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { type AsyncJobEvent, AsyncJobManager } from "../../async";
import { Settings } from "../../config/settings";
import { CURRENT_SESSION_VERSION } from "../../session/session-entries";
import type { ToolSession } from "..";
import { FleetTool } from "./index";
import type { CoordinationDetails } from "./types";

function fleetFor(manager: AsyncJobManager, ownerId: string): FleetTool {
	return new FleetTool({
		asyncJobManager: manager,
		settings: Settings.isolated(),
		getAsyncJobOwnerId: () => ownerId,
	} as ToolSession);
}

test("fleet waits for an event without completing the monitor and later events still auto-deliver", async () => {
	const manager = new AsyncJobManager({});
	const delivered: AsyncJobEvent[] = [];
	manager.registerDeliverySink("owner", (_id, _text, _job, event) => {
		if (event) delivered.push(event);
	});
	const finish = Promise.withResolvers<string>();
	let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
	const id = manager.register(
		"monitor",
		"deployment",
		async ({ emitEvent }) => {
			emit = emitEvent;
			return finish.promise;
		},
		{ ownerId: "owner" },
	);
	try {
		const fleet = fleetFor(manager, "owner");
		const waiting = fleet.execute("wait", { op: "wait", ids: [id], timeoutMs: 1000 });
		emit("output", "READY on port 4000");
		const result = (await waiting) as AgentToolResult<CoordinationDetails>;
		expect(result.details?.jobs?.[0]?.status).toBe("running");
		expect(result.details?.jobs?.[0]?.events?.map(event => event.text)).toEqual(["READY on port 4000"]);
		expect(result.useless).not.toBe(true);
		expect(manager.takeEvents([id])).toEqual([]);
		await using fixture = await TempDir.create("@proto-monitor-render-");
		const timestamp = new Date(0).toISOString();
		const sessionFile = path.join(fixture.path(), "session.jsonl");
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "monitor-render", cwd: fixture.path(), timestamp },
			{
				type: "message",
				id: "call",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "wait", name: "fleet", arguments: { op: "wait", ids: [id] } }],
					api: "openai-responses",
					provider: "test",
					model: "test",
					stopReason: "toolUse",
					timestamp: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
			{
				type: "message",
				id: "result",
				parentId: "call",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "wait",
					toolName: "fleet",
					...result,
					isError: false,
					timestamp: 1,
				},
			},
		];
		await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const cli = path.resolve(import.meta.dir, "../../cli.ts");
		const rendered = await $`${process.execPath} ${cli} render ${sessionFile} --plain --width 100 --height 20`
			.cwd(fixture.path())
			.env({ ...process.env, PI_CODING_AGENT_DIR: path.join(fixture.path(), "profile") })
			.quiet()
			.nothrow();
		expect(rendered.exitCode, rendered.stderr.toString()).toBe(0);
		expect(rendered.text()).toContain("READY on port 4000");
		emit("output", "NEXT deployment");
		await manager.drainDeliveries();
		expect(delivered.filter(event => !manager.isEventAcknowledged(event)).map(event => event.text)).toEqual([
			"NEXT deployment",
		]);
	} finally {
		finish.resolve("done");
		await manager.dispose();
	}
});

test("fleet lists and cancels only the owning agent's monitor jobs", async () => {
	const manager = new AsyncJobManager({});
	const finish = Promise.withResolvers<string>();
	try {
		const own = manager.register("monitor", "own watch", async () => finish.promise, { ownerId: "owner" });
		const other = manager.register("monitor", "sibling watch", async () => finish.promise, { ownerId: "sibling" });
		const fleet = fleetFor(manager, "owner");
		const listed = (await fleet.execute("jobs", { op: "jobs" })) as AgentToolResult<CoordinationDetails>;
		expect(listed.details?.jobs?.map(job => job.id)).toEqual([own]);
		const hidden = (await fleet.execute("wait", {
			op: "wait",
			ids: [other],
			timeoutMs: 10,
		})) as AgentToolResult<CoordinationDetails>;
		expect(hidden.details?.jobs).toEqual([]);
		const cancelled = (await fleet.execute("cancel", {
			op: "cancel",
			ids: [own, other],
		})) as AgentToolResult<CoordinationDetails>;
		expect(cancelled.details?.cancelled).toEqual([
			{ id: own, status: "cancelled" },
			{ id: other, status: "not_found" },
		]);
		expect(manager.getJob(other)?.status).toBe("running");
	} finally {
		finish.resolve("done");
		await manager.dispose();
	}
});

test("bare fleet wait includes monitor events and a timed out wait preserves future delivery", async () => {
	const manager = new AsyncJobManager({});
	const delivered: AsyncJobEvent[] = [];
	manager.registerDeliverySink("owner", (_id, _text, _job, event) => {
		if (event) delivered.push(event);
	});
	const finish = Promise.withResolvers<string>();
	let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
	manager.register(
		"monitor",
		"watch",
		async ({ emitEvent }) => {
			emit = emitEvent;
			return finish.promise;
		},
		{ ownerId: "owner" },
	);
	try {
		const fleet = fleetFor(manager, "owner");
		const timeout = await fleet.execute("timeout", { op: "wait", timeoutMs: 1 });
		expect(timeout.useless).toBe(true);
		const waiting = fleet.execute("wait", { op: "wait", timeoutMs: 1000 });
		emit("output", "first change");
		const result = (await waiting) as AgentToolResult<CoordinationDetails>;
		expect(result.details?.jobs?.[0]?.events?.map(event => event.text)).toEqual(["first change"]);
		emit("output", "later change");
		await manager.drainDeliveries();
		expect(delivered.filter(event => !manager.isEventAcknowledged(event)).map(event => event.text)).toEqual([
			"later change",
		]);
	} finally {
		finish.resolve("done");
		await manager.dispose();
	}
});

test("an interrupted fleet wait leaves its monitor event available to the owner", async () => {
	const manager = new AsyncJobManager({});
	const delivered: AsyncJobEvent[] = [];
	manager.registerDeliverySink("owner", (_id, _text, _job, event) => {
		if (event) delivered.push(event);
	});
	const finish = Promise.withResolvers<string>();
	let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
	const id = manager.register(
		"monitor",
		"watch",
		async ({ emitEvent }) => {
			emit = emitEvent;
			return finish.promise;
		},
		{ ownerId: "owner" },
	);
	try {
		const abort = new AbortController();
		const waiting = fleetFor(manager, "owner").execute(
			"wait",
			{ op: "wait", ids: [id], timeoutMs: 1000 },
			abort.signal,
		);
		emit("output", "preserve during steering");
		abort.abort();
		const result = (await waiting) as AgentToolResult<CoordinationDetails>;
		expect(result.details?.jobs?.[0]?.events).toBeUndefined();
		await manager.drainDeliveries();
		expect(delivered.filter(event => !manager.isEventAcknowledged(event)).map(event => event.text)).toEqual([
			"preserve during steering",
		]);
	} finally {
		finish.resolve("done");
		await manager.dispose();
	}
});
