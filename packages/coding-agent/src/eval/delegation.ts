import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import type { Server } from "bun";
import { daemonClientForProject } from "../launch/client";
import type { DaemonSnapshot } from "../launch/protocol";
import type { ToolSession } from "../tools";
import { executeLaunch } from "../tools/jobs/launch";
import { ToolError } from "../tools/tool-errors";
import pythonClient from "./delegation/proto_session.py" with { type: "text" };
import javascriptClient from "./delegation/proto-session.mjs.txt" with { type: "text" };
import { callSessionToolPromptOnAbort } from "./py/tool-bridge";

export interface DelegationGrant {
	tool: string;
	/** Exact args.op values; omission grants all operations of an ordinary tool. */
	operations?: string[];
}

export interface DelegationLeaseSnapshot {
	id: string;
	owner: string;
	state: "active" | "revoked" | "expired";
	createdAt: number;
	expiresAt: number;
	grants: DelegationGrant[];
	maxConcurrent: number;
	maxRequests: number;
	requests: number;
	inFlight: number;
}

export interface DelegationClients {
	python: { module: "proto_session"; path: string };
	javascript: { path: string; url: string };
}

export type EvalDelegationResult =
	| { lease: DelegationLeaseSnapshot; clients: DelegationClients; env?: Record<string, string> }
	| { leases: DelegationLeaseSnapshot[] }
	| { lease: DelegationLeaseSnapshot }
	| { lease: DelegationLeaseSnapshot; process: DaemonSnapshot };

interface Lease {
	info: Omit<DelegationLeaseSnapshot, "inFlight">;
	token: string;
	file: string;
	controller: AbortController;
	calls: Map<string, AbortController>;
	cancelled: Set<string>;
	launches: Map<string, Promise<DaemonSnapshot>>;
	timer: NodeJS.Timeout;
	closing?: Promise<void>;
}

interface SessionDelegations {
	session: ToolSession;
	owner: string;
	identity: string | null;
	dir: TempDir;
	clients: DelegationClients;
	server: Server<undefined>;
	leases: Map<string, Lease>;
	disposed: boolean;
	disposal?: Promise<void>;
	unregister: (() => void)[];
}

const sessions = new WeakMap<ToolSession, Promise<SessionDelegations>>();
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ARTIFACT_OPS: Record<string, true> = { artifact_publish: true, artifact_read: true, artifact_resolve: true };
// These tools can re-enter an unscoped session, execute host code, or control its authority.
// There is deliberately no escalation switch: granting a name cannot override this boundary.
const EXECUTION_TOOLS: Record<string, true> = {
	bash: true,
	context: true,
	python: true,
	javascript: true,
	js: true,
	agent: true,
	fleet: true,
	jobs: true,
	browser: true,
	computer: true,
	checkpoint: true,
	rewind: true,
	manage_skill: true,
	yield: true,
	goal: true,
};

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("Expected an object");
	const result = value as Record<string, unknown>;
	if (keys && Object.keys(result).some(key => !keys.includes(key)))
		throw new ToolError("Unknown delegation parameter");
	return result;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
		throw new ToolError(`${label} must be a nonempty string`);
	}
	return value;
}

function limit(value: unknown, fallback: number, max: number, label: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new ToolError(`${label} must be an integer from 1 to ${max}`);
	}
	return value;
}

function ordinaryTool(session: ToolSession, name: string): void {
	if (name.startsWith("__") || Object.hasOwn(EXECUTION_TOOLS, name)) throw new ToolError("Tool cannot be delegated");
	const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
	if (!tool) throw new ToolError("Unknown delegated tool");
	if (tool.name.startsWith("__") || Object.hasOwn(EXECUTION_TOOLS, tool.name))
		throw new ToolError("Tool cannot be delegated");
}

