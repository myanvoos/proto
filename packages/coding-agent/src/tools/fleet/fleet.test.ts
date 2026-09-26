import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "../../async/job-manager";
import { resolveAgentSpawnModelSelection } from "../../config/model-resolver";
import { Settings } from "../../config/settings";
import { IrcBus } from "../../irc/bus";
import { OrchestratorRuntime } from "../../orchestrator/runtime";
import { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import { type FleetDetails, FleetTool } from ".";

const FLEET_ROOT = "/fleet-test/fleet";
const WORKER_ID = "worker-round-trip";
const LABEL = "Readable_Label";
const managers: AsyncJobManager[] = [];

function resetGlobals(): void {
	OrchestratorRuntime.resetGlobalForTests();
	// The bus binds the registry that is global when it is created; reset it after the registry.
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
}

beforeEach(resetGlobals);
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
	resetGlobals();
});

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions", reasoning: false } as unknown as Model<Api>;
}

const AVAILABLE = [model("localprov", "local-stream"), model("localprov", "local-fast")];

function fleetSession(overrides: Partial<ToolSession> = {}): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	managers.push(manager);
	return {
		cwd: path.resolve(import.meta.dir, "../../.."),
		hasUI: false,
		settings: Settings.isolated({ modelRoles: { worker: "localprov/local-stream" } }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "fleet-parent",
		getAsyncJobOwnerId: () => "fleet-parent",
		getAgentId: () => "Main",
		getAgentFleetRoot: () => FLEET_ROOT,
		agentRegistry: AgentRegistry.global(),
		modelRegistry: { getAvailable: () => AVAILABLE, getApiKey: async () => undefined },
		asyncJobManager: manager,
		...overrides,
	} as unknown as ToolSession;
}

/** A busy owned worker (turn 1 running) that is registered as a visible peer of Main. */
function registerBusyWorker(): void {
	const registry = AgentRegistry.global();
	registry.register({ id: "Main", label: "Main", kind: "main", session: null, fleetRoot: FLEET_ROOT, status: "idle" });
	registry.register({
		id: WORKER_ID,
		label: LABEL,
		kind: "sub",
		parentId: "Main",
		session: null,
		fleetRoot: FLEET_ROOT,
		status: "running",
	});
	OrchestratorRuntime.global().registerRecordForTests({
		id: WORKER_ID,
		label: LABEL,
		ownerId: "Main",
		parentSessionId: "fleet-parent",
		state: "running",
		jobId: `${WORKER_ID}-t1`,
	});
}

