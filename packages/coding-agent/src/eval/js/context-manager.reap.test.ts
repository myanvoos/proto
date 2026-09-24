import { expect, test } from "bun:test";
import { shutdownWorker } from "./context-manager";

test("JS idle shutdown reports failure when close and terminate both fail", async () => {
	const confirmed = await shutdownWorker(
		{
			mode: "process",
			send: () => {},
			onMessage: () => () => {},
			onError: () => () => {},
			close: async () => false,
			terminate: async () => {
				throw new Error("termination failed");
			},
		},
		false,
	);
	expect(confirmed).toBe(false);
});
