import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { describeUnknownAgent, resolveSpawnPreflight } from "./spawn-policy";
import { canSpawnAtDepth } from "./types";

// `orchestrator.maxRecursionDepth` counts levels of worker-spawned workers, which is what its
// settings labels promise (0 none, 1 single, 2 double). Pin that ladder: the main agent always may
// spawn, and each cap allows exactly that many nested worker generations.
test("the recursion cap counts levels of worker-spawned workers", () => {
	expect([0, 1, 2, 3].map(depth => canSpawnAtDepth(0, depth))).toEqual([true, false, false, false]);
	expect([0, 1, 2, 3].map(depth => canSpawnAtDepth(1, depth))).toEqual([true, true, false, false]);
	expect([0, 1, 2, 3].map(depth => canSpawnAtDepth(2, depth))).toEqual([true, true, true, false]);
	expect([0, 1, 2, 3].map(depth => canSpawnAtDepth(-1, depth))).toEqual([true, true, true, true]);
});

test("the refusal explains the cap it enforces instead of contradicting the depths that exist", () => {
	const refused = resolveSpawnPreflight({
		requestedAgent: "worker",
		parentSpawns: "*",
		taskDepth: 3,
		maxRecursionDepth: 2,
	});

	// The old text claimed "maximum depth is 2" while workers demonstrably ran at depth 3.
	expect(refused.error).toBe(
		"Cannot spawn another agent at task depth 3: orchestrator.maxRecursionDepth=2 allows spawning " +
			"only from task depth 2 or shallower, so workers run at most 3 levels below the main agent.",
	);
	expect(refused.error).not.toContain("maximum depth is");
});

test("a worker inside the cap is not refused on depth", () => {
	expect(
		resolveSpawnPreflight({ requestedAgent: "worker", parentSpawns: "*", taskDepth: 2, maxRecursionDepth: 2 }).error,
	).toBeUndefined();
});

// A misplaced agent file used to get only the list of agents found, with no hint of where discovery looked.
test("an unknown agent names the directories discovery searched", () => {
	const message = describeUnknownAgent("reviewr", {
		agents: [{ name: "worker", description: "", systemPrompt: "", source: "bundled" }],
		searchedDirs: [path.join(os.homedir(), ".proto", "agent", "agents"), "/repo/.proto/agents"],
	});
	expect(message).toBe(
		'Unknown agent "reviewr". Available: worker. Searched: ~/.proto/agent/agents, /repo/.proto/agents',
	);
});
