import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import type { ToolSession } from ".";
import { dispatchXdevTool, dispatchXdTarget, type XdevState } from "./xdev";

test("xd resolution forwards cancellation before a pending action applies", async () => {
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	let seenSignal: AbortSignal | undefined;
	let seenInvokerSignal: AbortSignal | undefined;
	let sideEffectRan = false;
	const session = {
		cwd: process.cwd(),
		peekPendingInvoker: () => async (input: unknown, invokerSignal?: AbortSignal) => {
			const invocation = input as { signal?: AbortSignal };
			seenSignal = invocation.signal;
			seenInvokerSignal = invokerSignal;
			started.resolve();
			await new Promise<void>((resolve, reject) => {
				if (!invocation.signal) {
					resolve();
					return;
				}
				if (invocation.signal.aborted) {
					reject(new Error("aborted before apply"));
					return;
				}
				invocation.signal.addEventListener("abort", () => reject(new Error("aborted during apply")), {
					once: true,
				});
			});
			sideEffectRan = true;
			return { content: [{ type: "text" as const, text: "applied\n" }] };
		},
	} as unknown as ToolSession;

	const pending = dispatchXdTarget(session, "resolve", "apply this", {
		toolCallId: "resolve-cancel",
		signal: controller.signal,
	});
	await started.promise;
	controller.abort();

	await expect(pending).rejects.toThrow("aborted during apply");
	expect(seenSignal).toBe(controller.signal);
	expect(seenInvokerSignal).toBe(controller.signal);
	expect(sideEffectRan).toBe(false);
});

function probeState(seen: { args?: Record<string, unknown> }): XdevState {
	const probe = {
		name: "probe",
		label: "Probe",
		description: "probe device",
		parameters: type({ target: type("string > 0").describe("thing to probe") }),
		execute: async (_id: string, args: Record<string, unknown>) => {
			seen.args = args;
			return { content: [{ type: "text" as const, text: "probed\n" }] };
		},
	} as unknown as AiTool;
	return {
		tools: new Map([["probe", probe as never]]),
		mountedNames: new Set(["probe"]),
		builtInNames: new Set(["probe"]),
		isActive: () => true,
	};
}

test("devices accept the documented intent field and drop it before execution", async () => {
	const seen: { args?: Record<string, unknown> } = {};
	const { result } = await dispatchXdevTool(
		probeState(seen),
		"probe",
		JSON.stringify({ target: "disk", i: "Probing disk" }),
		"xd-intent",
	);

	expect(result.isError).toBeFalsy();
	expect(seen.args).toEqual({ target: "disk" });
});

test("device validation states the constraint and the offending value", async () => {
	await expect(
		dispatchXdevTool(probeState({}), "probe", JSON.stringify({ target: "" }), "xd-invalid"),
	).rejects.toThrow(/target must be at least length 1 \(was ""\)/);
});
