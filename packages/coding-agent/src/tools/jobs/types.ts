import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJobEvent, AsyncJobEventPage, AsyncJobType } from "../../async";
import type { IrcMessage } from "../../irc/bus";
import type { ExecutionRef, JobRef, ProcessRef, WatchRef } from "../../jobs/contracts";
import type { MonitorDetails } from "../../monitor/types";
import type { LaunchToolDetails } from "./launch";

export type JobsOp =
	| "list"
	| "inspect"
	| "start"
	| "logs"
	| "input"
	| "signal"
	| "restart"
	| "cancel"
	| "watch"
	| "unwatch"
	| "wait";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

/** A finite job (bash/worker turn) or a watch subscription, observed without acknowledgement. */
export interface JobSnapshot {
	ref: JobRef | WatchRef;
	type: AsyncJobType;
	status: JobStatus;
	/** False while a cancelled job's callback or helper process is still tearing down. */
	settled: boolean;
	label: string;
	durationMs: number;
	agentId?: string;
	watch?: MonitorDetails;
	/** Watch events consumed by this result (wait only). */
	events?: AsyncJobEvent[];
	resolvedModel?: string;
	resultText?: string;
	rawArtifactId?: string;
	errorText?: string;
}

/**
 * `requested`: cancellation was accepted but teardown has not settled within the grace window.
 * `settled`: the execution (and any helper it owns) finished tearing down.
 */
export interface CancelReceipt {
	ref: ExecutionRef;
	status: "settled" | "requested" | "already_settled";
	message: string;
}

export interface JobsDetails {
	op: JobsOp;
	jobs?: JobSnapshot[];
	/** Process-control result from the broker (start/list/logs/input/signal/restart/cancel/inspect). */
	process?: LaunchToolDetails;
	/** A reference created or replaced by this call. */
	ref?: ExecutionRef;
	/** Non-consuming watch event page (inspect). */
	events?: AsyncJobEventPage;
	receipt?: CancelReceipt;
	/** Wait: the mailbox message that won. */
	message?: IrcMessage;
	/** Wait: process targets that exited. */
	exited?: ProcessRef[];
	/** Wait: the window elapsed with nothing to report. */
	timedOut?: boolean;
}

export type JobsResult = AgentToolResult<JobsDetails>;

export function jobsErrorResult(text: string, op: JobsOp): JobsResult {
	return { content: [{ type: "text", text }], details: { op }, isError: true };
}
