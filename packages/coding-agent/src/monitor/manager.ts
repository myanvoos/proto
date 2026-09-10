import { Process } from "@oh-my-pi/pi-natives";
import { logger, readBytesWithLimit, readLines, sanitizeText, withTimeout } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import type { MonitorEvent, MonitorEventKind, MonitorSnapshot, MonitorStartSpec, MonitorStopReason } from "./types";

const MAX_EVENT_TEXT_CHARS = 1_200;
const STOP_GRACE_MS = 2_000;
const TERMINATION_TIMEOUT_MS = STOP_GRACE_MS + 1_000;
const TASK_SETTLE_TIMEOUT_MS = TERMINATION_TIMEOUT_MS + 500;
const MIN_POLL_SECONDS = 1;
const DEFAULT_LABEL = "monitor";
const EXIT_WAIT_ABORTED = Symbol("monitor exit wait aborted");

export interface MonitorManagerOptions {
	/** Pushes one event into the session so the agent wakes on it. */
	deliver(event: MonitorEvent): void;
	settings: Settings;
	cwd(): string;
	now?(): number;
}

interface MonitorRecord {
	snapshot: MonitorSnapshot;
	matcher: RegExp | undefined;
	abort: AbortController;
	process: Bun.Subprocess | undefined;
	pollTimer: Timer | undefined;
	timeoutTimer: Timer | undefined;
	lastPollOutput: string | undefined;

	/** Only `output` events count against `maxEvents`; terminal events always get through. */
	outputCount: number;
}

