import { logger, postmortem, Snowflake, workerHostEntry } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import type { EvalCompletionInvocationContext } from "../completion-bridge";
import { attachSessionOwner, resolveOwnerScopedSessionKey, type SessionOwners } from "../executor-base";
import { DEFAULT_KERNEL_IDLE_REAP_MS, type KernelReapNote } from "../idle-timeout";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import { WorkerCore } from "./worker-core";

import type {
	JsDisplayOutput,
	RunErrorPayload,
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";
export type { JsDisplayOutput } from "./worker-protocol";

interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface WorkerHandle {
	mode: "process" | "worker" | "inline";
	send(msg: WorkerInbound): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	resolve(value: { value: unknown }): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	completionContext?: EvalCompletionInvocationContext;

	deferDepth: number;

	deferDrained?: PromiseWithResolvers<void>;

	aborted: boolean;

	heldResult?: Extract<WorkerOutbound, { type: "result" }>;
	settled: boolean;
}

interface JsSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	worker: WorkerHandle;
	state: "alive" | "dead";
	pending: Map<string, PendingRun>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	reapTimer?: NodeJS.Timeout;
}

interface StartingJsSession extends SessionOwners {
	promise: Promise<JsSession>;
}

const sessions = new Map<string, JsSession>();
const startingSessions = new Map<string, StartingJsSession>();
const resettingSessions = new Map<string, Promise<void>>();

const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
const JS_EVAL_PROCESS_ARG = "__proto_worker_js_eval_process";

const workerCloseTimeoutMs: number = WORKER_CLOSE_TIMEOUT_MS;
const reapNotes = new Map<string, KernelReapNote>();

function armSessionReap(session: JsSession): void {
	if (session.reapTimer) clearTimeout(session.reapTimer);
	const timer = setTimeout(() => void reapSessionFire(session), DEFAULT_KERNEL_IDLE_REAP_MS);
	timer.unref?.();
	session.reapTimer = timer;
}

function clearSessionReap(session: JsSession): void {
	if (session.reapTimer) clearTimeout(session.reapTimer);
	session.reapTimer = undefined;
}

async function reapSessionFire(session: JsSession): Promise<void> {
	session.reapTimer = undefined;
	if (sessions.get(session.sessionKey) !== session || session.state !== "alive") return;
	// Busy covers anything the worker is still coordinating: backgrounded cells,
	// awaited tool/agent bridges, completion calls. Reset cycles also block reaping.
	if (
		session.pending.size > 0 ||
		startingSessions.has(session.sessionKey) ||
		resettingSessions.has(session.sessionKey)
	) {
		armSessionReap(session);
		return;
	}
	sessions.delete(session.sessionKey);
	await killSession(session, new ToolError("JS eval context released after idle timeout"), { force: false });
	logger.info("JS eval context released after idle timeout", {
		sessionKey: session.sessionKey,
		sessionId: session.sessionId,
		idleMs: DEFAULT_KERNEL_IDLE_REAP_MS,
	});
	reapNotes.set(session.sessionKey, { idleMs: DEFAULT_KERNEL_IDLE_REAP_MS, reapedAt: Date.now() });
}
const useWorkerThreadForTests = false;

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;

	ownerId?: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	reset?: boolean;
	onStatus?: (event: JsStatusEvent) => void;
	completionContext?: EvalCompletionInvocationContext;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<{ value: unknown }> {
	const sessionKey = resolveOwnerScopedSessionKey({
		baseKey: options.sessionKey,
		ownerId: options.ownerId,
		reset: options.reset === true,
		hasSession: key => sessions.has(key) || startingSessions.has(key),
		getOwners: key => sessions.get(key) ?? startingSessions.get(key),
	});
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetVmContext(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const reapNote = reapNotes.get(sessionKey);
	if (reapNote) {
		reapNotes.delete(sessionKey);
		options.onStatus?.({ op: "kernel-idle-reap", idleMs: reapNote.idleMs, reapedAt: reapNote.reapedAt });
	}
	const session = await acquireSession(
		sessionKey,
		{ cwd: options.cwd, sessionId: options.sessionId, localRoots: options.localRoots },
		options.timeoutMs,
		options.ownerId,
	);
	armSessionReap(session);
	try {
		return await runOnce(session, options);
	} finally {
		if (sessions.get(sessionKey) === session && session.state === "alive") armSessionReap(session);
	}
}

async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await killSession(session, new ToolError("JS context reset"), { force: false });
}

