import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { ToolSession } from "../../src/tools";
import { FleetTool } from "../../src/tools/fleet";
import { OrchestrateKillTool, OrchestrateListTool, OrchestrateSendTool } from "../../src/tools/orchestrate";

AgentRegistry.resetGlobalForTests();
OrchestratorRuntime.resetGlobalForTests();
IrcBus.resetGlobalForTests();
const registry = AgentRegistry.global();
registry.register({
	id: "Main",
	label: "Main",
	kind: "main",
	session: null,
	fleetRoot: "/round-trip/fleet",
	status: "idle",
});
registry.register({
	id: "worker-round-trip",
	label: "Readable_Label",
	kind: "sub",
	parentId: "Main",
	session: null,
	fleetRoot: "/round-trip/fleet",
	status: "running",
});
const runtime = OrchestratorRuntime.global();
runtime.registerRecordForTests({
	id: "worker-round-trip",
	label: "Readable_Label",
	ownerId: "Main",
	parentSessionId: "round-trip-parent",
	state: "running",
	jobId: "worker-round-trip-t1",
});
const session: ToolSession = {
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
const listed = await new OrchestrateListTool(session).execute();
const id = listed.details?.screens[0]?.id;
if (!id) throw new Error("Worker listing did not return an id");
const sent = await new OrchestrateSendTool(session).execute("send-round-trip", { to: id, message: "continue" });
const fleet = new FleetTool(session);
const peers = await fleet.execute("list-peers", { op: "list" });
const peerId = peers.details && "peers" in peers.details ? peers.details.peers?.[0]?.id : undefined;
if (!peerId) throw new Error("Fleet listing did not return a peer id");
const waiting = IrcBus.global().wait(peerId, { from: "Main" }, 1_000, undefined, {
	fleetRoot: "/round-trip/fleet",
});
const delivered = await fleet.execute("send-peer", { to: peerId, message: "coordinate" });
const waited = await waiting;
registry.setStatus(peerId, "parked");
const parkedWorker = (await new OrchestrateListTool(session).execute()).details?.screens.find(
	screen => screen.id === peerId,
);
const parkedPeers = await fleet.execute("list-parked-peer", { op: "list" });
const parkedPeer =
	parkedPeers.details && "peers" in parkedPeers.details
		? parkedPeers.details.peers?.find(peer => peer.id === peerId)
		: undefined;
const killed = await new OrchestrateKillTool(session).execute("kill-round-trip", { id });
console.log(
	JSON.stringify({
		id,
		label: listed.details?.screens[0]?.label,
		sendId: sent.details?.send?.id,
		sendMode: sent.details?.send?.mode,
		sendTurn: sent.details?.send?.receipt.turn,
		peerId,
		peerLabel:
			peers.details && "peers" in peers.details
				? peers.details.peers?.find(peer => peer.id === peerId)?.label
				: undefined,
		fleetId: delivered.details && "id" in delivered.details ? delivered.details.id : undefined,
		fleetText: delivered.content[0]?.type === "text" ? delivered.content[0].text : "",
		waited,
		workerLifecycle: parkedWorker?.lifecycle,
		workerTurnState: parkedWorker?.turnState,
		peerLifecycle: parkedPeer?.lifecycle,
		peerTurnState: parkedPeer?.turnState,
		killedId: killed.details?.killed?.id,
	}),
);
