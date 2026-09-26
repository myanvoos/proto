import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobObservation } from "../async/job-manager";
import type { ToolSession } from "../tools";
import { callSessionTool } from "./js/tool-bridge";
import type { EvalStatusEvent } from "./types";

export type ExecutionEventStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type ExecutionEventKind = "start" | "update" | "job" | "result" | "error" | "complete";

export interface ExecutionEventOmission {
	reason: "payload_too_large" | "not_json_serializable";
	bytes?: number;
}

export interface ExecutionEvent {
	executionId: string;
	sequence: number;
	kind: ExecutionEventKind;
	data: unknown;
	/** Only complete is terminal. A progress update cannot establish success. */
	terminal: boolean;
	omitted?: ExecutionEventOmission;
}

export interface ExecutionEventHandle {
	id: string;
	cursor: number;
}

export interface ExecutionEventPage extends ExecutionEventHandle {
	events: ExecutionEvent[];
	gap?: { from: number; to: number; count: number };
	/** True only once the terminal event has been returned, including under pagination. */
	done: boolean;
	status: ExecutionEventStatus;
}

export interface ExecutionEventCancellation {
	id: string;
	status: ExecutionEventStatus;
	/** True only after the tool and every observed job have actually settled. */
	done: boolean;
}

export type ExecutionEventsResult =
	| ExecutionEventHandle
	| ExecutionEventPage
	| ExecutionEventCancellation
	| { disposed: true };

export type ExecutionEventsRequest =
	| { op: "events_start"; tool: string; args?: Record<string, unknown> }
	| { op: "events_read"; id: string; cursor?: number; limit?: number; waitMs?: number }
	| { op: "events_cancel"; id: string; waitMs?: number }
	| { op: "events_dispose"; id?: string };

export interface ExecutionEventsOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: EvalStatusEvent) => void;
}

const MAX_HANDLES = 64;
const MAX_ACTIVE = 16;
const MAX_JOBS = 64;
const MAX_EVENTS = 128;
const MAX_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_WAITERS = 64;
const MAX_WAIT_MS = 30_000;

interface Payload {
	json: string;
	omitted?: ExecutionEventOmission;
}

interface StoredEvent {
	sequence: number;
	json: string;
	bytes: number;
}

interface TrackedJob {
	job?: AsyncJob;
	settled: Promise<void>;
	resolveSettled(): void;
	outcome?: Payload;
}

interface Execution {
	id: string;
	controller: AbortController;
	status: ExecutionEventStatus;
	sequence: number;
	events: StoredEvent[];
	bytes: number;
	terminal: boolean;
	disposing: boolean;
	waiters: Set<() => void>;
	jobs: Map<string, TrackedJob>;
	jobBytes: number;
	jobFailure?: string;
	jobCancelled: boolean;
	completion: Promise<void>;
	removeParentSignal(): void;
}

function payload(value: unknown): Payload {
	try {
		const json = JSON.stringify(value);
		if (json === undefined) return { json: "null", omitted: { reason: "not_json_serializable" } };
		const bytes = Math.max(json.length * 2, Buffer.byteLength(json));
		if (bytes > MAX_PAYLOAD_BYTES) return { json: "null", omitted: { reason: "payload_too_large", bytes } };
		return { json };
	} catch {
		return { json: "null", omitted: { reason: "not_json_serializable" } };
	}
}

function failedResult(result: AgentToolResult | undefined): boolean {
	return result?.isError === true || (isRecord(result?.details) && result.details.isError === true);
}

