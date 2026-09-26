import type { AsyncJob } from "../async/job-manager";
import type { JobRef, ProcessRef } from "../jobs/contracts";

/**
 * `stream` follows one long-running helper command and reports each matching output line.
 * `poll` re-runs a short helper command on an interval and reports each changed, matching output.
 * `source` observes an existing job or process it does not own.
 */
export type MonitorMode = "stream" | "poll" | "source";

export type MonitorStopReason = "manual" | "exit" | "replaced" | "limit" | "timeout" | "error" | "session";

export type WatchSourceRef = JobRef | ProcessRef;

/** Receives observations from an existing source; the watch applies matching and limits. */
export interface WatchSourceSink {
	/** One complete output line. */
	line(text: string): void;
	/** Source output that was not retained and can no longer be observed. */
	gap(text: string): void;
}

export interface WatchSourceEnd {
	reason: "exit" | "replaced";
	text: string;
	exitCode?: number;
}

/**
 * An independent subscription to a source owned elsewhere. `observe` resolves when the source
 * ends; aborting `signal` stops observation only and must leave the source untouched.
 */
export interface WatchSource {
	readonly ref: WatchSourceRef;
	readonly description: string;
	observe(sink: WatchSourceSink, signal: AbortSignal): Promise<WatchSourceEnd>;
}

export interface MonitorStartSpec {
	/** Helper command owned and reaped by the watch; exclusive with `source`. */
	command?: string;
	source?: WatchSource;

	label?: string;

	cwd?: string;

	/** JS `RegExp` source compiled with the `u` flag; only matching output is reported. */
	match?: string;

	/** Poll interval in milliseconds for a command probe. Omitted selects `stream` mode. */
	everyMs?: number;

	/** Matching output events before the watch stops itself; terminal status and gaps do not count. */
	maxEvents?: number;

	/** Wall-clock lifetime in milliseconds. */
	timeoutMs?: number;
}

/** Mutable watch metadata; job identity and lifecycle live in AsyncJob. */
export interface MonitorDetails {
	mode: MonitorMode;
	command?: string;
	cwd?: string;
	source?: WatchSourceRef;
	/** Human-readable source description for `source` watches. */
	sourceDescription?: string;
	match?: string;
	stoppedAt?: number;
	stopReason?: MonitorStopReason;
	exitCode?: number;
	eventCount: number;
	maxEvents: number;
	everyMs?: number;
	timeoutMs?: number;
	lastEventAt?: number;
}

export interface MonitorSnapshot extends MonitorDetails {
	id: string;
	label: string;
	status: AsyncJob["status"];
	startTime: number;
}
