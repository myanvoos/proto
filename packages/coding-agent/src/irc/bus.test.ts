import { describe, expect, test } from "bun:test";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { IrcBus } from "./bus";

function makeRegistryWithPeer(status: "running" | "idle" | "parked"): AgentRegistry {
	const registry = new AgentRegistry();
	registry.register({
		id: "waiter",
		displayName: "waiter",
		kind: "main",
		session: null,
		fleetRoot: "/current/fleet",
	});
	registry.register({
		id: "peer",
		displayName: "peer",
		kind: "sub",
		session: null,
		fleetRoot: "/current/fleet",
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

describe("IrcBus fleet isolation", () => {
	test("keeps a detached fleet connected to its own main session", async () => {
		const registry = new AgentRegistry();
		const deliveries: string[] = [];
		const mainA = registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			fleetRoot: "/session-a/fleet",
			sessionFile: "/session-a.jsonl",
			session: {
				deliverIrcMessage: async () => {
					deliveries.push("a");
					return "injected" as const;
				},
			} as unknown as AgentSession,
		});
		registry.register({
			id: "worker-a",
			displayName: "worker-a",
			kind: "sub",
			parentId: "Main",
			fleetRoot: "/session-a/fleet",
			session: null,
		});
		const mainB = registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			fleetRoot: "/session-b/fleet",
			sessionFile: "/session-b.jsonl",
			session: {
				deliverIrcMessage: async () => {
					deliveries.push("b");
					return "injected" as const;
				},
			} as unknown as AgentSession,
		});
		registry.register({
			id: "worker-b",
			displayName: "worker-b",
			kind: "sub",
			parentId: "Main",
			fleetRoot: "/session-b/fleet",
			session: null,
		});
		const bus = new IrcBus(registry);
		expect(registry.setStatus("Main", "idle", mainA.session!)).toBe(true);
		expect(registry.get("Main")).toBe(mainB);
		expect(registry.getInFleet("Main", "/session-a/fleet")?.status).toBe("idle");
		expect(registry.setStatus("Main", "running", mainA.session!)).toBe(true);

		const receipt = await bus.send({ from: "worker-a", to: "Main", body: "still working" });

		expect(receipt.outcome).toBe("injected");
		expect(deliveries).toEqual(["a"]);
		expect(registry.listVisibleTo("Main", "/session-a/fleet").map(ref => ref.id)).toContain("worker-a");
		expect(registry.listVisibleTo("Main", "/session-a/fleet").map(ref => ref.id)).not.toContain("worker-b");

		expect(registry.activateSession("Main", mainA.session!)).toBe(true);
		const waiting = bus.wait("Main", { from: "worker-a" }, 1_000, undefined, {
			fleetRoot: "/session-a/fleet",
		});
		registry.activateSession("Main", mainB.session!);
		await bus.send({ from: "worker-a", to: "Main", body: "finished" });

		expect(await waiting).toMatchObject({ from: "worker-a", to: "Main", body: "finished" });
	});

	test("rejects delivery to an agent from another session fleet", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "sender",
			displayName: "sender",
			kind: "main",
			session: null,
			fleetRoot: "/current/fleet",
		});
		let deliveries = 0;
		registry.register({
			id: "old-peer",
			displayName: "old-peer",
			kind: "sub",
			fleetRoot: "/previous/fleet",
			session: {
				deliverIrcMessage: async () => {
					deliveries++;
					return "injected" as const;
				},
			} as unknown as AgentSession,
		});

		const receipt = await new IrcBus(registry).send({ from: "sender", to: "old-peer", body: "stale" });

		expect(receipt).toMatchObject({ outcome: "failed", to: "old-peer" });
		expect(deliveries).toBe(0);
	});

	test("rechecks Fleet scope after reviving a parked recipient", async () => {
		const registry = new AgentRegistry();
		const sender = registry.register({
			id: "sender",
			displayName: "sender",
			kind: "main",
			session: null,
			fleetRoot: "/previous/fleet",
		});
		let deliveries = 0;
		const targetSession = {
			deliverIrcMessage: async () => {
				deliveries++;
				return "injected" as const;
			},
		} as unknown as AgentSession;
		const target = registry.register({
			id: "target",
			displayName: "target",
			kind: "sub",
			session: null,
			fleetRoot: "/previous/fleet",
			status: "parked",
		});
		const lifecycle = {
			manages: () => true,
			isParking: () => false,
			has: () => false,
			ensureLive: async () => {
				registry.attachSession("target", targetSession, undefined, target);
				registry.setStatus("target", "idle", target);
				registry.updateSessionScope(
					"sender",
					{ fleetRoot: "/current/fleet", sessionFile: "/current.jsonl" },
					sender,
				);
				return targetSession;
			},
		} as unknown as AgentLifecycleManager;

		const receipt = await new IrcBus(registry, lifecycle).send({ from: "sender", to: "target", body: "stale" });

		expect(receipt.outcome).toBe("failed");
		expect(deliveries).toBe(0);
	});

	test("aborts an unbounded wait when its agent changes session fleets", async () => {
		const registry = makeRegistryWithPeer("running");
		const waiter = registry.get("waiter")!;
		const waiting = new IrcBus(registry).wait("waiter", {}, 0);

		registry.updateSessionScope("waiter", { fleetRoot: "/next/fleet", sessionFile: "/next.jsonl" }, waiter);

		await expect(waiting).rejects.toThrow("agent session changed");
	});

	test("does not relay another session fleet's peer traffic into the current main session", async () => {
		const registry = new AgentRegistry();
		let relays = 0;
		registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			fleetRoot: "/current/fleet",
			session: {
				emitIrcRelayObservation: () => {
					relays++;
				},
			} as unknown as AgentSession,
		});
		registry.register({
			id: "old-sender",
			displayName: "old-sender",
			kind: "sub",
			session: null,
			fleetRoot: "/previous/fleet",
		});
		registry.register({
			id: "old-recipient",
			displayName: "old-recipient",
			kind: "sub",
			fleetRoot: "/previous/fleet",
			session: { deliverIrcMessage: async () => "injected" as const } as unknown as AgentSession,
		});

		const receipt = await new IrcBus(registry).send({
			from: "old-sender",
			to: "old-recipient",
			body: "old-session traffic",
		});

		expect(receipt.outcome).toBe("injected");
		expect(relays).toBe(0);
	});

	test("drops queued messages when the recipient moves to a new session fleet", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "sender",
			displayName: "sender",
			kind: "sub",
			session: null,
			fleetRoot: "/previous/fleet",
		});
		const recipient = registry.register({
			id: "recipient",
			displayName: "recipient",
			kind: "main",
			fleetRoot: "/previous/fleet",
			session: {
				deliverIrcMessage: async () => {
					throw new Error("temporarily unavailable");
				},
			} as unknown as AgentSession,
		});
		const bus = new IrcBus(registry);
		await bus.send({ from: "sender", to: "recipient", body: "queued before switch" });

		registry.updateSessionScope(
			"recipient",
			{ fleetRoot: "/current/fleet", sessionFile: "/current.jsonl" },
			recipient,
		);

		expect(bus.inbox("recipient")).toEqual([]);
	});
});
