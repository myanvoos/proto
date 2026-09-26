import { Process } from "@oh-my-pi/pi-natives";
import { logger, ptree, readBytesWithLimit, readLines, sanitizeText, withTimeout } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJob, type AsyncJobManager } from "../async/job-manager";
import type { Settings } from "../config/settings";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import type { MonitorDetails, MonitorSnapshot, MonitorStartSpec, MonitorStopReason } from "./types";

const MAX_EVENT_TEXT_CHARS = 1_200;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 2_000;
const TERMINATION_TIMEOUT_MS = STOP_GRACE_MS + 1_000;

type RunContext = Parameters<Parameters<AsyncJobManager["register"]>[2]>[0];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function snapshotMonitor(job: AsyncJob): MonitorSnapshot | undefined {
	if (job.type !== "monitor" || !job.monitor) return undefined;
	return { ...job.monitor, id: job.id, label: job.label, status: job.status, startTime: job.startTime };
}

export function startMonitor(
	manager: AsyncJobManager,
	spec: MonitorStartSpec,
	options: { ownerId: string; settings: Settings; cwd: string },
): MonitorSnapshot {
	if (!options.ownerId) throw new Error("An async job owner is required to start a monitor");
	const command = spec.command.trim();
	if (!command) throw new Error("command is required to start a monitor");
	const active = manager.getRunningJobs({ ownerId: options.ownerId }).filter(job => job.type === "monitor").length;
	const limit = Math.max(1, options.settings.get("monitor.maxConcurrent"));
	if (active >= limit) {
		throw new Error(`Too many monitors running (${active}/${limit}); cancel one with fleet before starting another`);
	}
	let matcher: RegExp | undefined;
	if (spec.match !== undefined) {
		try {
			matcher = new RegExp(spec.match, "u");
		} catch (error) {
			throw new Error(`match is not a valid regular expression: ${errorText(error)}`);
		}
	}
	for (const [name, value] of [
		["every", spec.everySeconds],
		["maxEvents", spec.maxEvents],
		["timeout", spec.timeoutSeconds],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
			throw new Error(`${name} must be a finite number of at least 1`);
		}
	}
	const details: MonitorDetails = {
		command,
		cwd: spec.cwd?.trim() || options.cwd,
		mode: spec.everySeconds === undefined ? "stream" : "poll",
		match: spec.match,
		eventCount: 0,
		maxEvents: spec.maxEvents ?? Math.max(1, options.settings.get("monitor.maxEvents")),
		everySeconds: spec.everySeconds,
		timeoutSeconds: spec.timeoutSeconds,
	};
	const id = manager.register(
		"monitor",
		spec.label?.trim() || "monitor",
		ctx => new MonitorRunner(ctx, details, matcher, options.settings).run(),
		{ ownerId: options.ownerId, monitor: details },
	);
	return snapshotMonitor(manager.getJob(id)!)!;
}

/** One execution only; identity, lifecycle, retention and delivery belong to AsyncJobManager. */
class MonitorRunner {
	readonly #abort = new AbortController();
	#process?: Bun.Subprocess;
	#processIdentity: Process | null = null;
	#openPipeReaders = 0;
	#cleanup: Promise<void> = Promise.resolve();
	#outputCount = 0;
	#error?: string;

	constructor(
		private readonly ctx: RunContext,
		private readonly details: MonitorDetails,
		private readonly matcher: RegExp | undefined,
		private readonly settings: Settings,
	) {}

