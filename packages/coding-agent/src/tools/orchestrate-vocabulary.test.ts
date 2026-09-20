import { expect, test } from "bun:test";
import * as path from "node:path";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from ".";
import { FleetTool } from "./fleet";
import { OrchestrateKillTool, OrchestrateSendTool, OrchestrateSpawnTool, OrchestrateWaitTool } from "./orchestrate";

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, id: `call-${name}`, name, arguments: args };
}

function vocabularySession(registry: AgentRegistry): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "launch.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "round-trip-parent",
		getAgentId: () => "Main",
		getAgentFleetRoot: () => "/round-trip/fleet",
		agentRegistry: registry,
	};
}

test("an id emitted by worker and peer listings is accepted verbatim by every targeting input", async () => {
	const script = path.resolve(import.meta.dir, "../../test/fixtures/orchestrate-vocabulary-roundtrip.ts");
	const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const result = JSON.parse(stdout) as {
		id: string;
		label: string;
		sendId: string;
		sendMode: string;
		sendTurn: number;
		peerId: string;
		peerLabel: string;
		fleetId: string;
		fleetText: string;
		waited: { from: string; to: string; body: string };
		workerLifecycle: string;
		workerTurnState: string;
		peerLifecycle: string;
		peerTurnState: string;
		killedId: string;
	};
	expect(result).toMatchObject({
		id: "worker-round-trip",
		label: "Readable_Label",
		sendId: "worker-round-trip",
		sendMode: "queued",
		sendTurn: 2,
		peerId: "worker-round-trip",
		peerLabel: "Readable_Label",
		fleetId: "worker-round-trip",
		waited: { from: "Main", to: "worker-round-trip", body: "coordinate" },
		workerLifecycle: "parked",
		workerTurnState: "idle",
		peerLifecycle: "parked",
		peerTurnState: "idle",
		killedId: "worker-round-trip",
	});
	expect(result.fleetText).toContain("no worker turn was started");
});

test("schemas expose one canonical label, message, id, and millisecond-timeout vocabulary", async () => {
	const session = vocabularySession(new AgentRegistry());
	const spawn = new OrchestrateSpawnTool(session);
	const send = new OrchestrateSendTool(session);
	const wait = new OrchestrateWaitTool(session);
	const kill = new OrchestrateKillTool(session);
	const fleet = new FleetTool(session);

	expect(validateToolArguments(spawn, toolCall(spawn.name, { label: "Valid_Label-1", message: "inspect" }))).toEqual({
		label: "Valid_Label-1",
		message: "inspect",
	});
	for (const [tool, args] of [
		[spawn, { name: "old", prompt: "old" }],
		[send, { worker: "old", message: "old" }],
		[send, { id: "old", message: "old" }],
		[wait, { workers: ["old"], timeout: 1 }],
		[kill, { worker: "old" }],
	] as const) {
		await expect(Reflect.apply(tool.execute, tool, [`legacy-${tool.name}`, args])).rejects.toThrow("Unknown");
	}
	const legacyFleet = await Reflect.apply(fleet.execute, fleet, [
		"legacy-fleet",
		{ op: "send", id: "old", message: "old" },
	]);
	expect(legacyFleet).toMatchObject({ isError: true });
	expect(legacyFleet.content[0]).toMatchObject({ text: expect.stringContaining("Unknown fleet parameter") });
	// Bare to + message routes to send (unknown-recipient rejection), never an op-required error.
	const inferredSend = await Reflect.apply(fleet.execute, fleet, ["inferred-send", { to: "someone", message: "old" }]);
	expect(inferredSend).toMatchObject({ isError: true });
	const inferredText = inferredSend.content[0].type === "text" ? inferredSend.content[0].text : "";
	expect(inferredText).not.toContain("`op` is required");
	expect(inferredText).toContain("No recipients accepted");
	const legacyReady = await Reflect.apply(fleet.execute, fleet, [
		"legacy-ready",
		{ op: "start", name: "server", application: "server", ready: { log: "ready", timeout: 30 } },
	]);
	expect(legacyReady).toMatchObject({ isError: true });
	expect(legacyReady.content[0]).toMatchObject({ text: "Unknown fleet readiness parameter." });
	for (const label of ["not a label", "!!!"]) {
		await expect(spawn.execute("invalid-label", { label, message: "inspect" })).rejects.toThrow(
			"Worker label must be 1–48 characters",
		);
	}

	const spawnProperties = toolWireSchema(spawn).properties as Record<string, unknown>;
	expect(Object.keys(spawnProperties)).not.toContain("name");
	expect(Object.keys(spawnProperties)).not.toContain("prompt");
	const sendProperties = toolWireSchema(send).properties as Record<string, unknown>;
	expect(Object.keys(sendProperties)).not.toContain("worker");
	expect(Object.keys(sendProperties)).not.toContain("id");
	expect(Object.keys(sendProperties)).toContain("to");
	expect(validateToolArguments(send, toolCall(send.name, { to: "worker-round-trip", message: "go" }))).toEqual({
		to: "worker-round-trip",
		message: "go",
	});
	const killProperties = toolWireSchema(kill).properties as Record<string, unknown>;
	expect(Object.keys(killProperties)).not.toContain("worker");
	const waitSchema = toolWireSchema(wait);
	const waitProperties = waitSchema.properties as Record<string, unknown>;
	expect(Object.keys(waitProperties)).toContain("timeoutMs");
	expect(Object.keys(waitProperties)).not.toContain("timeout");
	expect(Object.keys(waitProperties)).not.toContain("workers");
	const fleetSchema = toolWireSchema(fleet);
	const fleetProperties = fleetSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
	expect(Object.keys(fleetProperties)).toContain("timeoutMs");
	expect(Object.keys(fleetProperties)).not.toContain("timeout");
	expect(Object.keys(fleetProperties)).toContain("to");
	expect(Object.keys(fleetProperties)).toContain("from");
	expect(Object.keys(fleetProperties)).not.toContain("id");
	expect(fleetSchema.required ?? []).not.toContain("op");
	expect(Object.keys(fleetProperties.ready?.properties ?? {})).toContain("timeoutMs");
	expect(Object.keys(fleetProperties.ready?.properties ?? {})).not.toContain("timeout");
});
