import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import { IrcBus } from "./bus";

function makeRegistryWithPeer(status: "running" | "idle" | "parked"): AgentRegistry {
	const registry = new AgentRegistry();
	registry.register({
		id: "peer",
		displayName: "peer",
		kind: "sub",
		session: null,
		status,
	});
	return registry;
}

describe("IrcBus wait liveness", () => {
	test("keeps waiting while the only peer is registered but not streaming (inter-turn gap)", async () => {
		const registry = makeRegistryWithPeer("running");
		const bus = new IrcBus(registry);
		const waited = await bus.wait("waiter", {}, 60, undefined, {
			liveness: { registry, senderId: "waiter" },
		});
		expect(waited).toBeNull();
	});

	test("keeps waiting while the only peer is idle with a queued follow-up", async () => {
		const registry = makeRegistryWithPeer("idle");
		const bus = new IrcBus(registry);
		const waited = await bus.wait("waiter", {}, 60, undefined, {
			liveness: { registry, senderId: "waiter" },
		});
		expect(waited).toBeNull();
	});

	test("aborts immediately when the peer is parked (released)", async () => {
		const registry = makeRegistryWithPeer("parked");
		const bus = new IrcBus(registry);
		await expect(
			bus.wait("waiter", {}, 5_000, undefined, {
				liveness: { registry, senderId: "waiter" },
			}),
		).rejects.toThrow(/no active peers remain/);
	});

	test("aborts immediately when the requested peer does not exist", async () => {
		const registry = makeRegistryWithPeer("running");
		const bus = new IrcBus(registry);
		await expect(
			bus.wait("waiter", { from: "ghost" }, 5_000, undefined, {
				liveness: { registry, senderId: "waiter" },
			}),
		).rejects.toThrow(/no longer active/);
	});
});