function grants(value: unknown, session: ToolSession): DelegationGrant[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64)
		throw new ToolError("grants requires 1-64 entries");
	const seen = new Set<string>();
	return value.map(item => {
		const input = record(item, ["tool", "operations"]);
		const tool = string(input.tool, "grant.tool");
		if (seen.has(tool)) throw new ToolError("Duplicate delegated tool");
		seen.add(tool);
		let operations: string[] | undefined;
		if (input.operations !== undefined) {
			if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 64) {
				throw new ToolError("grant.operations requires 1-64 exact operation names");
			}
			operations = [...new Set(input.operations.map(op => string(op, "grant.operations")))];
		}
		if (tool === "__runtime__") {
			if (!operations || operations.some(op => !Object.hasOwn(ARTIFACT_OPS, op)))
				throw new ToolError("Only artifact operations can be delegated");
		} else if (tool === "__completion__") {
			if (operations) throw new ToolError("Completion grants do not accept operations");
		} else ordinaryTool(session, tool);
		return { tool, ...(operations ? { operations } : {}) };
	});
}

function snapshot(lease: Lease): DelegationLeaseSnapshot {
	return { ...lease.info, grants: structuredClone(lease.info.grants), inFlight: lease.calls.size };
}

function launchEnv(state: SessionDelegations, lease: Lease): Record<string, string> {
	return {
		PROTO_SESSION_CAPABILITY: lease.file,
		PROTO_SESSION_CLIENT_JS: state.clients.javascript.url,
		PYTHONPATH: state.dir.path(),
	};
}

function sessionIdentity(session: ToolSession): string | null {
	return session.getSessionId?.() ?? session.getAgentId?.() ?? null;
}

async function stopLaunch(state: SessionDelegations, pending: Promise<DaemonSnapshot>): Promise<void> {
	const launched = await pending.catch(() => undefined);
	if (!launched) return;
	const client = await daemonClientForProject(state.session.cwd);
	const current = await client.request({ op: "describe", name: launched.name });
	if (current.op !== "describe" || current.daemon.id !== launched.id) return;
	try {
		await client.request({ op: "stop", name: launched.name, expectedId: launched.id, timeoutMs: 1000 });
	} catch (error) {
		// An exited process name may be reused between describe and stop. Never stop its replacement.
		const latest = await client.request({ op: "describe", name: launched.name });
		if (latest.op !== "describe" || latest.daemon.id === launched.id) throw error;
	}
}

function closeLease(state: SessionDelegations, lease: Lease, reason: "revoked" | "expired"): Promise<void> {
	if (lease.closing) return lease.closing;
	lease.info.state = reason;
	clearTimeout(lease.timer);
	lease.controller.abort(new Error(`Delegation ${reason}`));
	lease.token = "";
	lease.closing = (async () => {
		// Settle every launch first: a revoked lease must not leave an untracked child behind.
		const stopped = await Promise.allSettled([...lease.launches.values()].map(pending => stopLaunch(state, pending)));
		await fs.rm(lease.file, { force: true });
		const failed = stopped.find(result => result.status === "rejected");
		if (failed?.status === "rejected")
			throw new ToolError("Failed to stop a delegated process; capability is revoked");
	})();
	return lease.closing;
}

function cleanup(state: SessionDelegations): Promise<void> {
	if (state.disposal) return state.disposal;
	state.disposed = true;
	for (const unregister of state.unregister) unregister();
	state.disposal = (async () => {
		const closing = [...state.leases.values()].map(lease => closeLease(state, lease, "revoked"));
		await state.server.stop(true);
		const results = await Promise.allSettled(closing);
		await state.dir.remove();
		if (results.some(result => result.status === "rejected")) throw new ToolError("Delegated process cleanup failed");
	})();
	return state.disposal;
}

export async function disposeSessionDelegations(session: ToolSession): Promise<void> {
	const pending = sessions.get(session);
	if (!pending) return;
	try {
		await cleanup(await pending);
	} finally {
		if (sessions.get(session) === pending) sessions.delete(session);
	}
}

function backgroundCleanup(work: Promise<void>): void {
	void work.catch(() => logger.warn("Session delegation cleanup failed; capabilities have been revoked"));
}

function failure(code: string, error: string, status: number): Response {
	return Response.json({ ok: false, code, error }, { status });
}

