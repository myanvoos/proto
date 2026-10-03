import { expect, test, vi } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../async";
import type { ToolSession } from "../../tools";
import { CheckpointTool, RewindTool } from "../../tools/checkpoint";
import { JobsTool } from "../../tools/jobs";
import { callSessionTool } from "./tool-bridge";

function sessionWith(manager: AsyncJobManager): ToolSession {
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	const jobs = new JobsTool(session);
	(session as { getToolByName?: (name: string) => unknown }).getToolByName = name =>
		name === jobs.name ? jobs : undefined;
	return session;
}

test("kernel tool calls reach a strict tool without the harness intent field", async () => {
	const manager = new AsyncJobManager({});
	try {
		const session = sessionWith(manager);
		const value = await callSessionTool("jobs", { op: "list", kind: "job" }, { session });
		const text = typeof value === "string" ? value : ((value as { text?: string })?.text ?? "");
		expect(text).not.toContain("Unknown jobs parameter");
		expect(value).toMatchObject({ details: { op: "list", jobs: [] } });
		expect(typeof value === "string" ? undefined : (value as { hasError?: boolean }).hasError).toBeUndefined();
	} finally {
		await manager.dispose();
	}
});

test("an explicit intent argument is dropped for tools that do not declare it", async () => {
	const manager = new AsyncJobManager({});
	try {
		const session = sessionWith(manager);
		const value = await callSessionTool(
			"jobs",
			{ [INTENT_FIELD]: "checking jobs", op: "list", kind: "job" },
			{ session },
		);
		const text = typeof value === "string" ? value : ((value as { text?: string })?.text ?? "");
		expect(text).not.toContain("Unknown jobs parameter");
		expect(value).toMatchObject({ details: { op: "list", jobs: [] } });
	} finally {
		await manager.dispose();
	}
});

