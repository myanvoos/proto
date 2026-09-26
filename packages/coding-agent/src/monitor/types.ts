import type { AsyncJob } from "../async/job-manager";

/**
 * `stream` follows one long-running process and reports each matching output line.
 * `poll` re-runs a short command on an interval and reports each changed, matching output.
 */
export type MonitorMode = "stream" | "poll";

export type MonitorStopReason = "manual" | "exit" | "limit" | "timeout" | "error" | "session";

export interface MonitorStartSpec {
	command: string;

	label?: string;

	cwd?: string;

	/** JS `RegExp` source compiled with the `u` flag; only matching output is reported. */
	match?: string;

	/** Poll interval in seconds. Omitted selects `stream` mode. */
	everySeconds?: number;

	/** Matching output events before the monitor stops itself; terminal status does not count. */
	maxEvents?: number;

	/** Wall-clock lifetime in seconds. */
	timeoutSeconds?: number;
}

/** Mutable monitoring metadata; job identity and lifecycle live in AsyncJob. */
export interface MonitorDetails {
	command: string;
	cwd: string;
	mode: MonitorMode;
	match?: string;
	stoppedAt?: number;
	stopReason?: MonitorStopReason;
	exitCode?: number;
	eventCount: number;
	maxEvents: number;
	everySeconds?: number;
	timeoutSeconds?: number;
	lastEventAt?: number;
}

export interface MonitorSnapshot extends MonitorDetails {
	id: string;
	label: string;
	status: AsyncJob["status"];
	startTime: number;
}
