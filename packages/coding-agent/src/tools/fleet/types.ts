/**
 * Shared types for the fleet tool — the merged agent-coordination surface
 * covering peer messaging (IRC bus), background-job control, and supervised
 * long-running processes (launch).
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJobType } from "../../async";
import type { IrcDeliveryReceipt, IrcMessage } from "../../irc/bus";
import type { LaunchParams, LaunchToolDetails } from "./launch";

/**
 * Fleet operations: messaging (`send`/`wait`/`inbox`/`list`), jobs
 * (`wait`/`cancel`/`jobs`), and process supervision (`start`/`ps`/`logs`/
 * `stop`/`restart`/`describe`, plus `send`/`wait` when they carry `name`).
 */
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

/** Peer row surfaced by `op:"list"`. */
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

/** Background-job row surfaced by `wait`/`cancel`/`jobs` results. */
export interface JobSnapshot {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	/** Effective task model selector, including an explicit reasoning suffix when configured. */
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

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * a fleet message, or a spawn owned by another agent. Surfaced by `jobs` and
 * empty-wait snapshots so the fleet's picture matches the UI's running-agent
 * count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
	/**
	 * Whether an attached session corroborates the `running` claim. False marks
	 * a ref that says `running` with no turn in flight — either a spawn still
	 * wiring up or a stale registration that `fleet cancel <id>` clears (#8634).
	 */
	live: boolean;
}

/** Result details for messaging and job ops; fields are disjoint per op. */
export interface CoordinationDetails {
	op: FleetOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: FleetPeerInfo[];
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
}

/** Fleet result details: coordination snapshots or launch (process) state. */
export type FleetDetails = CoordinationDetails | LaunchToolDetails;

/** Partially-streamed fleet call arguments, as seen by the renderers. */
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