export async function disposeAllVmContexts(): Promise<void> {
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.values()];
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.includes(result.value)) all.push(result.value);
	}
	sessions.clear();
	await Promise.all(all.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })));
}

export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	const toKill: JsSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	const startingToKill: StartingJsSession[] = [];
	for (const [sessionKey, starting] of [...startingSessions.entries()]) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToKill.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	for (const session of toKill) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const started = await Promise.allSettled(startingToKill.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toKill.push(session);
	}
	await Promise.all(
		toKill.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	);
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		localRoots?: Record<string, string>;
		completionContext?: EvalCompletionInvocationContext;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const pending: PendingRun = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		resolve,
		reject,
		toolCalls: new Map(),
		completionContext: options.completionContext,
		deferDepth: 0,
		aborted: false,
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");

		pending.aborted = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);

		const drained = pending.deferDepth > 0 ? pending.deferDrained?.promise : undefined;
		if (drained) {
			void drained.then(() => killSessionFor(session, abortError, { force: true }));
			return;
		}
		void killSessionFor(session, abortError, { force: true });
	};

	if (options.runState.signal?.aborted) {
		queueMicrotask(onAbort);
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		session.worker.send({
			type: "run",
			runId,
			code: options.code,
			filename: options.filename,
			snapshot: { cwd: options.cwd, sessionId: options.sessionId, localRoots: options.localRoots },
			completionContext: options.completionContext,
		});
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(
	sessionKey: string,
	snapshot: SessionSnapshot,
	timeoutMs?: number,
	ownerId?: string,
): Promise<JsSession> {
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		attachSessionOwner(existing, snapshot.sessionId, ownerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, snapshot.sessionId, ownerId);
		return await starting.promise;
	}
	let startingSession!: StartingJsSession;

	const startup = (async (): Promise<JsSession> => {
		const worker = spawnJsWorker();
		const session: JsSession = {
			sessionKey,
			sessionId: snapshot.sessionId,
			cwd: snapshot.cwd,
			worker,
			state: "alive",
			pending: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};

		const readyTimeoutMs = Math.max(WORKER_INIT_TIMEOUT_MS, timeoutMs ?? 0);
		while (true) {
			try {
				await initWorker(session, snapshot, readyTimeoutMs);
				break;
			} catch (error) {
				const failed = session.worker;
				await failed.terminate().catch(() => undefined);
				if (failed.mode === "inline") throw error;
				if (failed.mode === "process") {
					logger.warn("JS eval subprocess init failed; retrying with a Bun Worker", {
						error: error instanceof Error ? error.message : String(error),
					});
					session.worker = spawnBunWorker();
				} else {
					logger.warn("JS eval worker init failed; retrying with inline worker (no sync-loop guard)", {
						error: error instanceof Error ? error.message : String(error),
					});
					session.worker = spawnInlineWorker();
				}
				session.state = "alive";
			}
		}
		session.ownerIds = new Set(startingSession.ownerIds);
		session.hasFallbackOwner = startingSession.hasFallbackOwner;

		if (startingSessions.get(sessionKey) === startingSession) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
	};
	attachSessionOwner(startingSession, snapshot.sessionId, ownerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function initWorker(session: JsSession, snapshot: SessionSnapshot, timeoutMs: number): Promise<void> {
	const worker = session.worker;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let resolved = false;
	const unsubscribeMessage = worker.onMessage(msg => {
		if (!resolved && msg.type === "ready") {
			resolved = true;
			resolveReady();
			return;
		}
		if (!resolved && msg.type === "init-failed") {
			resolved = true;
			rejectReady(errorFromPayload(msg.error));
			return;
		}
		handleSessionMessage(session, msg);
	});
	const unsubscribeError = worker.onError(error => {
		if (!resolved) {
			resolved = true;
			rejectReady(error);
			return;
		}

		void killSessionFor(session, error, { force: true });
	});
	try {
		worker.send({ type: "init", snapshot });
		await raceWithTimeout(readyPromise, timeoutMs, "Timed out initializing JS eval worker");
	} catch (error) {
		unsubscribeMessage();
		unsubscribeError();
		throw error;
	}
}

function handleSessionMessage(session: JsSession, msg: WorkerOutbound): void {
	switch (msg.type) {
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output);
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

function trackDeferPhase(pending: PendingRun, event: JsStatusEvent): void {
	if (event.deferExternalAbort !== true) return;
	if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
		pending.deferDepth++;
		pending.deferDrained ??= Promise.withResolvers<void>();
		return;
	}
	if (event.op !== EVAL_TIMEOUT_RESUME_OP || pending.deferDepth === 0) return;
	pending.deferDepth--;
	if (pending.deferDepth > 0) return;
	pending.deferDrained?.resolve();
	pending.deferDrained = undefined;
}

async function handleToolCall(session: JsSession, msg: Extract<WorkerOutbound, { type: "tool-call" }>): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	if (pending.aborted) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run was interrupted" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			signal: ctrl.signal,
			completionContext: pending.completionContext,
			completionInvocationId: msg.completionInvocationId,
			emitStatus: (event: JsStatusEvent) => {
				trackDeferPhase(pending, event);
				pending.runState.onDisplay?.({ type: "status", event });
			},
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);

		const held = pending.heldResult;
		if (held && !pending.settled && !pending.aborted && pending.toolCalls.size === 0) {
			finishPending(pending, held);
		}
	}
}