function resultError(result: AgentToolResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A bounded, session-owned view over existing tools/jobs, not a process executor. */
class ExecutionEventStore {
	readonly #executions = new Map<string, Execution>();
	#closed = false;

	constructor(private readonly session: ToolSession) {}

	start(tool: string, args: Record<string, unknown>, options: ExecutionEventsOptions): ExecutionEventHandle {
		if (this.#closed || this.session.isDisposed?.()) throw new Error("Execution event session is disposed");
		options.signal?.throwIfAborted();
		if (tool.startsWith("__")) throw new Error("events_start requires a session tool, not an internal bridge");
		const known = this.session.getToolForEvalBridge
			? this.session.getToolForEvalBridge(tool)
			: this.session.getToolByName?.(tool);
		if (!known) throw new Error(`Unknown execution tool: ${tool}`);
		const serializedArgs = JSON.stringify(args);
		if (Buffer.byteLength(serializedArgs) > MAX_ARGUMENT_BYTES)
			throw new Error("Execution arguments exceed byte limit");
		if (this.#executions.size >= MAX_HANDLES)
			throw new Error("Execution handle limit reached; dispose retained handles");
		if ([...this.#executions.values()].filter(entry => !entry.terminal).length >= MAX_ACTIVE) {
			throw new Error("Active execution limit reached; cancel or await existing work");
		}
		const id = `execution-${crypto.randomUUID()}`;
		const entry: Execution = {
			id,
			controller: new AbortController(),
			status: "running",
			sequence: 0,
			events: [],
			bytes: 0,
			terminal: false,
			disposing: false,
			waiters: new Set(),
			jobs: new Map(),
			jobBytes: 0,
			jobCancelled: false,
			completion: Promise.resolve(),
			removeParentSignal: () => {},
		};
		this.#executions.set(id, entry);
		const onAbort = () => this.#cancel(entry, options.signal?.reason);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		entry.removeParentSignal = () => options.signal?.removeEventListener("abort", onAbort);
		this.#emit(entry, "start", { tool });
		// Defer invocation so the handle exists before even a synchronous tool can emit or settle.
		entry.completion = Promise.resolve().then(() => this.#run(entry, tool, JSON.parse(serializedArgs), options));
		return { id, cursor: 0 };
	}

	#get(id: string): Execution {
		const entry = this.#executions.get(id);
		if (!entry || entry.disposing) throw new Error("Unknown or disposed execution handle for this session");
		return entry;
	}

	#notify(entry: Execution): void {
		for (const notify of [...entry.waiters]) notify();
	}

	#emit(entry: Execution, kind: ExecutionEventKind, data: unknown): void {
		if (entry.terminal || entry.disposing) return;
		const captured = payload(data);
		const event: ExecutionEvent = {
			executionId: entry.id,
			sequence: ++entry.sequence,
			kind,
			data: JSON.parse(captured.json),
			terminal: kind === "complete",
			...(captured.omitted ? { omitted: captured.omitted } : {}),
		};
		const json = JSON.stringify(event);
		const bytes = Math.max(json.length * 2, Buffer.byteLength(json));
		entry.events.push({ sequence: event.sequence, json, bytes });
		entry.bytes += bytes;
		while (entry.events.length > MAX_EVENTS || entry.bytes > MAX_BYTES) entry.bytes -= entry.events.shift()!.bytes;
		if (event.terminal) entry.terminal = true;
		this.#notify(entry);
	}

	#observeJob(entry: Execution, observation: AsyncJobObservation): void {
		const { job } = observation;
		if (observation.kind === "registered") {
			if (entry.jobs.size >= MAX_JOBS) this.#cancel(entry, "Execution child job limit exceeded");
			// Track even the registration that exceeds the bound: cancellation must await its cleanup.
			// The aborted observer scope rejects every later registration before admission.
			const settled = Promise.withResolvers<void>();
			entry.jobs.set(job.id, { job, settled: settled.promise, resolveSettled: settled.resolve });
			this.#emit(entry, "job", { jobId: job.id, type: job.type, status: job.status });
			if (entry.controller.signal.aborted) this.session.asyncJobManager?.cancel(job.id);
			return;
		}
		const tracked = entry.jobs.get(job.id);
		if (!tracked) return;
		if (observation.kind === "progress") {
			this.#emit(entry, "update", {
				source: "job",
				jobId: job.id,
				text: observation.text,
				details: observation.details,
			});
		} else if (observation.kind === "event") {
			this.#emit(entry, "update", { source: "job", jobId: job.id, event: observation.event });
		} else {
			const result = payload({
				id: job.id,
				type: job.type,
				status: job.status,
				result: job.result,
				text: job.resultText,
				error: job.errorText,
			});
			if (entry.jobBytes + result.json.length * 2 > MAX_PAYLOAD_BYTES) {
				result.omitted = { reason: "payload_too_large", bytes: result.json.length * 2 };
				result.json = "null";
			}
			entry.jobBytes += result.json.length * 2;
			tracked.outcome = result;
			tracked.job = undefined;
			if (job.status === "failed") entry.jobFailure ??= job.errorText ?? "Managed job failed";
			if (job.status === "cancelled") entry.jobCancelled = true;
			tracked.resolveSettled();
		}
	}

	async #run(
		entry: Execution,
		tool: string,
		args: Record<string, unknown>,
		options: ExecutionEventsOptions,
	): Promise<void> {
		let result: AgentToolResult | undefined;
		let failure: string | undefined;
		try {
			const invoke = () =>
				callSessionTool(tool, args, {
					session: this.session,
					signal: entry.controller.signal,
					toolCallId: entry.id,
					emitStatus: options.emitStatus,
					onUpdate: update => this.#emit(entry, "update", { source: "tool", result: update }),
					onResult: value => {
						result = value;
					},
				});
			const manager = this.session.asyncJobManager;
			await (manager
				? manager.withJobObserver(
						observation => this.#observeJob(entry, observation),
						invoke,
						entry.controller.signal,
					)
				: invoke());
			if (failedResult(result)) failure = resultError(result!) || "Tool returned an error";
		} catch (error) {
			failure = errorMessage(error);
		}
		if (failure) this.#cancelJobs(entry);
		// Registration observers include asynchronous descendants. Recheck after every settlement wave.
		while ([...entry.jobs.values()].some(job => job.job !== undefined)) {
			await Promise.all([...entry.jobs.values()].map(job => job.settled));
		}
		entry.removeParentSignal();
		failure ??= entry.jobFailure;
		const cancelled = entry.controller.signal.aborted || (entry.jobCancelled && !failure);
		entry.status = cancelled ? "cancelled" : failure ? "failed" : "completed";
		if (!cancelled && result) {
			const jobs = [...entry.jobs].map(([id, job]) => ({
				id,
				value: JSON.parse(job.outcome?.json ?? "null") as unknown,
				...(job.outcome?.omitted ? { omitted: job.outcome.omitted } : {}),
			}));
			this.#emit(entry, "result", { result, ...(jobs.length ? { jobs } : {}) });
		}
		if (cancelled || failure) {
			this.#emit(entry, "error", {
				message: cancelled ? errorMessage(entry.controller.signal.reason ?? "Execution cancelled") : failure,
				cancelled,
			});
		}
		entry.jobs.clear();
		entry.jobBytes = 0;
		if (entry.disposing) {
			entry.terminal = true;
			this.#notify(entry);
		} else {
			this.#emit(entry, "complete", { status: entry.status });
		}
		// Detached continuations cannot open new managed work after their owning execution settles.
		entry.controller.abort("Execution scope completed");
	}

	#cancelJobs(entry: Execution): void {
		for (const [id, tracked] of entry.jobs) {
			if (tracked.job) this.session.asyncJobManager?.cancel(id);
		}
	}

	#cancel(entry: Execution, reason?: unknown): void {
		if (entry.terminal) return;
		entry.status = "cancelling";
		entry.controller.abort(reason);
		this.#cancelJobs(entry);
		this.#notify(entry);
	}

	async #wait(entry: Execution, waitMs: number, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (waitMs === 0) return;
		if (entry.waiters.size >= MAX_WAITERS) throw new Error("Execution event waiter limit reached");
		const changed = Promise.withResolvers<void>();
		const onAbort = () => changed.reject(signal?.reason ?? new Error("Execution event wait aborted"));
		const timer = setTimeout(changed.resolve, waitMs);
		entry.waiters.add(changed.resolve);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await changed.promise;
		} finally {
			clearTimeout(timer);
			entry.waiters.delete(changed.resolve);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async read(
		id: string,
		cursor: number,
		limit: number,
		waitMs: number,
		signal?: AbortSignal,
	): Promise<ExecutionEventPage> {
		const entry = this.#get(id);
		signal?.throwIfAborted();
		if (cursor > entry.sequence) throw new Error("Execution cursor is ahead of this handle");
		if (cursor === entry.sequence && !entry.terminal) await this.#wait(entry, waitMs, signal);
		this.#get(id);
		const first = entry.events[0]?.sequence ?? entry.sequence + 1;
		const gap = cursor < first - 1 ? { from: cursor + 1, to: first - 1, count: first - cursor - 1 } : undefined;
		const events = entry.events
			.filter(event => event.sequence > cursor)
			.slice(0, limit)
			.map(event => JSON.parse(event.json) as ExecutionEvent);
		const nextCursor = events.at(-1)?.sequence ?? gap?.to ?? cursor;
		return {
			id,
			events,
			cursor: nextCursor,
			...(gap ? { gap } : {}),
			done: entry.terminal && nextCursor === entry.sequence,
			status: entry.status,
		};
	}

	async cancel(id: string, waitMs: number, signal?: AbortSignal): Promise<ExecutionEventCancellation> {
		const entry = this.#get(id);
		this.#cancel(entry);
		const deadline = Date.now() + waitMs;
		while (!entry.terminal && Date.now() < deadline) await this.#wait(entry, deadline - Date.now(), signal);
		return { id, status: entry.status, done: entry.terminal };
	}

	async dispose(id?: string, close = false): Promise<void> {
		if (close) this.#closed = true;
		const entries = id === undefined ? [...this.#executions.values()] : [this.#get(id)];
		for (const entry of entries) {
			entry.disposing = true;
			this.#cancel(entry, "Execution handle disposed");
			this.#notify(entry);
		}
		await Promise.all(entries.map(entry => entry.completion));
		for (const entry of entries) {
			entry.events.length = 0;
			entry.bytes = 0;
			this.#executions.delete(entry.id);
		}
	}
}

const stores = new WeakMap<ToolSession, ExecutionEventStore>();

function storeFor(session: ToolSession): ExecutionEventStore {
	let store = stores.get(session);
	if (store) return store;
	store = new ExecutionEventStore(session);
	stores.set(session, store);
	const owned = store;
	const close = () => {
		void owned
			.dispose(undefined, true)
			.catch(error => logger.warn("Execution event disposal failed", { error: errorMessage(error) }));
	};
	const unregisterDispose = session.registerDisposeCallback?.(close);
	const unregisterChange = session.registerSessionChangeCallback?.(() => {
		close();
		unregisterDispose?.();
		unregisterChange?.();
		if (stores.get(session) === owned) stores.delete(session);
	});
	return store;
}

function integer(value: unknown, name: string, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
		throw new Error(`${name} must be an integer between 0 and ${max}`);
	}
	return value;
}

