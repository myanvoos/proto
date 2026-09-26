import type { AsyncJob, AsyncJobManager } from "../../async";
import type { ProcessRef } from "../../jobs/contracts";
import type { DaemonBrokerClient } from "../../launch/client";
import { DaemonBrokerRejectedError, type DaemonRpcResult } from "../../launch/protocol";
import type { WatchSource, WatchSourceEnd, WatchSourceSink } from "../../monitor/types";

const READ_CHUNK_BYTES = 64 * 1024;
const READ_WAIT_MS = 30_000;
const IDLE_RETRY_MS = 50;
/** A line longer than this is reported in pieces rather than buffered without bound. */
const MAX_PARTIAL_LINE_CHARS = 16 * 1024;
/** Progress text is a bounded tail; aligning more lines than this is not worth the cost. */
const MAX_ALIGNED_LINES = 400;

/** Splits streamed text into complete lines, holding the unterminated tail for the next chunk. */
class LineSplitter {
	#carry = "";

	push(text: string, sink: WatchSourceSink): void {
		const parts = (this.#carry + text).split("\n");
		this.#carry = parts.pop() ?? "";
		for (const line of parts) sink.line(line);
		while (this.#carry.length > MAX_PARTIAL_LINE_CHARS) {
			sink.line(this.#carry.slice(0, MAX_PARTIAL_LINE_CHARS));
			this.#carry = this.#carry.slice(MAX_PARTIAL_LINE_CHARS);
		}
	}

	flush(sink: WatchSourceSink): void {
		if (this.#carry) sink.line(this.#carry);
		this.#carry = "";
	}
}

/**
 * Observe one process incarnation through the broker's cursor-addressed output API. No helper
 * process is spawned; stopping the watch only stops reading. An explicit restart makes every read
 * pinned to this incarnation fail as stale, which ends the watch with a `replaced` event.
 */
export function processWatchSource(client: DaemonBrokerClient, ref: ProcessRef, startCursor: number): WatchSource {
	const description = `process ${ref.name} (${ref.id})`;
	return {
		ref,
		description,
		async observe(sink, signal): Promise<WatchSourceEnd> {
			const lines = new LineSplitter();
			let cursor = startCursor;
			for (;;) {
				let result: DaemonRpcResult;
				try {
					result = await client.request(
						{
							op: "read",
							name: ref.name,
							expectedId: ref.id,
							cursor,
							maxBytes: READ_CHUNK_BYTES,
							timeoutMs: READ_WAIT_MS,
						},
						signal,
					);
				} catch (error) {
					if (error instanceof DaemonBrokerRejectedError && error.code === "stale-reference") {
						lines.flush(sink);
						return {
							reason: "replaced",
							text: `Process ${ref.name} incarnation ${ref.id} was replaced by a restart; watch the reference restart returned to keep observing.`,
						};
					}
					throw error;
				}
				if (result.op !== "read") throw new Error(`Unexpected broker result ${result.op}`);
				if (result.reset) {
					sink.gap(
						`Process ${ref.name} output restarted in a new cursor space (relaunch or broker recovery); unread output before it is unavailable.`,
					);
				} else if (result.omittedBytes > 0) {
					sink.gap(
						`${result.omittedBytes} bytes of process ${ref.name} output were no longer retained when this watch read them.`,
					);
				}
				if (result.text) lines.push(result.text, sink);
				const advanced = result.nextCursor !== cursor || result.reset;
				cursor = result.nextCursor;
				const { state } = result.daemon;
				if ((state === "exited" || state === "failed") && !result.text) {
					lines.flush(sink);
					const exit = result.daemon.exitCode === undefined ? "" : ` with code ${result.daemon.exitCode}`;
					const reason = result.daemon.exitReason ? ` (${result.daemon.exitReason})` : "";
					return {
						reason: "exit",
						exitCode: result.daemon.exitCode,
						text: `Process ${ref.name} ${result.daemon.state}${exit}${reason}.`,
					};
				}
				if (!advanced && !result.timedOut) await Bun.sleep(IDLE_RETRY_MS);
			}
		},
	};
}

/** Lines newly visible in a bounded tail snapshot, aligning on the previous snapshot's lines. */
function appendedLines(previous: string[], next: string[]): string[] {
	const prior = previous.slice(-MAX_ALIGNED_LINES);
	for (let overlap = Math.min(prior.length, next.length); overlap > 0; overlap--) {
		let matches = true;
		for (let i = 0; i < overlap; i++) {
			if (prior[prior.length - overlap + i] !== next[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return next.slice(overlap);
	}
	return next;
}

/**
 * Observe a finite job's progress and settlement through an independent manager subscription.
 * The watch never consumes or acknowledges the job's own completion delivery.
 */
export function jobWatchSource(manager: AsyncJobManager, job: AsyncJob): WatchSource {
	const ref = { kind: "job" as const, id: job.id };
	return {
		ref,
		description: `job ${job.id}`,
		async observe(sink, signal): Promise<WatchSourceEnd> {
			const done = Promise.withResolvers<WatchSourceEnd>();
			let seen: string[] = [];
			let pending = "";
			const settledText = (): WatchSourceEnd => ({
				reason: "exit",
				text: `Job ${job.id} ${job.status}${job.errorText ? `: ${job.errorText.split("\n")[0]}` : ""}.`,
			});
			const unsubscribe = manager.subscribe(job.id, observation => {
				if (observation.kind === "progress") {
					// The last segment is either empty (text ends with a newline) or a line still being written.
					const parts = observation.text.split(/\r?\n/);
					pending = parts.pop() ?? "";
					const complete = parts;
					for (const line of appendedLines(seen, complete)) sink.line(line);
					seen = complete.slice(-MAX_ALIGNED_LINES);
				} else if (observation.kind === "settled") {
					if (pending) sink.line(pending);
					pending = "";
					done.resolve(settledText());
				}
			});
			const stop = () => done.resolve(settledText());
			signal.addEventListener("abort", stop, { once: true });
			try {
				if (manager.isSettled(job.id)) return settledText();
				return await done.promise;
			} finally {
				signal.removeEventListener("abort", stop);
				unsubscribe();
			}
		},
	};
}
