import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import { callSessionTool, type JsStatusEvent } from "../js/tool-bridge";

export interface PyToolBridgeEntry {
	toolSession: ToolSession;
	/** Host-side cwd of the cell that owns this run; absent for remote kernel targets. */
	cwd?: string;

	signal?: AbortSignal;

	shieldedSignal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	abortRequested?: () => boolean;
	completionContext?: EvalCompletionInvocationContext;
	/** Keep admission occupied until the underlying tool acknowledges cancellation. */
	drainOnAbort?: boolean;
}

export interface PyToolBridgeInfo {
	url: string;
	token: string;
}

interface BridgeServer {
	info: PyToolBridgeInfo;
	stop: () => Promise<void>;
}

const registrations = new Map<string, PyToolBridgeEntry>();
let serverPromise: Promise<BridgeServer> | null = null;

export async function callSessionToolPromptOnAbort(
	name: string,
	args: unknown,
	entry: PyToolBridgeEntry,
	completionInvocationId?: string,
): Promise<unknown> {
	if (entry.abortRequested?.()) {
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const call = callSessionTool(name, args, {
		session: entry.toolSession,
		cwd: entry.cwd,
		signal: entry.signal,
		emitStatus: entry.emitStatus,
		completionContext: entry.completionContext,
		completionInvocationId,
	});
	if (entry.drainOnAbort) return await call;
	const signal = entry.shieldedSignal ?? entry.signal;
	if (!signal) return await call;
	if (signal.aborted) {
		void call.catch(() => {});
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([call, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);

		void call.catch(() => {});
	}
}

/** Stdio targets supply only run/name/args; the parent binds the session, never the remote peer. */
export async function dispatchPyToolBridge(
	sessionId: string,
	runId: string,
	name: string,
	args: unknown,
	completionInvocationId?: string,
): Promise<unknown> {
	const key = bridgeRegistrationKey(sessionId, runId);
	const entry = registrations.get(key) ?? registrations.get(sessionId);
	if (!entry) throw new Error(`No active Python tool bridge session: ${key}`);
	return await callSessionToolPromptOnAbort(name, args, entry, completionInvocationId);
}

async function startServer(): Promise<BridgeServer> {
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== "/v1/tool") {
				return new Response("Not Found", { status: 404 });
			}
			if (req.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("Forbidden", { status: 403 });
			}

			let body: {
				session?: unknown;
				run?: unknown;
				name?: unknown;
				args?: unknown;
				completionInvocationId?: unknown;
			};
			try {
				body = (await req.json()) as { session?: unknown; run?: unknown; name?: unknown; args?: unknown };
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}
			const sessionId = typeof body.session === "string" ? body.session : "";
			const runId = typeof body.run === "string" ? body.run : "";
			const name = typeof body.name === "string" ? body.name : "";
			if (!sessionId || !runId || !name) {
				return Response.json({ ok: false, error: "Missing session/run/name" }, { status: 400 });
			}
			try {
				const value = await dispatchPyToolBridge(
					sessionId,
					runId,
					name,
					body.args,
					typeof body.completionInvocationId === "string" ? body.completionInvocationId : undefined,
				);
				return Response.json({ ok: true, value });
			} catch (err) {
				return Response.json({
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	});

	const info: PyToolBridgeInfo = {
		url: `http://${server.hostname}:${server.port}`,
		token,
	};
	logger.debug("Python tool bridge listening", { url: info.url });

	return {
		info,
		stop: async () => {
			await server.stop(true);
		},
	};
}

export async function ensurePyToolBridge(): Promise<PyToolBridgeInfo> {
	if (!serverPromise) {
		serverPromise = startServer();
	}
	try {
		const server = await serverPromise;
		return server.info;
	} catch (err) {
		serverPromise = null;
		throw err;
	}
}

function bridgeRegistrationKey(sessionId: string, runId: string): string {
	return `${sessionId}:${runId}`;
}

export function registerPyToolBridge(sessionId: string, runId: string, entry: PyToolBridgeEntry): () => void {
	const key = bridgeRegistrationKey(sessionId, runId);
	registrations.set(key, entry);
	return () => {
		if (registrations.get(key) === entry) {
			registrations.delete(key);
		}
	};
}

export async function disposePyToolBridge(): Promise<void> {
	registrations.clear();
	const pending = serverPromise;
	serverPromise = null;
	if (!pending) return;
	try {
		const server = await pending;
		await server.stop();
	} catch (err) {
		logger.debug("Failed to stop Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
