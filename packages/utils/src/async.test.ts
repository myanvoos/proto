import { expect, test, vi } from "bun:test";
import { AsyncDrain } from "./async";

test("AsyncDrain flush persists the pending batch immediately and only once", async () => {
	vi.useFakeTimers();
	try {
		const batches: number[][] = [];
		const drain = new AsyncDrain<number>(100);
		const first = drain.push(1, values => {
			batches.push([...values]);
		});
		const second = drain.push(2, () => {
			throw new Error("a joined push must not replace the batch handler");
		});

		await Promise.all([first, second, drain.flush()]);
		expect(batches).toEqual([[1, 2]]);

		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(batches).toEqual([[1, 2]]);
	} finally {
		vi.useRealTimers();
	}
});