test("tools that declare an intent parameter still receive one", async () => {
	let seen: Record<string, unknown> | undefined;
	const tool = {
		name: "declares-intent",
		label: "declares intent",
		description: "",
		parameters: {
			type: "object",
			properties: { [INTENT_FIELD]: { type: "string" }, value: { type: "string" } },
		},
		execute: async (_id: string, args: unknown) => {
			seen = args as Record<string, unknown>;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	const session = {
		getToolByName: (name: string) => (name === tool.name ? tool : undefined),
	} as unknown as ToolSession;
	const value = await callSessionTool("declares-intent", { value: "x" }, { session });
	expect(value).toBe("ok");
	expect(seen?.[INTENT_FIELD]).toBe("js prelude");
});

test("bridged calls are validated like model tool calls before the tool runs", async () => {
	const calls: unknown[] = [];
	const tool = {
		name: "strict",
		label: "strict",
		description: "",
		parameters: {
			type: "object",
			properties: { value: { type: "string" }, note: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
		execute: async (_id: string, args: unknown) => {
			calls.push(args);
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	const session = {
		getToolByName: (name: string) => (name === tool.name ? tool : undefined),
	} as unknown as ToolSession;

	expect(await callSessionTool("strict", { value: "x", note: null }, { session })).toBe("ok");
	expect(calls).toEqual([{ value: "x" }]);

	await expect(callSessionTool("strict", { value: null }, { session })).rejects.toThrow("Validation failed");
	expect(calls).toHaveLength(1);
});

test("kernel tool bridge preserves native audio/video blocks instead of dropping them", async () => {
	const mediaTool = {
		name: "native-media",
		label: "native media",
		description: "",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "audio" as const, data: "YQ==", mimeType: "audio/wav" }],
		}),
	};
	const session = {
		getToolByName: () => mediaTool,
		getArtifactsDir: () => "/tmp",
		allocateOutputArtifact: async () => ({ path: `/tmp/proto-media-test-artifact-${crypto.randomUUID()}`, id: "1" }),
	} as unknown as ToolSession;
	const value = await callSessionTool("native-media", {}, { session });
	expect(value).toMatchObject({ media: [{ type: "audio", mimeType: "audio/wav", data: "YQ==" }] });
});

test("unknown bridged tools name close matches, or the available tools, without blaming one runtime", async () => {
	const session = {
		getToolForEvalBridge: () => undefined,
		getEvalBridgeToolNames: () => ["write", "read", "bash"],
	} as unknown as ToolSession;
	const failure = async (name: string): Promise<string> => {
		try {
			await callSessionTool(name, {}, { session });
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error(`${name} unexpectedly resolved`);
	};

	const typo = await failure("raed");
	expect(typo).toContain("Unknown tool: raed");
	expect(typo).toContain("Did you mean read?");
	const unrelated = await failure("zzz");
	expect(unrelated).toContain("Unknown tool: zzz");
	expect(unrelated).toContain("Available tools: bash, read, write");
	for (const message of [typo, unrelated]) expect(message).not.toMatch(/\bjs\b|javascript|python/i);
});

test("kernel checkpoint and rewind calls are rejected instead of silently succeeding", async () => {
	const session = { getCheckpointState: () => ({ goal: "g" }) } as unknown as ToolSession;
	const checkpoint = new CheckpointTool({ getCheckpointState: () => undefined } as unknown as ToolSession);
	const rewind = new RewindTool(session);
	const checkpointExecute = vi.spyOn(checkpoint, "execute");
	const rewindExecute = vi.spyOn(rewind, "execute");
	(session as { getToolByName?: (name: string) => unknown }).getToolByName = name =>
		name === "checkpoint" ? checkpoint : name === "rewind" ? rewind : undefined;

	await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
		"cannot run through the eval bridge",
	);
	await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
		"cannot run through the eval bridge",
	);
	expect(checkpointExecute).not.toHaveBeenCalled();
	expect(rewindExecute).not.toHaveBeenCalled();
});

test("nested shell calls reuse idle lanes, never reuse ancestors, and reject saturated recursion", async () => {
	const entered: string[] = [];
	let nested = false;
	let depth = 0;
	const tool = {
		name: "bash",
		label: "bash",
		description: "",
		parameters: { type: "object", properties: {} },
		execute: async (_id: string, args: unknown) => {
			entered.push((args as { lane: string }).lane);
			if (nested && ++depth < 9) await callSessionTool("bash", {}, { session });
			return { content: [{ type: "text" as const, text: "done" }] };
		},
	};
	const session = { getToolByName: () => tool } as unknown as ToolSession;
	for (let index = 0; index < 20; index++) await callSessionTool("bash", {}, { session });
	expect(new Set(entered).size).toBe(1);
	entered.length = 0;
	nested = true;
	await expect(callSessionTool("bash", {}, { session })).rejects.toThrow("Nested shell lane limit");
	expect(entered).toHaveLength(8);
	expect(new Set(entered).size).toBe(8);
	nested = false;
	expect(await callSessionTool("bash", {}, { session })).toBe("done");
	expect(entered[8]).toBe(entered[0]);
});

test("cancelled nested async calls keep their lane until their callback actually settles", async () => {
	const manager = new AsyncJobManager({ maxRunningJobs: 8 });
	const finish = Promise.withResolvers<void>();
	const lanes: string[] = [];
	const jobs: string[] = [];
	const tool = {
		name: "bash",
		label: "bash",
		description: "",
		parameters: { type: "object", properties: {} },
		execute: async (_id: string, args: unknown) => {
			lanes.push((args as { lane: string }).lane);
			const jobId = manager.register("bash", "nested", async () => {
				await finish.promise;
				return "done";
			});
			jobs.push(jobId);
			return { content: [{ type: "text" as const, text: "backgrounded" }], details: { async: { jobId } } };
		},
	};
	const session = { getToolByName: () => tool, asyncJobManager: manager } as unknown as ToolSession;
	try {
		for (let index = 0; index < 8; index++) await callSessionTool("bash", {}, { session });
		expect(new Set(lanes).size).toBe(8);
		manager.cancel(jobs[0]);
		await expect(callSessionTool("bash", {}, { session })).rejects.toThrow("Nested shell lane limit");
		finish.resolve();
		await Promise.all(jobs.map(id => manager.getJob(id)!.promise));
		await callSessionTool("bash", {}, { session });
		expect(lanes[8]).toBe(lanes[0]);
	} finally {
		finish.resolve();
		await manager.dispose();
	}
});

test("bridged checklist calls report whether they committed a new plan", async () => {
	const tool = {
		name: "checklist",
		label: "checklist",
		description: "",
		parameters: { type: "object", properties: { op: { type: "string" } } },
		execute: async (_id: string, args: unknown) => ({
			content: [{ type: "text" as const, text: "ok" }],
			details: { op: (args as { op: string }).op, phases: [], storage: "memory" },
		}),
	};
	const session = {
		getToolByName: (name: string) => (name === tool.name ? tool : undefined),
	} as unknown as ToolSession;
	const events: Record<string, unknown>[] = [];
	const emitStatus = (event: Record<string, unknown>) => events.push(event);

	await callSessionTool("checklist", { op: "done" }, { session, emitStatus });
	await callSessionTool("checklist", { op: "view" }, { session, emitStatus });

	expect(events.map(event => [event.op, event.committed])).toEqual([
		["checklist", true],
		["checklist", false],
	]);
});