function checkCall(state: SessionDelegations, lease: Lease, name: string, args: unknown): void {
	const grant = lease.info.grants.find(item => item.tool === name);
	if (!grant) throw new ToolError("Delegated tool is not allowed");
	if (grant.operations) {
		const operation = record(args).op;
		if (typeof operation !== "string" || !grant.operations.includes(operation))
			throw new ToolError("Delegated operation is not allowed");
	}
	if (name === "__runtime__") {
		const input = record(args);
		if (!Object.hasOwn(ARTIFACT_OPS, String(input.op)) || Object.hasOwn(input, "path")) {
			throw new ToolError("Delegated artifacts accept values and owned references, not filesystem paths");
		}
	} else if (name === "__completion__") {
		// Completion is data-only. In particular tools, agent options and runtime ops are not accepted.
		record(args, ["prompt", "model", "system", "schema"]);
	} else ordinaryTool(state.session, name);
}

async function handleRequest(state: SessionDelegations, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const route = /^\/v1\/delegation\/([a-f0-9-]{36})\/(call|cancel)$/.exec(url.pathname);
	if (request.method !== "POST" || !route || request.headers.has("origin"))
		return failure("forbidden", "Forbidden", 403);
	const lease = state.leases.get(route[1]);
	const expected = lease?.token ? `Bearer ${lease.token}` : "";
	const supplied = request.headers.get("authorization") ?? "";
	if (
		!expected ||
		Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
		!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
	) {
		return failure("forbidden", "Delegation is unavailable", 403);
	}
	if (sessionIdentity(state.session) !== state.identity) {
		backgroundCleanup(disposeSessionDelegations(state.session));
		return failure("forbidden", "Delegation is unavailable", 403);
	}
	if (
		state.disposed ||
		state.session.isDisposed?.() ||
		lease!.info.state !== "active" ||
		Date.now() >= lease!.info.expiresAt
	) {
		if (lease!.info.state === "active") backgroundCleanup(closeLease(state, lease!, "expired"));
		return failure("expired", "Delegation is unavailable", 403);
	}
	let input: Record<string, unknown>;
	try {
		if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
			return failure("size", "Request is too large", 413);
		const bytes = await request.arrayBuffer();
		if (bytes.byteLength > MAX_BODY_BYTES) return failure("size", "Request is too large", 413);
		input = record(
			JSON.parse(new TextDecoder().decode(bytes)),
			route[2] === "cancel" ? ["id"] : ["id", "name", "args"],
		);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(string(input.id, "request.id"))) throw new ToolError("Invalid request id");
	} catch {
		return failure("invalid", "Invalid delegation request", 400);
	}
	const active = lease!;
	const id = input.id as string;
	if (route[2] === "cancel") {
		const controller = active.calls.get(id);
		controller?.abort(new Error("Delegated request cancelled"));
		if (!controller) {
			if (active.cancelled.size >= 128) return failure("limit", "Cancellation limit reached", 429);
			active.cancelled.add(id);
		}
		return Response.json({ ok: true, value: { cancelled: Boolean(controller) } });
	}
	let name: string;
	try {
		name = string(input.name, "request.name");
		checkCall(state, active, name, input.args);
	} catch {
		return failure("denied", "Delegated tool or operation is not allowed", 403);
	}
	if (active.controller.signal.aborted || request.signal.aborted || active.cancelled.delete(id))
		return failure("cancelled", "Delegated request cancelled", 409);
	if (active.calls.has(id)) return failure("duplicate", "Request id is already in flight", 409);
	if (active.calls.size >= active.info.maxConcurrent || active.info.requests >= active.info.maxRequests) {
		return failure("limit", "Delegation request limit reached", 429);
	}
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, active.controller.signal, request.signal]);
	active.calls.set(id, controller);
	active.info.requests++;
	try {
		const value = await callSessionToolPromptOnAbort(name, input.args, {
			toolSession: state.session,
			signal,
			abortRequested: () => signal.aborted,
			drainOnAbort: true,
		});
		if (signal.aborted) return failure("cancelled", "Delegated request cancelled", 409);
		const body = JSON.stringify({ ok: true, value });
		if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
			return failure("size", "Response exceeds delegation limit; use an artifact reference", 413);
		return new Response(body, { headers: { "content-type": "application/json" } });
	} catch (error) {
		if (signal.aborted) return failure("cancelled", "Delegated request cancelled", 409);
		return failure("tool", error instanceof Error ? error.message : "Delegated tool failed", 400);
	} finally {
		active.calls.delete(id);
	}
}

