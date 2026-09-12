import { expect, test } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { countRunningSubagentBadgeAgents } from "./running-subagent-badge";

test("the running-agent badge excludes agents from previous session fleets", () => {
	const registry = new AgentRegistry();
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		session: null,
		fleetRoot: "/current/fleet",
	});
	registry.register({
		id: "current-worker",
		displayName: "current",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: null,
		status: "running",
	});
	registry.register({
		id: "previous-worker",
		displayName: "previous",
		kind: "sub",
		session: null,
		fleetRoot: "/previous/fleet",
		status: "running",
	});

	expect(countRunningSubagentBadgeAgents(registry, MAIN_AGENT_ID)).toBe(1);
});