function truncateEventText(text: string): string {
	if (text.length <= MAX_EVENT_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_EVENT_TEXT_CHARS)}… (+${text.length - MAX_EVENT_TEXT_CHARS} chars)`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class MonitorManager {
	readonly #options: MonitorManagerOptions;
	readonly #records = new Map<string, MonitorRecord>();
	readonly #tasks = new Set<Promise<unknown>>();
	#counter = 0;
	#disposed = false;
	#disposeCall?: Promise<void>;

	constructor(options: MonitorManagerOptions) {
		this.#options = options;
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	#maxMonitors(): number {
		return Math.max(1, this.#options.settings.get("monitor.maxConcurrent"));
	}

	#defaultMaxEvents(): number {
		return Math.max(1, this.#options.settings.get("monitor.maxEvents"));
	}

	activeCount(): number {
		let count = 0;
		for (const record of this.#records.values()) {
			if (record.snapshot.status === "running") count++;
		}
		return count;
	}

	hasActive(): boolean {
		for (const record of this.#records.values()) {
			if (record.snapshot.status === "running") return true;
		}
		return false;
	}

	list(): MonitorSnapshot[] {
		return [...this.#records.values()].map(record => ({ ...record.snapshot }));
	}

	get(id: string): MonitorSnapshot | undefined {
		const record = this.#records.get(id);
		return record ? { ...record.snapshot } : undefined;
	}

	start(spec: MonitorStartSpec): MonitorSnapshot {
		if (this.#disposed) throw new Error("Monitors are unavailable because the session is shutting down");
		const command = spec.command.trim();
		if (!command) throw new Error("command is required to start a monitor");

		const active = this.activeCount();
		const limit = this.#maxMonitors();
		if (active >= limit) {
			throw new Error(`Too many monitors running (${active}/${limit}); stop one before starting another`);
		}

		let matcher: RegExp | undefined;
		if (spec.match !== undefined) {
			try {
				matcher = new RegExp(spec.match, "u");
			} catch (error) {
				throw new Error(`match is not a valid regular expression: ${errorText(error)}`);
			}
		}

		if (spec.everySeconds !== undefined && spec.everySeconds < MIN_POLL_SECONDS) {
			throw new Error(`every must be at least ${MIN_POLL_SECONDS} second`);
		}
		if (spec.maxEvents !== undefined && spec.maxEvents < 1) {
			throw new Error("maxEvents must be at least 1");
		}
		if (spec.timeoutSeconds !== undefined && spec.timeoutSeconds < 1) {
			throw new Error("timeout must be at least 1 second");
		}

		this.#counter += 1;
		const id = `mon${this.#counter}`;
		const snapshot: MonitorSnapshot = {
			id,
			label: spec.label?.trim() || DEFAULT_LABEL,
			command,
			cwd: spec.cwd?.trim() || this.#options.cwd(),
			mode: spec.everySeconds === undefined ? "stream" : "poll",
			...(spec.match !== undefined ? { match: spec.match } : {}),
			status: "running",
			startedAt: this.#now(),
			eventCount: 0,
			maxEvents: spec.maxEvents ?? this.#defaultMaxEvents(),
			...(spec.everySeconds !== undefined ? { everySeconds: spec.everySeconds } : {}),
			...(spec.timeoutSeconds !== undefined ? { timeoutSeconds: spec.timeoutSeconds } : {}),
		};
		const record: MonitorRecord = {
			snapshot,
			matcher,
			abort: new AbortController(),
			process: undefined,
			pollTimer: undefined,
			timeoutTimer: undefined,
			lastPollOutput: undefined,
			outputCount: 0,
		};
		this.#records.set(id, record);

		if (spec.timeoutSeconds !== undefined) {
			record.timeoutTimer = setTimeout(() => this.#finish(record, "timeout"), spec.timeoutSeconds * 1_000);
		}

		if (record.snapshot.mode === "stream") this.#startStream(record);
		else this.#trackTask(record, this.#runPoll(record));

		return { ...record.snapshot };
	}

	stop(ids?: readonly string[]): MonitorSnapshot[] {
		const targets =
			ids === undefined
				? [...this.#records.values()].filter(record => record.snapshot.status === "running")
				: ids.map(id => this.#records.get(id)).filter((record): record is MonitorRecord => record !== undefined);
		const stopped: MonitorSnapshot[] = [];
		for (const record of targets) {
			if (record.snapshot.status === "running") this.#finish(record, "manual");
			stopped.push({ ...record.snapshot });
		}
		return stopped;
	}

	dispose(): Promise<void> {
		if (this.#disposeCall) return this.#disposeCall;
		if (this.#records.size === 0 && this.#tasks.size === 0) {
			this.#disposed = true;
			this.#disposeCall = Promise.resolve();
			return this.#disposeCall;
		}
		this.#disposed = true;
		for (const record of this.#records.values()) {
			if (record.snapshot.status === "running") this.#finish(record, "session");
		}
		this.#records.clear();
		const tasks = [...this.#tasks];
		this.#disposeCall = withTimeout(
			Promise.allSettled(tasks).then(() => undefined),
			TASK_SETTLE_TIMEOUT_MS,
			"Timed out waiting for monitor tasks during dispose",
		)
			.catch(error => {
				logger.warn("Monitor tasks did not settle during dispose", { error: errorText(error) });
			})
			.finally(() => this.#tasks.clear());
		return this.#disposeCall;
	}

	#spawn(record: MonitorRecord): Bun.Subprocess {
		const { shell, args, env, prefix } = this.#options.settings.getShellConfig();
		const command = prefix ? `${prefix} ${record.snapshot.command}` : record.snapshot.command;
		return Bun.spawn([shell, ...args, command], {
			cwd: record.snapshot.cwd,
			env: { ...env, ...buildNonInteractiveEnv() },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	}

	#trackTask(record: MonitorRecord, task: Promise<unknown>): void {
		this.#tasks.add(task);
		void task.then(
			() => {
				this.#tasks.delete(task);
			},
			error => {
				this.#tasks.delete(task);
				logger.debug("Monitor task ended with an error", {
					monitorId: record.snapshot.id,
					error: errorText(error),
				});
			},
		);
	}

	async #readStreamText(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
		const { bytes } = await readBytesWithLimit(stream, Number.MAX_SAFE_INTEGER, signal);
		return new TextDecoder().decode(bytes);
	}

	async #waitForExitBounded(child: Bun.Subprocess, monitorId: string): Promise<number | undefined> {
		try {
			return await withTimeout(
				child.exited,
				TERMINATION_TIMEOUT_MS,
				`Timed out waiting for monitor process ${monitorId} to exit`,
			);
		} catch (error) {
			logger.debug("Monitor process did not exit before the task deadline", {
				monitorId,
				error: errorText(error),
			});
			return undefined;
		}
	}

	async #waitForExit(child: Bun.Subprocess, record: MonitorRecord): Promise<number | undefined> {
		if (record.snapshot.status !== "running" || record.abort.signal.aborted) {
			return this.#waitForExitBounded(child, record.snapshot.id);
		}

		const { promise: aborted, resolve } = Promise.withResolvers<typeof EXIT_WAIT_ABORTED>();
		const onAbort = () => resolve(EXIT_WAIT_ABORTED);
		record.abort.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await Promise.race([child.exited, aborted]);
			if (result === EXIT_WAIT_ABORTED) return this.#waitForExitBounded(child, record.snapshot.id);
			return result;
		} catch (error) {
			logger.debug("Monitor process exit wait failed", {
				monitorId: record.snapshot.id,
				error: errorText(error),
			});
			return undefined;
		} finally {
			record.abort.signal.removeEventListener("abort", onAbort);
		}
	}

	#startStream(record: MonitorRecord): void {
		let child: Bun.Subprocess;
		try {
			child = this.#spawn(record);
		} catch (error) {
			this.#fail(record, errorText(error));
			return;
		}
		record.process = child;

		const decoder = new TextDecoder();
		const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			for await (const bytes of readLines(stream, record.abort.signal)) {
				this.#onLine(record, decoder.decode(bytes));
			}
		};

		const task = (async () => {
			const pumps = await Promise.allSettled([
				pump(child.stdout as ReadableStream<Uint8Array>),
				pump(child.stderr as ReadableStream<Uint8Array>),
			]);
			for (const settled of pumps) {
				if (settled.status === "rejected") {
					logger.debug("Monitor output stream ended with an error", {
						monitorId: record.snapshot.id,
						error: errorText(settled.reason),
					});
				}
			}
			const exitCode = await this.#waitForExit(child, record);
			if (record.snapshot.status !== "running") return;
			if (exitCode === undefined) {
				this.#finish(record, "error", undefined, "monitored process did not exit before the deadline");
				return;
			}
			record.process = undefined;
			this.#finish(record, "exit", exitCode);
		})();
		this.#trackTask(record, task);
	}

	async #runPoll(record: MonitorRecord): Promise<void> {
		if (record.snapshot.status !== "running") return;
		let child: Bun.Subprocess;
		try {
			child = this.#spawn(record);
		} catch (error) {
			this.#fail(record, errorText(error));
			return;
		}
		record.process = child;
		try {
			const [stdout, stderr] = await Promise.all([
				this.#readStreamText(child.stdout as ReadableStream<Uint8Array>, record.abort.signal),
				this.#readStreamText(child.stderr as ReadableStream<Uint8Array>, record.abort.signal),
			]);
			const exitCode = await this.#waitForExit(child, record);
			if (record.snapshot.status !== "running") return;
			if (exitCode === undefined) {
				this.#finish(record, "error", undefined, "monitored process did not exit before the deadline");
				return;
			}
			record.process = undefined;
			const output = sanitizeText(`${stdout}${stderr}`).trim();
			const changed = output !== record.lastPollOutput;
			record.lastPollOutput = output;
			if (changed && output && this.#matches(record, output)) {
				this.#emit(record, "output", output);
			}
		} catch (error) {
			if (record.abort.signal.aborted || record.snapshot.status !== "running") return;
			this.#fail(record, errorText(error));
			return;
		}
		if (record.snapshot.status !== "running") return;
		const everySeconds = record.snapshot.everySeconds ?? MIN_POLL_SECONDS;
		record.pollTimer = setTimeout(() => {
			record.pollTimer = undefined;
			if (record.snapshot.status === "running" && !this.#disposed) {
				this.#trackTask(record, this.#runPoll(record));
			}
		}, everySeconds * 1_000);
	}

	#matches(record: MonitorRecord, text: string): boolean {
		return record.matcher === undefined || record.matcher.test(text);
	}

	#onLine(record: MonitorRecord, raw: string): void {
		if (record.snapshot.status !== "running") return;
		const text = sanitizeText(raw).trimEnd();
		if (!text) return;
		if (!this.#matches(record, text)) return;
		this.#emit(record, "output", text);
	}

	#emit(record: MonitorRecord, kind: MonitorEventKind, text: string): void {
		if (kind === "output") record.outputCount += 1;
		record.snapshot.eventCount += 1;
		record.snapshot.lastEventAt = this.#now();
		const event: MonitorEvent = {
			monitorId: record.snapshot.id,
			label: record.snapshot.label,
			kind,
			text: truncateEventText(text),
			sequence: record.snapshot.eventCount,
			timestamp: record.snapshot.lastEventAt,
		};
		try {
			this.#options.deliver(event);
		} catch (error) {
			logger.warn("Monitor event delivery failed", {
				monitorId: record.snapshot.id,
				error: errorText(error),
			});
		}
		if (kind === "output" && record.outputCount >= record.snapshot.maxEvents) {
			this.#finish(record, "limit");
		}
	}

	#fail(record: MonitorRecord, message: string): void {
		if (record.snapshot.status !== "running") return;
		this.#finish(record, "error", undefined, message);
	}

	#finish(record: MonitorRecord, reason: MonitorStopReason, exitCode?: number, errorMessage?: string): void {
		if (record.snapshot.status !== "running") return;
		record.snapshot.status = "stopped";
		record.snapshot.stoppedAt = this.#now();
		record.snapshot.stopReason = reason;
		if (exitCode !== undefined) record.snapshot.exitCode = exitCode;

		if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
		record.timeoutTimer = undefined;
		if (record.pollTimer) clearTimeout(record.pollTimer);
		record.pollTimer = undefined;
		record.abort.abort();
		this.#trackTask(record, this.#kill(record));

		if (reason === "manual" || reason === "session") return;
		const text =
			reason === "exit"
				? `Monitored process exited with code ${exitCode ?? "unknown"}; the monitor is no longer running.`
				: reason === "limit"
					? `Event limit reached (${record.snapshot.maxEvents}); the monitor stopped itself.`
					: reason === "timeout"
						? `Monitor timed out after ${record.snapshot.timeoutSeconds}s and stopped.`
						: `Monitor failed: ${errorMessage ?? "unknown error"}`;
		const kind: MonitorEventKind =
			reason === "exit" ? "exit" : reason === "limit" ? "limit" : reason === "timeout" ? "timeout" : "error";
		this.#emit(record, kind, text);
	}

	async #kill(record: MonitorRecord): Promise<void> {
		const child = record.process;
		record.process = undefined;
		if (!child) return;
		const ref = child.pid === undefined ? null : Process.fromPid(child.pid);
		if (ref) {
			let terminated = false;
			try {
				terminated = await withTimeout(
					ref.terminate({ group: true, gracefulMs: STOP_GRACE_MS, timeoutMs: TERMINATION_TIMEOUT_MS }),
					TERMINATION_TIMEOUT_MS,
					`Timed out terminating monitor process ${record.snapshot.id}`,
				);
			} catch (error) {
				logger.debug("Monitor process termination failed", {
					monitorId: record.snapshot.id,
					error: errorText(error),
				});
			}
			if (!terminated) {
				try {
					ref.killTree(9);
				} catch (error) {
					logger.debug("Monitor process force kill failed", {
						monitorId: record.snapshot.id,
						error: errorText(error),
					});
				}
			}
			return;
		}
		try {
			child.kill();
		} catch (error) {
			logger.debug("Monitor process kill failed", { error: errorText(error) });
		}
	}
}
