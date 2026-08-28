import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJobType } from "../../async";
import type { IrcDeliveryReceipt, IrcMessage } from "../../irc/bus";
import type { LaunchParams, LaunchToolDetails } from "./launch";

type FleetOp =
	| "send"
	| "wait"
	| "inbox"
	| "list"
	| "jobs"
	| "cancel"
	| "start"
	| "ps"
	| "logs"
	| "stop"
	| "restart"
	| "describe";

interface FleetPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
}

export interface JobSnapshot {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;

	resolvedModel?: string;
	resultText?: string;
	errorText?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;

	activity?: string;

	ageMs: number;

	live: boolean;
}

export interface CoordinationDetails {
	op: FleetOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];

	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: FleetPeerInfo[];
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];

	agents?: AgentActivitySnapshot[];
}

export type FleetDetails = CoordinationDetails | LaunchToolDetails;

export type FleetRenderArgs = {
	op?: string;
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	from?: string;
	timeoutMs?: number;
	peek?: boolean;
	ids?: string[];
} & Partial<Omit<LaunchParams, "op">>;

export function fleetErrorResult(text: string, details: CoordinationDetails): AgentToolResult<FleetDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}