function onlyKeys(args: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of Object.keys(args))
		if (!keys.includes(key)) throw new Error(`Unknown execution events parameter: ${key}`);
}

export async function runExecutionEvents(
	args: unknown,
	options: ExecutionEventsOptions,
): Promise<ExecutionEventsResult> {
	if (!isRecord(args)) throw new Error("Execution events arguments must be an object");
	const { op } = args;
	const store = storeFor(options.session);
	if (op === "events_start") {
		onlyKeys(args, ["op", "tool", "args"]);
		if (typeof args.tool !== "string" || !args.tool) throw new Error("events_start requires a tool name");
		if (args.args !== undefined && !isRecord(args.args)) throw new Error("Tool arguments must be an object");
		return store.start(args.tool, args.args ?? {}, options);
	}
	if (op === "events_dispose") {
		onlyKeys(args, ["op", "id"]);
		if (args.id !== undefined && (typeof args.id !== "string" || !args.id))
			throw new Error("Execution id must be a nonempty string");
		await store.dispose(args.id);
		return { disposed: true };
	}
	if (op !== "events_read" && op !== "events_cancel")
		throw new Error(`Unknown execution events operation: ${String(op)}`);
	if (typeof args.id !== "string" || !args.id) throw new Error("Execution id must be a nonempty string");
	const waitMs = integer(args.waitMs, "waitMs", 0, MAX_WAIT_MS);
	if (op === "events_cancel") {
		onlyKeys(args, ["op", "id", "waitMs"]);
		return store.cancel(args.id, waitMs, options.signal);
	}
	onlyKeys(args, ["op", "id", "cursor", "limit", "waitMs"]);
	const limit = integer(args.limit, "limit", MAX_EVENTS, MAX_EVENTS);
	if (limit === 0) throw new Error("limit must be at least 1");
	return store.read(
		args.id,
		integer(args.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER),
		limit,
		waitMs,
		options.signal,
	);
}

export async function disposeSessionExecutionEvents(session: ToolSession): Promise<void> {
	await stores.get(session)?.dispose(undefined, true);
}
