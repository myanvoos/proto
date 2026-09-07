/** Lifecycle of a monitor. Monitors are session-scoped: they never outlive the session that started them. */
export type MonitorStatus = "running" | "stopped";

/**
 * `stream` follows one long-running process and reports each matching output line.
 * `poll` re-runs a short command on an interval and reports each changed, matching output.
 */
export type MonitorMode = "stream" | "poll";

export type MonitorStopReason = "manual" | "exit" | "limit" | "timeout" | "error" | "session";

export type MonitorEventKind = "output" | "exit" | "limit" | "timeout" | "error";

export interface MonitorStartSpec {
	command: string;

	label?: string;

	cwd?: string;

	/** JS `RegExp` source compiled with the `u` flag; only matching output is reported. */
	match?: string;

	/** Poll interval in seconds. Omitted selects `stream` mode. */
	everySeconds?: number;

	/** Events delivered before the monitor stops itself. */
	maxEvents?: number;

	/** Wall-clock lifetime in seconds. */
	timeoutSeconds?: number;
}

export interface MonitorEvent {
	monitorId: string;
	label: string;
	kind: MonitorEventKind;
	text: string;

	/** 1-based position within this monitor's event stream. */
	sequence: number;
	timestamp: number;
}

export interface MonitorSnapshot {
	id: string;
	label: string;
	command: string;
	cwd: string;
	mode: MonitorMode;
	match?: string;
	status: MonitorStatus;
	startedAt: number;
	stoppedAt?: number;
	stopReason?: MonitorStopReason;
	exitCode?: number;
	eventCount: number;
	maxEvents: number;
	everySeconds?: number;
	timeoutSeconds?: number;
	lastEventAt?: number;
}
