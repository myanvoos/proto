import { describe, expect, it } from "bun:test";
import type { ElementHandle } from "puppeteer-core";
import { type HandleOpGuard, toActionableHandle } from "./tab-worker";

// Stand-in for #runOp: per-op deadline that surfaces the same `<label> timed out after <ms>ms` error.
function makeGuard(perOpMs: number): { guard: HandleOpGuard; labels: string[] } {
	const labels: string[] = [];
	const guard: HandleOpGuard = (label, fn) => {
		labels.push(label);
		const timeout = AbortSignal.timeout(perOpMs);
		return fn(timeout).catch((err: unknown) => {
			if (timeout.aborted) throw new Error(`${label} timed out after ${perOpMs}ms`);
			throw err;
		});
	};
	return { guard, labels };
}

describe("browser handle guarded actions", () => {
	it("fails a stalled handle.click() fast, invalidates the handle, and blocks a caught retry", async () => {
		let clicks = 0;
		let disposed = false;
		let invalidated = false;
		const stub = {
			click: () => {
				clicks++;
				return Promise.withResolvers<void>().promise;
			},
			type: async () => {},
			evaluate: async () => {},
			dispose: async () => {
				disposed = true;
			},
		} as unknown as ElementHandle;
		const { guard, labels } = makeGuard(50);
		const handle = toActionableHandle(stub, guard, async () => {
			invalidated = true;
		});

		await expect(handle.click()).rejects.toThrow("handle.click() timed out after 50ms");
		expect(disposed).toBe(true);
		expect(invalidated).toBe(true);
		await expect(handle.click()).rejects.toThrow("this handle was invalidated after handle.click() timed out");
		expect(clicks).toBe(1);
		expect(labels).toEqual(["handle.click()", "handle.click()"]);
	});

	it("guards drag and touch input methods, not just click/type", async () => {
		const stalled = (method: string): Record<string, () => Promise<void>> =>
			toActionableHandle(
				{
					[method]: () => Promise.withResolvers<void>().promise,
					type: async () => {},
					evaluate: async () => {},
					dispose: async () => {},
				} as unknown as ElementHandle,
				makeGuard(50).guard,
			) as unknown as Record<string, () => Promise<void>>;

		await expect(stalled("drag").drag!()).rejects.toThrow("handle.drag() timed out after 50ms");
		await expect(stalled("touchStart").touchStart!()).rejects.toThrow("handle.touchStart() timed out after 50ms");
	});

	it("stops handle.type() before dispatching more characters after timeout", async () => {
		const typed: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const firstFinished = Promise.withResolvers<void>();
		const stub = {
			type: async () => {},
			evaluate: async (fn: (el: unknown) => unknown) => {
				fn({ focus: () => {} });
			},
			frame: {
				page: () => ({
					keyboard: {
						type: async (character: string) => {
							firstStarted.resolve();
							await releaseFirst.promise;
							typed.push(character);
							firstFinished.resolve();
						},
					},
				}),
			},
			dispose: async () => {},
		} as unknown as ElementHandle;
		const deadline = new AbortController();
		const action = toActionableHandle(stub, (_label, fn) => fn(deadline.signal)).type("abc");

		await firstStarted.promise;
		deadline.abort(new Error("action deadline"));
		await expect(action).rejects.toThrow("action deadline");
		releaseFirst.resolve();
		await firstFinished.promise;
		expect(typed).toEqual(["a"]);
	});

	it("rewraps a cached handle from its original methods for each run", async () => {
		let clicks = 0;
		const stub = {
			click: async () => {
				clicks++;
			},
			type: async () => {},
			evaluate: async () => {},
		} as unknown as ElementHandle;
		const ended: HandleOpGuard = (_label, fn) => fn(AbortSignal.abort(new Error("run ended")));

		await expect(toActionableHandle(stub, ended).click()).rejects.toThrow();
		expect(clicks).toBe(0);
		const { guard, labels } = makeGuard(1_000);
		await toActionableHandle(stub, guard).click();
		expect(clicks).toBe(1);
		expect(labels).toEqual(["handle.click()"]);
	});
});
