import { expect, test, vi } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../async";
import type { ToolSession } from "../../tools";
import { CheckpointTool, RewindTool } from "../../tools/checkpoint";
import { FleetTool } from "../../tools/fleet";
import { callSessionTool } from "./tool-bridge";

function sessionWith(manager: AsyncJobManager): ToolSession {
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	const fleet = new FleetTool(session);
	(session as { getToolByName?: (name: string) => unknown }).getToolByName = name =>
		name === fleet.name ? fleet : undefined;
	return session;
}

test("kernel tool calls reach a strict tool without the harness intent field", async () => {
	const manager = new AsyncJobManager({});
	try {
		const session = sessionWith(manager);
		const value = await callSessionTool("fleet", { op: "jobs" }, { session });
		const text = typeof value === "string" ? value : ((value as { text?: string })?.text ?? "");
		expect(text).not.toContain("Unknown fleet parameter");
		expect(text).toContain("No background jobs.");
		expect(typeof value === "string" ? undefined : (value as { hasError?: boolean }).hasError).toBeUndefined();
	} finally {
		await manager.dispose();
	}
});

test("an explicit intent argument is dropped for tools that do not declare it", async () => {
	const manager = new AsyncJobManager({});
	try {
		const session = sessionWith(manager);
		const value = await callSessionTool("fleet", { [INTENT_FIELD]: "checking jobs", op: "jobs" }, { session });
		const text = typeof value === "string" ? value : ((value as { text?: string })?.text ?? "");
		expect(text).not.toContain("Unknown fleet parameter");
		expect(text).toContain("No background jobs.");
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
