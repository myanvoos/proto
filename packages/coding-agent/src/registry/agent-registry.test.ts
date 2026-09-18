import { expect, test } from "bun:test";
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