async function createState(session: ToolSession): Promise<SessionDelegations> {
	const dir = await TempDir.create("@proto-delegation-");
	try {
		await fs.chmod(dir.path(), 0o700);
		await Promise.all([
			fs.writeFile(dir.join("proto_session.py"), pythonClient, { flag: "wx", mode: 0o600 }),
			fs.writeFile(dir.join("proto-session.mjs"), javascriptClient, { flag: "wx", mode: 0o600 }),
		]);
		if (session.isDisposed?.()) throw new ToolError("Session is disposed");
		const state: SessionDelegations = {
			session,
			owner: sessionIdentity(session) ?? crypto.randomUUID(),
			identity: sessionIdentity(session),
			dir,
			clients: {
				python: { module: "proto_session", path: dir.join("proto_session.py") },
				javascript: { path: dir.join("proto-session.mjs"), url: pathToFileURL(dir.join("proto-session.mjs")).href },
			},
			server: Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				maxRequestBodySize: MAX_BODY_BYTES,
				fetch: request => handleRequest(state, request),
			}),
			leases: new Map(),
			disposed: false,
			unregister: [],
		};
		for (const register of [session.registerDisposeCallback, session.registerSessionChangeCallback]) {
			const unregister = register?.call(session, () => backgroundCleanup(disposeSessionDelegations(session)));
			if (unregister) state.unregister.push(unregister);
		}
		return state;
	} catch (error) {
		await dir.remove();
		throw error;
	}
}

