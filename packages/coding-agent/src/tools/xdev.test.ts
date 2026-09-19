import { expect, test } from "bun:test";
import type { ToolSession } from ".";
import { dispatchXdTarget } from "./xdev";

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
