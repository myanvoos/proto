import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "../async/job-manager";
import { resolveAgentSpawnModelSelection } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from ".";
import { OrchestrateListTool, OrchestrateSpawnTool } from "./orchestrate";

// Contract: `model` is validated at spawn time like `agent`, `label` and `effort`. A model the
// session cannot resolve must be refused while the caller is still holding the tool result,
// never accepted with a success receipt that turns into a failed turn one round later.
function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions", reasoning: false } as unknown as Model<Api>;
}

const AVAILABLE = [model("localprov", "local-stream"), model("localprov", "local-fast")];
const managers: AsyncJobManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
});

function spawnSession(available: Model<Api>[] = AVAILABLE): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.push(manager);
	return {
		cwd: path.resolve(import.meta.dir, "../.."),
		hasUI: false,
		settings: Settings.isolated({ modelRoles: { worker: "localprov/local-stream" } }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "spawn-model-parent",
		getAgentId: () => "Main",
		getAgentFleetRoot: () => "/spawn-model/fleet",
		agentRegistry: new AgentRegistry(),
		modelRegistry: { getAvailable: () => available, getApiKey: async () => undefined },
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

async function spawnError(session: ToolSession, model: string): Promise<string> {
	const spawn = new OrchestrateSpawnTool(session);
	try {
		await spawn.execute("spawn-model", { message: "work", model });
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`expected orchestrate_spawn(model: ${model}) to be rejected`);
}

async function workerRows(session: ToolSession): Promise<string> {
	const list = new OrchestrateListTool(session);
	const result = await list.execute();
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("a model no available model matches is refused at spawn time, naming what is available", async () => {
	const session = spawnSession();
	const message = await spawnError(session, "nonexistent/model-xyz");
	expect(message).toContain("nonexistent/model-xyz");
	expect(message).toContain("did not match any available model");
	expect(message).toContain("localprov/local-stream");
	// No worker may exist: the rejection replaces the spawn, it does not follow it.
	expect(await workerRows(session)).not.toContain("nonexistent/model-xyz");
});

test("an unknown role alias is refused at spawn time and the known roles are listed", async () => {
	const session = spawnSession();
	const message = await spawnError(session, "@nosuchrole");
	expect(message).toContain("Unknown model role");
	expect(message).toContain("@nosuchrole");
	expect(message).toContain("@worker");
	expect(await workerRows(session)).not.toContain("nosuchrole");
});

test("a resolvable request, an inherited default and a registry-less session all stay accepted", () => {
	const settings = Settings.isolated({ modelRoles: { worker: "localprov/local-stream" } });
	const modelRegistry = { getAvailable: () => AVAILABLE };
	// The caller's model resolves.
	expect(
		resolveAgentSpawnModelSelection({ requestModel: "localprov/local-fast", settings, modelRegistry }).requestError,
	).toBeUndefined();
	// A role alias the session knows resolves through the role.
	expect(
		resolveAgentSpawnModelSelection({ requestModel: "@worker", settings, modelRegistry }).requestError,
	).toBeUndefined();
	// Nothing the caller asked for: an agent-declared or inherited pattern is not the caller's contract.
	expect(
		resolveAgentSpawnModelSelection({ agentModel: "gone/model", settings, modelRegistry }).requestError,
	).toBeUndefined();
	// Without a registry, or with one that lists nothing, there is nothing to judge against.
	expect(
		resolveAgentSpawnModelSelection({ requestModel: "nonexistent/model-xyz", settings }).requestError,
	).toBeUndefined();
	expect(
		resolveAgentSpawnModelSelection({
			requestModel: "nonexistent/model-xyz",
			settings,
			modelRegistry: { getAvailable: () => [] },
		}).requestError,
	).toBeUndefined();
});
