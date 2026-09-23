import { describe, expect, test } from "bun:test";
import { createSerializedRebuilder } from "./auth-gateway-cli";

function gatedRun() {
	const calls: boolean[] = [];
	const gates: PromiseWithResolvers<void>[] = [];
	const run = (force: boolean): Promise<void> => {
		calls.push(force);
		const gate = Promise.withResolvers<void>();
		gates.push(gate);
		return gate.promise;
	};
	return { calls, gates, run };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("createSerializedRebuilder", () => {
	test("credential-triggered forced rebuild during a cached pass runs its own forced pass", async () => {
		const { calls, gates, run } = gatedRun();
		const rebuild = createSerializedRebuilder(run);
		let forcedSettled = false;

		void rebuild(false);
		const forced = rebuild(true).then(() => {
			forcedSettled = true;
		});
		expect(calls).toEqual([false]);

		gates[0]!.resolve();
		await flush();
		expect(calls).toEqual([false, true]);
		expect(forcedSettled).toBe(false);

		gates[1]!.resolve();
		await forced;
		expect(calls).toEqual([false, true]);
	});

	test("periodic rebuild during an in-flight pass coalesces without an extra refresh", async () => {
		const { calls, gates, run } = gatedRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		const second = rebuild(false);
		gates[0]!.resolve();
		await Promise.all([first, second]);
		expect(calls).toEqual([false]);

		void rebuild(false);
		expect(calls).toEqual([false, false]);
		gates[1]!.resolve();
	});
});
