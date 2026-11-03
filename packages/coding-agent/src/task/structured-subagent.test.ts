import { afterEach, describe, expect, it, vi } from "bun:test";
import { invalidModelSelectorReason } from "../config/model-resolver";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import * as discovery from "./discovery";
import { resolveEffectiveSubagentPolicy } from "./structured-subagent";

describe("subagent model selector validation", () => {
	it("rejects default/inherit selectors with thinking suffixes", () => {
		expect(invalidModelSelectorReason("default:high", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("DEFAULT:high", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("inherit:low", "Subagent")).toContain("@default");
		expect(invalidModelSelectorReason("@default:high", "Subagent")).toBeUndefined();
	});
});

afterEach(() => vi.restoreAllMocks());

it("concurrent preflights share one discovery but later spawns rescan", async () => {
	const scan = Promise.withResolvers<discovery.DiscoveryResult>();
	const entered = Promise.withResolvers<void>();
	const discover = vi.spyOn(discovery, "discoverAgents").mockImplementation(() => {
		entered.resolve();
		return scan.promise;
	});
	const session = {
		cwd: "/tmp/shared-preflight",
		settings: Settings.isolated(),
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	const request = { session, invocationKind: "eval" as const, agent: "worker", assignment: "inspect" };
	const first = resolveEffectiveSubagentPolicy(request);
	const second = resolveEffectiveSubagentPolicy(request);
	await entered.promise;
	await Promise.resolve();
	scan.resolve({
		agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled" }],
		projectAgentsDir: null,
		searchedDirs: [],
	});
	const policies = await Promise.all([first, second]);
	expect(policies.map(policy => policy.agentName)).toEqual(["worker", "worker"]);
	expect(discover).toHaveBeenCalledTimes(1);
	await resolveEffectiveSubagentPolicy(request);
	expect(discover).toHaveBeenCalledTimes(2);
});
