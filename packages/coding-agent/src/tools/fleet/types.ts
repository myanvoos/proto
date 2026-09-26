import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcDeliveryReceipt, IrcMessage } from "../../irc/bus";
import type { JobRef } from "../../jobs/contracts";
import type { KillOutcome, WorkerReceipt, WorkerReceiptStatus, WorkerScreen } from "../../orchestrator/runtime";

export type FleetOp = "spawn" | "send" | "message" | "list" | "inspect" | "inbox" | "terminate";

export type FleetListScope = "owned" | "visible";

export interface FleetPeerInfo {
	id: string;
	label: string;
	kind: string;
	lifecycle: "live" | "parked" | "terminal";
	turnState?: "running" | "idle";
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
}

/** Tracked worker input: the turn it became and the execution that runs it. */
export interface FleetTurnReceipt {
	workerId: string;
	label: string;
	turn: number;
	job: JobRef;
	status: WorkerReceiptStatus;
	/** `turn` started a new turn, `steered` joined the running one, `queued` waits behind it. */
	mode: "turn" | "steered" | "queued";
}

export interface FleetDetails {
	op?: FleetOp;
	senderId?: string;
	scope?: FleetListScope;
	/** Owned workers (list/inspect/spawn/send/terminate). */
	screens?: WorkerScreen[];
	spawned?: { id: string; label: string; agent: string };
	receipt?: FleetTurnReceipt;
	/** Rejected or terminal receipt for tracked input the runtime refused. */
	rejected?: WorkerReceipt;
	terminated?: KillOutcome;
	/** Peer message recipient (`message`). */
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	inbox?: IrcMessage[];
	peers?: FleetPeerInfo[];
}

export interface FleetRenderArgs {
	op?: string;
	agent?: string;
	label?: string;
	id?: string;
	to?: string;
	message?: string;
	model?: string;
	replyTo?: string;
	peek?: boolean;
	scope?: string;
	isolated?: boolean;
}

export function fleetErrorResult(text: string, details: FleetDetails): AgentToolResult<FleetDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}