async function createLease(
	input: Record<string, unknown>,
	session: ToolSession,
	signal?: AbortSignal,
): Promise<EvalDelegationResult> {
	record(input, ["op", "grants", "ttlMs", "maxConcurrent", "maxRequests", "expose"]);
	const allowed = grants(input.grants, session);
	const ttlMs = limit(input.ttlMs, 60_000, 900_000, "ttlMs");
	const maxConcurrent = limit(input.maxConcurrent, 4, 32, "maxConcurrent");
	const maxRequests = limit(input.maxRequests, 100, 10_000, "maxRequests");
	if (input.expose !== undefined && typeof input.expose !== "boolean") throw new ToolError("expose must be boolean");
	signal?.throwIfAborted();
	if (session.isDisposed?.()) throw new ToolError("Session is disposed");
	let pending = sessions.get(session);
	if (!pending) {
		pending = createState(session);
		sessions.set(session, pending);
		void pending.catch(() => {
			if (sessions.get(session) === pending) sessions.delete(session);
		});
	}
	const state = await pending;
	signal?.throwIfAborted();
	if (state.disposed) throw new ToolError("Session delegation is disposed");
	if (sessionIdentity(session) !== state.identity) {
		await disposeSessionDelegations(session);
		throw new ToolError("Delegation belongs to a previous session identity");
	}
	if ([...state.leases.values()].filter(lease => lease.info.state === "active").length >= 32)
		throw new ToolError("Active delegation limit reached");
	for (const [id, lease] of state.leases) {
		if (state.leases.size < 128) break;
		if (lease.info.state !== "active" && !lease.calls.size) state.leases.delete(id);
	}
	if (state.leases.size >= 128) throw new ToolError("Delegation retention limit reached");
	const id = crypto.randomUUID();
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	const createdAt = Date.now();
	const file = state.dir.join(`${id}.json`);
	const lease: Lease = {
		info: {
			id,
			owner: state.owner,
			state: "active",
			createdAt,
			expiresAt: createdAt + ttlMs,
			grants: allowed,
			maxConcurrent,
			maxRequests,
			requests: 0,
		},
		token,
		file,
		controller: new AbortController(),
		calls: new Map(),
		cancelled: new Set(),
		launches: new Map(),
		timer: setTimeout(() => backgroundCleanup(closeLease(state, lease, "expired")), ttlMs),
	};
	lease.timer.unref();
	state.leases.set(id, lease);
	// The caller's signal cancels creation only. It is the creating kernel cell's signal, which
	// aborts when the cell finishes; the lease itself lives until revoke, expiry or session end.
	const onAbort = () => backgroundCleanup(closeLease(state, lease, "revoked"));
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await fs.writeFile(
			file,
			JSON.stringify({ version: 1, url: `http://127.0.0.1:${state.server.port}/v1/delegation/${id}`, token }),
			{ flag: "wx", mode: 0o600 },
		);
		if (signal?.aborted || state.disposed || lease.info.state !== "active") {
			await closeLease(state, lease, "revoked");
			await fs.rm(file, { force: true });
			throw new ToolError("Delegation creation cancelled");
		}
		return {
			lease: snapshot(lease),
			clients: state.clients,
			...(input.expose === true ? { env: launchEnv(state, lease) } : {}),
		};
	} catch (error) {
		await closeLease(state, lease, "revoked");
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

async function launch(
	state: SessionDelegations,
	lease: Lease,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<EvalDelegationResult> {
	record(input, ["op", "id", "name", "application", "args", "cwd", "env"]);
	if (!state.session.settings.get("launch.enabled")) throw new ToolError("Process supervision is disabled");
	if (lease.info.state !== "active" || Date.now() >= lease.info.expiresAt)
		throw new ToolError("Delegation is unavailable");
	const name = string(input.name, "name");
	const application = string(input.application, "application");
	const cwd = input.cwd === undefined ? undefined : string(input.cwd, "cwd");
	if (
		input.args !== undefined &&
		(!Array.isArray(input.args) || input.args.some(arg => typeof arg !== "string" || arg.includes("\0")))
	)
		throw new ToolError("args must be a string array");
	const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" };
	if (input.env !== undefined) {
		for (const [key, value] of Object.entries(record(input.env))) {
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
				/^(?:PROTO_|PYTHON|NODE_OPTIONS$|NODE_PATH$|BUN_|LD_|DYLD_)/.test(key)
			)
				throw new ToolError("Reserved delegated process environment variable");
			if (typeof value !== "string" || value.includes("\0")) throw new ToolError("env must contain strings");
			env[key] = value;
		}
	}
	if (lease.launches.has(name) || lease.launches.size >= 8)
		throw new ToolError("Delegated launch limit or duplicate name");
	signal?.throwIfAborted();
	const onAbort = () => backgroundCleanup(closeLease(state, lease, "revoked"));
	signal?.addEventListener("abort", onAbort, { once: true });
	// Do not abort the broker acknowledgement: even a racing revoke must obtain the verified process identity.
	const pending = executeLaunch(state.session, {
		op: "start",
		name,
		application,
		args: input.args as string[] | undefined,
		cwd,
		env: { ...env, ...launchEnv(state, lease) },
		inheritEnv: false,
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	}).then(result => {
		if (!result.details?.daemon) throw new ToolError("Delegated process did not start");
		return result.details.daemon;
	});
	lease.launches.set(name, pending);
	try {
		const process = await pending;
		if (lease.info.state !== "active") {
			await closeLease(state, lease, "revoked");
			throw new ToolError("Delegation was revoked during launch");
		}
		return { lease: snapshot(lease), process };
	} catch (error) {
		lease.launches.delete(name);
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export async function runEvalDelegation(
	args: unknown,
	options: { session: ToolSession; signal?: AbortSignal },
): Promise<EvalDelegationResult> {
	const input = record(args);
	if (input.op === "delegation_create") return createLease(input, options.session, options.signal);
	if (input.op !== "delegation_list" && input.op !== "delegation_revoke" && input.op !== "delegation_launch")
		throw new ToolError("Unknown delegation operation");
	if (input.op === "delegation_list") record(input, ["op"]);
	else if (input.op === "delegation_revoke") record(input, ["op", "id"]);
	const pending = sessions.get(options.session);
	if (!pending) {
		if (input.op === "delegation_list") return { leases: [] };
		throw new ToolError("Unknown delegation lease for this session");
	}
	const state = await pending;
	if (state.disposed || options.session.isDisposed?.()) throw new ToolError("Session is disposed");
	if (sessionIdentity(options.session) !== state.identity) {
		await disposeSessionDelegations(options.session);
		throw new ToolError("Delegation belongs to a previous session identity");
	}
	if (input.op === "delegation_list") return { leases: [...state.leases.values()].map(snapshot) };
	const lease = state.leases.get(string(input.id, "id"));
	if (!lease) throw new ToolError("Unknown delegation lease for this session");
	if (input.op === "delegation_launch") return launch(state, lease, input, options.signal);
	await closeLease(state, lease, "revoked");
	return { lease: snapshot(lease) };
}