	async run(): Promise<string> {
		const onAbort = () =>
			this.#finish(this.ctx.signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON ? "session" : "manual");
		this.ctx.signal.addEventListener("abort", onAbort, { once: true });
		const timeout =
			this.details.timeoutSeconds === undefined
				? undefined
				: setTimeout(() => this.#finish("timeout"), this.details.timeoutSeconds * 1_000);
		try {
			if (this.ctx.signal.aborted) onAbort();
			if (!this.#abort.signal.aborted) {
				if (this.details.mode === "stream") await this.#stream();
				else await this.#poll();
			}
		} catch (error) {
			if (!this.#abort.signal.aborted) this.#finish("error", undefined, errorText(error));
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			this.ctx.signal.removeEventListener("abort", onAbort);
			await this.#cleanup;
		}
		const reason = this.details.stopReason;
		const text =
			reason === "exit"
				? `Monitored process exited with code ${this.details.exitCode ?? "unknown"}; the monitor is no longer running.`
				: reason === "limit"
					? `Event limit reached (${this.details.maxEvents}); the monitor stopped itself.`
					: reason === "timeout"
						? `Monitor timed out after ${this.details.timeoutSeconds}s and stopped.`
						: reason === "error"
							? `Monitor failed: ${this.#error ?? "unknown error"}`
							: `Monitor stopped (${reason}).`;
		if (reason === "exit" || reason === "limit" || reason === "timeout" || reason === "error") {
			this.#emit(reason, text);
		}
		if (reason === "error") throw new Error(text);
		return text;
	}

	#spawn(): Bun.Subprocess {
		const { shell, args, env, prefix } = this.settings.getShellConfig();
		const command = prefix ? `${prefix} ${this.details.command}` : this.details.command;
		const child = Bun.spawn([shell, ...args, command], {
			cwd: this.details.cwd,
			env: { ...env, ...buildNonInteractiveEnv() },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		this.#process = child;
		this.#processIdentity = Process.fromPid(child.pid);
		this.#openPipeReaders = 2;
		return child;
	}

	async #waitForExit(child: Bun.Subprocess): Promise<number | undefined> {
		if (this.#abort.signal.aborted) {
			await this.#cleanup;
			return undefined;
		}
		const stopped = Promise.withResolvers<undefined>();
		const onAbort = () => stopped.resolve(undefined);
		this.#abort.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const exitCode = await Promise.race([child.exited, stopped.promise]);
			if (exitCode === undefined) await this.#cleanup;
			return exitCode;
		} finally {
			this.#abort.signal.removeEventListener("abort", onAbort);
		}
	}

	async #stream(): Promise<void> {
		const child = this.#spawn();
		const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			const decoder = new TextDecoder();
			try {
				for await (const bytes of readLines(stream, this.#abort.signal, MAX_CAPTURE_BYTES)) {
					this.#output(sanitizeText(decoder.decode(bytes)).trimEnd());
				}
			} catch (error) {
				if (!this.#abort.signal.aborted)
					this.#finish("error", undefined, `${errorText(error)}; filter the command output`);
			} finally {
				this.#openPipeReaders -= 1;
			}
		};
		await Promise.all([
			pump(child.stdout as ReadableStream<Uint8Array>),
			pump(child.stderr as ReadableStream<Uint8Array>),
		]);
		const exitCode = await this.#waitForExit(child);
		this.#finish("exit", exitCode);
	}

	async #readText(stream: ReadableStream<Uint8Array>): Promise<string> {
		const { bytes, truncated } = await readBytesWithLimit(stream, MAX_CAPTURE_BYTES, this.#abort.signal);
		if (truncated)
			throw new Error(`Monitor output exceeds the ${MAX_CAPTURE_BYTES}-byte limit; filter the command output`);
		return new TextDecoder().decode(bytes);
	}

	async #poll(): Promise<void> {
		let lastOutput: string | undefined;
		while (!this.#abort.signal.aborted) {
			const child = this.#spawn();
			// Settle both readers before completing the job, including on overflow/abort.
			const read = async (stream: ReadableStream<Uint8Array>) => {
				try {
					return await this.#readText(stream);
				} catch (error) {
					if (!this.#abort.signal.aborted) this.#finish("error", undefined, errorText(error));
					return "";
				} finally {
					this.#openPipeReaders -= 1;
				}
			};
			const [stdout, stderr] = await Promise.all([
				read(child.stdout as ReadableStream<Uint8Array>),
				read(child.stderr as ReadableStream<Uint8Array>),
			]);
			await this.#waitForExit(child);
			if (this.#abort.signal.aborted) return;
			this.#process = undefined;
			const output = sanitizeText(`${stdout}${stderr}`).trim();
			if (output !== lastOutput) this.#output(output);
			lastOutput = output;
			if (this.#abort.signal.aborted) return;
			await new Promise<void>(resolve => {
				const done = () => {
					clearTimeout(timer);
					this.#abort.signal.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, (this.details.everySeconds ?? 1) * 1_000);
				this.#abort.signal.addEventListener("abort", done, { once: true });
			});
		}
	}

	#output(text: string): void {
		if (this.#abort.signal.aborted || !text || (this.matcher && !this.matcher.test(text))) return;
		this.#outputCount += 1;
		this.#emit("output", text);
		if (this.#outputCount >= this.details.maxEvents) this.#finish("limit");
	}

	#emit(kind: Parameters<RunContext["emitEvent"]>[0], text: string): void {
		this.details.eventCount += 1;
		this.details.lastEventAt = Date.now();
		this.ctx.emitEvent(
			kind,
			text.length <= MAX_EVENT_TEXT_CHARS
				? text
				: `${text.slice(0, MAX_EVENT_TEXT_CHARS)}… (+${text.length - MAX_EVENT_TEXT_CHARS} chars)`,
		);
	}

	#finish(reason: MonitorStopReason, exitCode?: number, message?: string): void {
		if (this.details.stopReason !== undefined) return;
		this.details.stopReason = reason;
		this.details.stoppedAt = Date.now();
		if (exitCode !== undefined) this.details.exitCode = exitCode;
		this.#error = message;
		this.#abort.abort();
		this.#cleanup = this.#kill();
	}

	async #kill(): Promise<void> {
		const child = this.#process;
		this.#process = undefined;
		if (!child) return;
		try {
			await withTimeout(
				Promise.all([
					ptree.terminateProcess(child, this.#processIdentity, {
						detached: true,
						hasOpenPipes: this.#openPipeReaders > 0,
						gracefulMs: STOP_GRACE_MS,
						timeoutMs: TERMINATION_TIMEOUT_MS - STOP_GRACE_MS,
					}),
					child.exited,
				]),
				TERMINATION_TIMEOUT_MS,
				`Timed out terminating monitor process ${this.ctx.jobId}`,
			);
		} catch (error) {
			logger.debug("Monitor process termination failed", { jobId: this.ctx.jobId, error: errorText(error) });
		}
	}
}
