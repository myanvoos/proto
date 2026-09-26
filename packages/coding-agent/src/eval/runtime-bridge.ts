import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { atomicWriteFile, isEnoent } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { type EvalArtifactResult, runEvalArtifact } from "./artifact-values";
import { type EvalDelegationResult, runEvalDelegation } from "./delegation";
import { type ExecutionEventsResult, runExecutionEvents } from "./execution-events";
import type { EvalStatusEvent } from "./types";

export const EVAL_RUNTIME_BRIDGE_NAME = "__runtime__";
export interface ExecutionRecord {
	id: string;
	command: string;
	lane: string;
	/** When the call was issued and joined its lane queue. */
	queuedAt?: number;
	/** When the call left the lane queue and began executing; absent while still queued. */
	startedAt?: number;
	finishedAt?: number;
	result?: AgentToolResult;
	error?: string;
	resultOmitted?: string;
}
interface StoredRecord {
	id: string;
	json: string;
	bytes: number;
}
interface RecordStore {
	records: StoredRecord[];
	evicted: number;
	bytes: number;
}
const stores = new WeakMap<ToolSession, RecordStore>();
const MAX_BYTES = 8 * 1024 * 1024;
// Leave space for the JSON array and query envelope, not only record payloads.
const MAX_RECORD_BYTES = MAX_BYTES - 1024;

export function recordExecution(session: ToolSession, record: ExecutionRecord): void {
	if (
		typeof record.id !== "string" ||
		!record.id ||
		typeof record.command !== "string" ||
		typeof record.lane !== "string" ||
		!record.lane ||
		(record.queuedAt !== undefined && !Number.isFinite(record.queuedAt)) ||
		(record.startedAt !== undefined && !Number.isFinite(record.startedAt)) ||
		(record.queuedAt === undefined && record.startedAt === undefined) ||
		(record.finishedAt !== undefined && !Number.isFinite(record.finishedAt)) ||
		(record.error !== undefined && typeof record.error !== "string") ||
		(record.resultOmitted !== undefined && typeof record.resultOmitted !== "string")
	) {
		throw new Error("Invalid execution record identity or metadata");
	}
	const snapshot: ExecutionRecord = {
		id: record.id,
		command: record.command,
		lane: record.lane,
		queuedAt: record.queuedAt,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		error: record.error,
		resultOmitted: record.resultOmitted,
	};
	let json: string;
	try {
		json = JSON.stringify({ ...snapshot, result: record.result });
	} catch {
		snapshot.resultOmitted = "Result is not JSON serializable";
		json = JSON.stringify(snapshot);
	}
	if (Buffer.byteLength(json) > MAX_RECORD_BYTES && record.result !== undefined) {
		snapshot.resultOmitted = "Result exceeds execution history byte limit";
		json = JSON.stringify(snapshot);
	}
	let store = stores.get(session);
	if (!store) {
		store = { records: [], evicted: 0, bytes: 0 };
		stores.set(session, store);
	}
	const previous = store.records.findIndex(entry => entry.id === record.id);
	if (previous >= 0) store.bytes -= store.records.splice(previous, 1)[0].bytes;
	const bytes = Buffer.byteLength(json);
	// Oversized metadata cannot be retained, even when it would be the only record.
	if (bytes > MAX_RECORD_BYTES) {
		store.evicted++;
		return;
	}
	store.records.push({ id: record.id, json, bytes });
	store.bytes += bytes;
	while (store.records.length > 128 || store.bytes > MAX_RECORD_BYTES) {
		store.bytes -= store.records.shift()!.bytes;
		store.evicted++;
	}
}

export type RuntimeBridgeResult =
	| ExecutionEventsResult
	| EvalArtifactResult
	| EvalDelegationResult
	| { records: ExecutionRecord[]; evicted: number }
	| { found: boolean; value?: unknown }
	| { saved: true };

function parseCheckpoint(text: string, key: string): { value: unknown } {
	let entry: unknown;
	try {
		entry = JSON.parse(text);
	} catch (error) {
		throw new Error("Checkpoint contains invalid JSON", { cause: error });
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry))
		throw new Error("Checkpoint envelope must be an object");
	const envelope = entry as Record<string, unknown>;
	if (envelope.version !== 1 || envelope.key !== key) throw new Error("Checkpoint identity mismatch (version or key)");
	if (!Object.hasOwn(envelope, "value")) throw new Error("Checkpoint value must be JSON serializable");
	return { value: envelope.value };
}

export async function runEvalRuntime(
	args: unknown,
	options: { session: ToolSession; signal?: AbortSignal; emitStatus?: (event: EvalStatusEvent) => void },
): Promise<RuntimeBridgeResult> {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("runtime bridge expects an object");
	const request = args as Record<string, unknown>;
	options.signal?.throwIfAborted();
	if (
		request.op === "events_start" ||
		request.op === "events_read" ||
		request.op === "events_cancel" ||
		request.op === "events_dispose"
	)
		return runExecutionEvents(request, options);
	if (request.op === "artifact_publish" || request.op === "artifact_read" || request.op === "artifact_resolve") {
		return runEvalArtifact(request, options);
	}
	if (
		request.op === "delegation_create" ||
		request.op === "delegation_list" ||
		request.op === "delegation_revoke" ||
		request.op === "delegation_launch"
	)
		return runEvalDelegation(request, options);
	if (request.op === "executions") {
		const limit = request.limit ?? 20;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 128)
			throw new Error("executions limit must be 0–128");
		if (request.id !== undefined && (typeof request.id !== "string" || !request.id))
			throw new Error("executions id must be a non-empty string");
		options.emitStatus?.({ op: "execution-query" });
		const store = stores.get(options.session);
		const records = (store?.records ?? []).filter(entry => request.id === undefined || request.id === entry.id);
		return {
			records: limit === 0 ? [] : records.slice(-limit).map(entry => JSON.parse(entry.json) as ExecutionRecord),
			evicted: store?.evicted ?? 0,
		};
	}
	if (request.op === "checkpoint_load" || request.op === "checkpoint_save") {
		if (
			typeof request.path !== "string" ||
			!request.path ||
			request.path.includes("\0") ||
			typeof request.key !== "string" ||
			!request.key
		)
			throw new Error("checkpoint requires non-empty path and key");
		const root = resolveToCwd(request.path, options.session.cwd);
		const digest = new Bun.CryptoHasher("sha256").update(request.key).digest("hex");
		const file = path.join(root, `${digest}.json`);
		if (request.op === "checkpoint_load") {
			let text: string;
			try {
				const source = Bun.file(file);
				if (source.size > MAX_BYTES) throw new Error("Checkpoint item exceeds 8 MiB");
				text = await source.text();
			} catch (error) {
				if (isEnoent(error)) return { found: false };
				throw error;
			}
			if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Checkpoint item exceeds 8 MiB");
			options.signal?.throwIfAborted();
			return { found: true, ...parseCheckpoint(text, request.key) };
		}
		// Serialize exactly once before creating directories or replacing a prior item.
		const text = JSON.stringify({ version: 1, key: request.key, value: request.value });
		if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Checkpoint item exceeds 8 MiB");
		parseCheckpoint(text, request.key);
		options.signal?.throwIfAborted();
		await atomicWriteFile(file, text);
		return { saved: true };
	}
	throw new Error(`Unknown runtime operation: ${String(request.op)}`);
}
