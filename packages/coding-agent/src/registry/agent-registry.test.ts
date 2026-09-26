import { expect, test } from "bun:test";
import { collectWeakRefs } from "../../test/fixtures/worker-lifecycle";
import { AgentRegistry } from "./agent-registry";

test("fleet listings track replacement, scope changes, and removal without leaking stale registrations", () => {
	const registry = new AgentRegistry();
	registry.register({
		id: "Main",
		label: "main-a",
		kind: "main",
		session: null,
		fleetRoot: "/fleet-a",
	});
	registry.register({
		id: "Main",
		label: "main-b",
		kind: "main",
		session: null,
		fleetRoot: "/fleet-b",
	});
	const replaced = registry.register({
		id: "worker",
		label: "old worker",
		kind: "sub",
		session: null,
		fleetRoot: "/fleet-a",
	});
	const current = registry.register({
		id: "worker",
		label: "current worker",
		kind: "sub",
		session: null,
		fleetRoot: "/fleet-b",
	});

	expect(registry.listInFleet("Main", "/fleet-a").map(ref => ref.label)).toEqual(["main-a"]);
	expect(registry.listInFleet("Main", "/fleet-b").map(ref => ref.label)).toEqual(["main-b", "current worker"]);
	expect(registry.updateSessionScope("worker", { fleetRoot: "/fleet-a", sessionFile: null }, current)).toBe(true);
	expect(registry.listInFleet("Main", "/fleet-b").map(ref => ref.label)).toEqual(["main-b"]);
	expect(registry.listInFleet("Main", "/fleet-a").map(ref => ref.label)).toEqual(["main-a", "current worker"]);
	expect(registry.unregister("worker", current)).toBe(true);
	expect(registry.unregister("worker", replaced)).toBe(false);
	expect(registry.listInFleet("Main", "/fleet-a").map(ref => ref.label)).toEqual(["main-a"]);
});

test("dormant registry identities collect while fleet lookup and ownership checks remain resumable", async () => {
	const registry = new AgentRegistry();
	const refs = Array.from(
		{ length: 32 },
		(_, index) =>
			new WeakRef(
				registry.register({
					id: `parked-${index}`,
					label: `worker ${index}`,
					kind: "sub",
					parentId: "Main",
					fleetRoot: "/retired-fleet",
					session: null,
					sessionFile: `/retired-fleet/parked-${index}.jsonl`,
					status: "parked",
				}),
			),
	);
	expect(await collectWeakRefs(refs)).toBe(refs.length);
	const restored = registry.get("parked-0")!;
	expect(restored).toMatchObject({ status: "parked", parentId: "Main", sessionFile: "/retired-fleet/parked-0.jsonl" });
	expect(registry.listInFleet("Main", "/retired-fleet")).toHaveLength(32);
	expect(
		registry.registerIfAvailable({ id: restored.id, label: "revival", kind: "sub", session: null }, restored),
	).toBe(restored);
	registry.setHistory(restored.id, { resolvedModel: "test/resumed" });
	expect(registry.get(restored.id)?.history?.resolvedModel).toBe("test/resumed");
	const replacement = registry.register({
		id: restored.id,
		label: "replacement",
		kind: "sub",
		session: null,
		status: "parked",
	});
	expect(registry.unregister(restored.id, restored)).toBe(false);
	expect(registry.get(restored.id)).toBe(replacement);
	expect(registry.listInFleet("Main", "/retired-fleet")).toHaveLength(31);
});