function text(result: AgentToolResult<FleetDetails>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

async function run(fleet: FleetTool, params: Record<string, unknown>): Promise<AgentToolResult<FleetDetails>> {
	return Reflect.apply(fleet.execute, fleet, ["call", params]) as Promise<AgentToolResult<FleetDetails>>;
}

test("ids from owned and visible listings route tracked sends, peer messages, and termination; labels never route", async () => {
	registerBusyWorker();
	const session = fleetSession();
	const manager = session.asyncJobManager!;
	const fleet = new FleetTool(session);

	const owned = await run(fleet, { op: "list" });
	expect(owned.details).toMatchObject({ scope: "owned", screens: [{ id: WORKER_ID, label: LABEL }] });
	const visible = await run(fleet, { op: "list", scope: "visible" });
	expect(visible.details?.peers).toMatchObject([{ id: WORKER_ID, label: LABEL }]);

	// A label is display text: it resolves no worker and allocates no turn job.
	const byLabel = await run(fleet, { op: "send", id: LABEL, message: "continue" });
	expect(byLabel.isError).toBe(true);
	expect(text(byLabel)).toContain(`Unknown worker "${LABEL}"`);
	expect(manager.getAllJobs()).toHaveLength(0);

	// Tracked send to a busy worker reserves a real queued job the caller can wait on.
	const sent = await run(fleet, { op: "send", id: WORKER_ID, message: "continue" });
	expect(sent.details?.receipt).toMatchObject({ workerId: WORKER_ID, turn: 2, status: "queued", mode: "queued" });
	const queuedJob = sent.details?.receipt?.job;
	expect(queuedJob?.kind).toBe("job");
	expect(manager.getJob(queuedJob!.id)).toMatchObject({ status: "running", queued: true, agentId: WORKER_ID });
	const inspected = await run(fleet, { op: "inspect", id: WORKER_ID });
	expect(inspected.details?.screens).toMatchObject([{ turnJobId: `${WORKER_ID}-t1`, queuedJobIds: [queuedJob!.id] }]);

	// A peer message is transport only: delivery receipts, never a tracked turn.
	const waiting = IrcBus.global().wait(WORKER_ID, { from: "Main" }, 1_000, undefined, { fleetRoot: FLEET_ROOT });
	const messaged = await run(fleet, { op: "message", to: WORKER_ID, message: "coordinate" });
	expect(await waiting).toMatchObject({ from: "Main", to: WORKER_ID, body: "coordinate" });
	expect(messaged.details?.receipt).toBeUndefined();
	expect(messaged.details?.receipts).toMatchObject([{ to: WORKER_ID, outcome: "delivered" }]);
	expect(manager.getAllJobs()).toHaveLength(1);

	// Terminate tombstones the worker and discards its queued turn job.
	const terminated = await run(fleet, { op: "terminate", id: WORKER_ID });
	expect(terminated.details?.terminated).toMatchObject({ id: WORKER_ID, receipt: { status: "terminal" } });
	await manager.getJob(queuedJob!.id)?.promise;
	expect(manager.getJob(queuedJob!.id)?.status).toBe("cancelled");
	const afterTerminate = await run(fleet, { op: "send", id: WORKER_ID, message: "again" });
	expect(afterTerminate.isError).toBe(true);
	expect(afterTerminate.details?.rejected).toMatchObject({ workerId: WORKER_ID, status: "terminal" });
});

test("per-op validation rejects unknown, irrelevant, missing, and legacy fields before any side effect", async () => {
	registerBusyWorker();
	const session = fleetSession();
	const fleet = new FleetTool(session);
	const cases: Array<[Record<string, unknown>, string]> = [
		[{ to: WORKER_ID, message: "no op" }, "`op` is required"],
		[{ op: "wait" }, "`op` is required"],
		[{ op: "list", ids: ["job-1"] }, "Unknown fleet parameter: ids"],
		[{ op: "send", to: WORKER_ID, message: "peer shape on tracked send" }, 'op "send" does not accept to'],
		[{ op: "message", to: WORKER_ID, message: "m", model: "x" }, 'op "message" does not accept model'],
		[{ op: "send", id: WORKER_ID }, 'op "send" requires message'],
		[{ op: "spawn", message: "m", label: "not a label" }, "Worker label must be 1–48 characters"],
		[{ op: "list", scope: "all" }, 'Invalid scope "all"'],
	];
	for (const [params, expected] of cases) {
		const result = await run(fleet, params);
		expect(result.isError, JSON.stringify(params)).toBe(true);
		expect(text(result)).toContain(expected);
	}
	expect(session.asyncJobManager!.getAllJobs()).toHaveLength(0);
	expect(OrchestratorRuntime.global().screens(session)).toMatchObject([{ id: WORKER_ID, queued: 0 }]);
});

test("worker control and peer messaging are authorized independently in the handler", async () => {
	registerBusyWorker();
	// Messaging disabled: owned worker control still reaches spawn preflight; peer ops are refused.
	const quiet = new FleetTool(fleetSession({ enableIrc: false }));
	const spawnWithoutMessaging = await run(quiet, { op: "spawn", message: "work", model: "nonexistent/model-xyz" });
	expect(text(spawnWithoutMessaging)).toContain("did not match any available model");
	for (const params of [
		{ op: "message", to: "Main", message: "hi" },
		{ op: "inbox" },
		{ op: "list", scope: "visible" },
	]) {
		expect(text(await run(quiet, params))).toContain("Peer messaging is unavailable");
	}
	expect((await run(quiet, { op: "list" })).details?.screens).toMatchObject([{ id: WORKER_ID }]);

	// Beyond the recursion limit: no spawning or tracked turns, but parent messaging and inbox remain.
	const deep = fleetSession({ taskDepth: 5, getAgentId: () => WORKER_ID });
	const nested = new FleetTool(deep);
	for (const params of [
		{ op: "spawn", message: "work" },
		{ op: "send", id: WORKER_ID, message: "work" },
	]) {
		expect(text(await run(nested, params))).toContain("Worker control is unavailable at task depth 5");
	}
	expect(deep.asyncJobManager!.getAllJobs()).toHaveLength(0);
	const toParent = await run(nested, { op: "message", to: "Main", message: "blocked on auth choice" });
	expect(toParent.details?.receipts).toMatchObject([{ to: "Main" }]);
	expect((await run(nested, { op: "inbox" })).isError).not.toBe(true);

	// A spawn policy that allows no workers is enforced even at depth 0.
	const locked = new FleetTool(fleetSession({ getSessionSpawns: () => "" }));
	expect(text(await run(locked, { op: "spawn", message: "work" }))).toContain("spawn policy allows no workers");
});

test("an unresolvable model or role is refused at spawn time and allocates no worker or job", async () => {
	const session = fleetSession();
	const fleet = new FleetTool(session);
	const badModel = await run(fleet, { op: "spawn", message: "work", model: "nonexistent/model-xyz" });
	expect(badModel.isError).toBe(true);
	expect(text(badModel)).toContain("did not match any available model");
	expect(text(badModel)).toContain("localprov/local-stream");
	const badRole = await run(fleet, { op: "spawn", message: "work", model: "@nosuchrole" });
	expect(text(badRole)).toContain("Unknown model role");
	expect(text(badRole)).toContain("@worker");
	expect(OrchestratorRuntime.global().screens(session)).toEqual([]);
	expect(session.asyncJobManager!.getAllJobs()).toHaveLength(0);
});

test("a resolvable request, an inherited default and a registry-less session all stay accepted", () => {
	const settings = Settings.isolated({ modelRoles: { worker: "localprov/local-stream" } });
	const modelRegistry = { getAvailable: () => AVAILABLE };
	expect(
		resolveAgentSpawnModelSelection({ requestModel: "localprov/local-fast", settings, modelRegistry }).requestError,
	).toBeUndefined();
	expect(
		resolveAgentSpawnModelSelection({ requestModel: "@worker", settings, modelRegistry }).requestError,
	).toBeUndefined();
	// Nothing the caller asked for: an agent-declared or inherited pattern is not the caller's contract.
	expect(
		resolveAgentSpawnModelSelection({ agentModel: "gone/model", settings, modelRegistry }).requestError,
	).toBeUndefined();
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
