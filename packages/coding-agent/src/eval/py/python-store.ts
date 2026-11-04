import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { SessionManager } from "../../session/session-manager";
import type { ToolSession } from "../../tools";
import { withDeclaredStateExecution } from "../declared-state";
import { MAX_GRAPH_PAYLOAD_CHARS } from "../state-limits";
import type { PythonHarnessContext } from "./harness-types";
import { filterEnv, resolveExplicitPythonRuntime } from "./runtime";
import { stagePythonRuntimeAssets } from "./runtime-assets";

export interface PythonGraphEnvelope {
	format: "proto.python-graph";
	version: 1;
	metadata: Record<string, unknown>;
	modules: Record<string, { file: string | null; version: string }>;
	payload: string;
}
export interface PythonStoreState {
	revision: number;
	graph: PythonGraphEnvelope | null;
}
type StoreManager = Pick<SessionManager, "getBranch" | "appendEntriesAtomically" | "appendCustomEntry">;
const staged = new Map<string, PythonStoreState>();
const STORE_ENTRY = "python-store";

/** Host validates the transport envelope only. Python pickle is never evaluated here. */
export function validatePythonGraph(value: unknown): asserts value is PythonGraphEnvelope {
	if (!value || typeof value !== "object") throw new Error("Corrupt Python graph envelope");
	const graph = value as Partial<PythonGraphEnvelope>;
	if (graph.format !== "proto.python-graph" || graph.version !== 1)
		throw new Error("Unsupported Python graph format/version");
	if (
		!graph.metadata ||
		typeof graph.metadata !== "object" ||
		!graph.modules ||
		typeof graph.modules !== "object" ||
		typeof graph.payload !== "string" ||
		graph.payload.length > MAX_GRAPH_PAYLOAD_CHARS ||
		graph.payload.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(graph.payload)
	)
		throw new Error("Corrupt or oversized Python graph payload");
}

export function validatePythonStore(value: unknown): asserts value is PythonStoreState {
	if (!value || typeof value !== "object") throw new Error("Corrupt Python store state");
	const state = value as PythonStoreState;
	if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Corrupt Python store revision");
	if (state.graph !== null) validatePythonGraph(state.graph);
}

/** Store graphs belong to native callers, not necessarily a supported warm-kernel interpreter. */
export async function validatePythonStoreEnvironment(graph: PythonGraphEnvelope): Promise<void> {
	validatePythonGraph(graph);
	const { cwd, executable } = graph.metadata;
	if (
		typeof cwd !== "string" ||
		typeof executable !== "string" ||
		!path.isAbsolute(cwd) ||
		!path.isAbsolute(executable)
	)
		throw new Error("Corrupt Python store environment");
	const { env } = (await Settings.init()).getShellConfig();
	const runtime = resolveExplicitPythonRuntime(executable, cwd, filterEnv(env));
	const packageRoot = await stagePythonRuntimeAssets();
	await ptree.exec(
		[
			runtime.pythonPath,
			"-c",
			"import json, sys; from proto_harness import _serialization; _serialization.loads(json.load(sys.stdin))",
		],
		{
			cwd,
			env: {
				...runtime.env,
				PYTHONPATH: [packageRoot, runtime.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
			},
			input: JSON.stringify(graph),
			timeout: 15_000,
			detached: true,
			maxStdoutBytes: 64 * 1024,
			maxStderrBytes: 64 * 1024,
		},
	);
}

function readPythonStore(owner: string, manager: Pick<StoreManager, "getBranch">): PythonStoreState {
	const pending = staged.get(owner);
	if (pending) return pending;
	let state: PythonStoreState = { revision: 0, graph: null };
	for (const entry of manager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === STORE_ENTRY) {
			validatePythonStore(entry.data);
			state = entry.data;
		} else if (entry.customType === "declared-state") {
			const manifest = entry.data as { pythonStore?: unknown };
			if (manifest.pythonStore !== undefined) {
				validatePythonStore(manifest.pythonStore);
				state = manifest.pythonStore;
			}
		}
	}
	return state;
}

export function capturePythonStore(owner: string, manager: Pick<StoreManager, "getBranch">): PythonStoreState {
	return structuredClone(readPythonStore(owner, manager));
}

/** Read under the owner's boundary; do not duplicate a potentially large payload to check continuity. */
export function hasPythonStore(owner: string, manager: Pick<StoreManager, "getBranch">): boolean {
	const state = readPythonStore(owner, manager);
	return state.revision > 0 || state.graph !== null;
}

export function stagePythonStore(owner: string, state: PythonStoreState): void {
	validatePythonStore(state);
	staged.set(owner, structuredClone(state));
}

export function releasePythonStore(owner: string): void {
	staged.delete(owner);
}

function ownerId(session: ToolSession): string {
	const owner = session.getEvalKernelOwnerId?.() ?? session.getSessionId?.() ?? session.sessionManager?.getSessionId();
	if (!owner) throw new Error("Python store requires an authenticated session owner");
	return owner;
}

export async function dispatchPythonStoreRequest(
	context: PythonHarnessContext,
	operation: string,
	args: Record<string, unknown>,
): Promise<PythonStoreState | { revision: number }> {
	const manager = context.session.sessionManager;
	if (!manager) throw new Error("Python store requires durable session persistence");
	const owner = ownerId(context.session);
	return withDeclaredStateExecution(owner, async () => {
		context.signal.throwIfAborted();
		if (operation === "store.get_graph") return capturePythonStore(owner, manager);
		if (operation !== "store.put_graph") throw new Error("Unknown Python store operation");
		validatePythonGraph(args.graph);
		const graph = structuredClone(args.graph);
		const expected = args.expected_revision;
		if (!Number.isSafeInteger(expected) || (expected as number) < 0)
			throw new Error("Python store expected_revision must be a nonnegative integer");
		let next!: PythonStoreState;
		await manager.appendEntriesAtomically(() => {
			context.signal.throwIfAborted();
			const current = readPythonStore(owner, manager);
			if (current.revision !== expected)
				throw new Error(`Python store revision conflict: expected ${expected}, current ${current.revision}`);
			if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("Python store revision exhausted");
			next = { revision: current.revision + 1, graph };
			manager.appendCustomEntry(STORE_ENTRY, next);
		});
		// Publish only after the immutable session entry has durably committed.
		staged.delete(owner);
		return { revision: next.revision };
	});
}