function finishPending(pending: PendingRun, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	pending.settled = true;
	pending.heldResult = undefined;
	if (msg.ok) {
		pending.resolve({ value: undefined });
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

function settlePending(session: JsSession, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;

	if (pending.aborted) return;

	if (pending.toolCalls.size > 0) {
		pending.heldResult = msg;
		return;
	}
	finishPending(pending, msg);
}

async function killSessionFor(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
	}
	await killSession(session, error, options);
}

async function killSession(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	clearSessionReap(session);
	reapNotes.delete(session.sessionKey);
	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	session.pending.clear();
	if (options.force) {
		await session.worker.terminate().catch(() => undefined);
		return;
	}
	if (await session.worker.close().catch(() => false)) return;
	await session.worker.terminate().catch(() => undefined);
}

function safeSend(session: JsSession, msg: WorkerInbound): void {
	if (session.state !== "alive") return;
	try {
		session.worker.send(msg);
	} catch (err) {
		logger.debug("js worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function errorFromPayload(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: String(error) };
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

function spawnJsWorker(): WorkerHandle {
	if (!useWorkerThreadForTests) {
		try {
			return spawnJsProcess();
		} catch (err) {
			logger.warn("JS eval subprocess spawn failed; falling back to a Bun Worker", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return spawnBunWorker();
}

function spawnBunWorker(): WorkerHandle {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__proto_worker_js_eval"] })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline JS eval worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function spawnJsProcess(): WorkerHandle {
	const spawned = createWorkerSubprocess<WorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(JS_EVAL_PROCESS_ARG),
		env: workerEnvFromParent(),
		exitLabel: "JS eval worker",
		detached: true,
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<WorkerInbound, WorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "js-eval"),
	);
	return {
		mode: "process",
		send: message => base.send(message),
		onMessage: handler => base.onMessage(handler),
		onError: handler => base.onError(handler),
		async close() {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				resolve(value);
			};
			unsubscribe = base.onMessage(message => {
				if (message.type !== "closed") return;
				void base.terminate().finally(() => finish(true));
			});
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			base.send({ type: "close" });
			return await promise;
		},
		terminate: () => base.terminate(),
	};
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg) {
			worker.postMessage(msg);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`JS eval worker message error: ${String(event.data)}`));
			const onClose = (): void => handler(new Error("JS eval worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let sawClosedAck = false;
			let sawWorkerExit = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				worker.removeEventListener("close", onClose);
				resolve(value);
			};
			const finishIfClosed = (): void => {
				if (sawClosedAck && sawWorkerExit) finish(true);
			};
			const onClose = (): void => {
				sawWorkerExit = true;
				finishIfClosed();
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type !== "closed") return;
				sawClosedAck = true;
				finishIfClosed();
			});
			worker.addEventListener("close", onClose);
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			worker.postMessage({ type: "close" } satisfies WorkerInbound);
			return await closed;
		},
		async terminate() {
			worker.terminate();
		},
	};
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown JS eval worker error");
}

function spawnInlineWorker(): WorkerHandle {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg);
			}),
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	const core = new WorkerCore(workerTransport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				hostListeners.clear();
				workerListeners.clear();
				resolve(value);
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type === "closed") finish(true);
			});
			this.send({ type: "close" });
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			return await closed;
		},
		async terminate() {
			hostListeners.clear();
			workerListeners.clear();
			core.dispose();
		},
	};
}
