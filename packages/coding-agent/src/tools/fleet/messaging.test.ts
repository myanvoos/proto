import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Settings } from "../../config/settings";
import { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import { executeSend } from "./messaging";

afterEach(() => {
	vi.useRealTimers();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("fleet send reply waits", () => {
	test("reject when the awaited peer unregisters with an unbounded timeout", async () => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const peerUnregistered = Promise.withResolvers<void>();
		const peer = registry.register({
			id: "peer",
			label: "peer",
			kind: "sub",
			parentId: "Main",
			fleetRoot: "fleet",
			status: "running",
			session: {
				deliverIrcMessage: async () => {
					queueMicrotask(() => {
						registry.unregister("peer", peer);
						peerUnregistered.resolve();
					});
					return "injected";
				},
			} as never,
		});
		registry.register({
			id: "Main",
			label: "Main",
			kind: "main",
			status: "running",
			fleetRoot: "fleet",
			session: null,
		});
		const settings = {
			get: (key: string) => (key === "irc.timeoutMs" ? 0 : undefined),
		} as unknown as Settings;
		const controller = new AbortController();
		const send = executeSend(
			{ registry, senderId: "Main", fleetRoot: "fleet", settings },
			{ id: "peer", message: "hello", await: true },
			controller.signal,
		);
		const timeout = Promise.withResolvers<"timed-out">();
		const timeoutHandle = setTimeout(() => timeout.resolve("timed-out"), 250);
		const outcomePromise = Promise.race([
			send.then(
				() => "resolved" as const,
				(error: unknown) => error,
			),
			timeout.promise,
		]);
		await peerUnregistered.promise;
		expect(registry.listVisibleTo("Main", "fleet")).toEqual([]);
		for (let index = 0; index < 10; index++) await Promise.resolve();
		vi.advanceTimersByTime(250);
		const outcome = await outcomePromise;
		clearTimeout(timeoutHandle);
		if (outcome === "timed-out") {
			controller.abort(new Error("test cleanup"));
			await send.catch(() => undefined);
		}
		expect(outcome).toBeInstanceOf(Error);
		vi.useRealTimers();
		expect(outcome).toMatchObject({ message: 'IRC wait aborted: agent "peer" is no longer active' });
	});
});
