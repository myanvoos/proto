import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	attachSessionOwner,
	type CancelledErrorClass,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	resolveOwnerScopedSessionKey,
	type SessionOwners,
} from "./executor-base";
import { DEFAULT_KERNEL_IDLE_REAP_MS, type KernelReapNote } from "./idle-timeout";
import { type KernelAdmission, KernelStartupCleanupError, kernelAdmission } from "./kernel-admission";
import { validateKernelKeepalive } from "./kernel-environment";
import { type KernelTarget, parseKernelTarget } from "./kernel-target";

const MAX_REAP_NOTES = 32;
const MAX_REAP_SHUTDOWN_RETRIES = 3;

/**
 * Why a lifecycle operation cancelled a running cell (e.g. "was force-closed"),
 * keyed by registry session id. Callers that stream a cell's output take it once
 * the cell returns cancelled, so the report names the cause instead of a bare
 * cancellation.
 */
const cellTerminations = new LRUCache<string, string>({ max: 64 });

export function takeKernelCellTermination(sessionId: string): string | undefined {
	const reason = cellTerminations.get(sessionId);
	cellTerminations.delete(sessionId);
	return reason;
}

/** Records the lifecycle cause for kernels managed outside this registry (JavaScript contexts). */
export function recordKernelCellTermination(sessionId: string, reason: string): void {
	cellTerminations.set(sessionId, reason);
}

/** What a kernel close is for: ending the lane, or replacing its kernel as the first step of a reset. */
export type KernelCloseCause = "close" | "reset";

/** How a close reports the running cell it cancels. */
export function kernelCloseTermination(cause: KernelCloseCause, force: boolean): string {
	if (cause === "reset") return "was reset";
	return force ? "was force-closed" : "was closed";
}

export interface KernelSessionRegistryOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	target?: KernelTarget;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	bridge?: unknown;
	bridgeSessionId?: string;
}

interface RegistryKernelShutdownResult {
	confirmed?: boolean;
}

interface RegistryKernel {
	readonly id?: string;
	readonly interpreter?: string;
	isAlive(): boolean;
	shutdown(options?: { timeoutMs: number }): Promise<RegistryKernelShutdownResult>;
	isBusy?(): Promise<boolean | undefined>;
}

export interface KernelSession<TKernel extends RegistryKernel> extends SessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
}

export interface KernelSessionInfo {
	sessionKey: string;
	sessionId: string;
	generation: string | null;
	cwd: string;
	interpreter?: string;
	target: KernelTarget;
	state: "starting" | "idle" | "busy" | "closing" | "dead";
	startedAt: number;
	lastActivityAt: number;
	keepAliveUntil?: number;
}

interface StartingKernelSession<TSession> extends SessionOwners {
	promise: Promise<TSession>;
	info: KernelSessionInfo;
	abort: AbortController;
}

export interface KernelSessionRegistryContext<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TSession extends KernelSession<TKernel>,
> {
	sessions: Map<string, TSession>;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	replaceSessionKernel: (session: TSession, cwd: string, options: TOptions) => Promise<TKernel>;
}

interface KernelSessionRegistryDescriptor<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TResult,
	TSession extends KernelSession<TKernel>,
> {
	/** Release a quiescent kernel after this much inactivity; 0 disables. Defaults to DEFAULT_KERNEL_IDLE_REAP_MS. */
	idleReapMs?: number;
	admission?: KernelAdmission;
	/** Busy probe for the reap check. Undefined/true/unknown = not idle, keep the kernel. */
	kernelBusy?: (kernel: TKernel) => Promise<boolean | undefined>;
	/** Called on the next execute for a session key that was idle-reaped, so callers can surface the state wipe. */
	notifySessionReaped?: (options: TOptions, note: KernelReapNote) => void;
	languageLabel: string;
	cancelledErrorClass: CancelledErrorClass;
	buildSessionKey: (sessionId: string, cwd: string, interpreter: string | undefined, options: TOptions) => string;
	createSession: (session: KernelSession<TKernel>) => TSession;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	executeWithKernel: (kernel: TKernel, code: string, options: TOptions) => Promise<TResult>;
	waitForStartup?: (promise: Promise<TSession>, options: TOptions) => Promise<TSession>;
	replaceSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	acquireLiveSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	invalidateSession?: (session: TSession) => void;
	shutdownSession?: (session: TSession, resetting: boolean) => Promise<RegistryKernelShutdownResult>;
	clearResetsOnDisposeAll?: boolean;
	logBeforeReplacement?: boolean;
	isCancellation?: (error: unknown) => boolean;
	isTimedOutCancellation?: (error: unknown, signal?: AbortSignal) => boolean;
	validateKernel?: (session: TSession, kernel: TKernel) => boolean;
}

export interface KernelSessionRegistry<TOptions extends KernelSessionRegistryOptions, TResult> {
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string): Promise<void>;
	executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult>;
	startSession(cwd: string, options: TOptions): Promise<KernelSessionInfo>;
	listSessions(ownerId?: string): KernelSessionInfo[];
	closeSession(
		sessionKey: string,
		options?: { force?: boolean; ownerId?: string; cause?: KernelCloseCause },
	): Promise<void>;
	keepaliveSession(sessionKey: string, ttlMs: number): KernelSessionInfo;
}

export function normalizeKernelSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

export function requireRemainingKernelTimeoutMs(
	deadlineMs: number | undefined,
	cancelledErrorClass: CancelledErrorClass,
): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	return remainingMs;
}

export function formatSessionTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

export function formatSessionKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

export { DEFAULT_KERNEL_IDLE_REAP_MS, type KernelReapNote } from "./idle-timeout";

export function createKernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TResult,
	TSession extends KernelSession<TKernel>,
>(
	descriptor: KernelSessionRegistryDescriptor<TKernel, TOptions, TResult, TSession>,
): KernelSessionRegistry<TOptions, TResult> {
	const sessions = new Map<string, TSession>();
	const admission = descriptor.admission ?? kernelAdmission;
	const reservations = new WeakMap<TSession, () => void>();
	const failedStartups = new Set<{ owners: SessionOwners; error: KernelStartupCleanupError; release(): void }>();
	const startingSessions = new Map<string, StartingKernelSession<TSession>>();
	const resettingSessions = new Map<string, Promise<void>>();
	const idleReapMs = descriptor.idleReapMs ?? DEFAULT_KERNEL_IDLE_REAP_MS;
	const reapTimers = new Map<string, NodeJS.Timeout>();
	const reapShutdownRetries = new Map<string, number>();
	const executingDepth = new Map<string, number>();
	const reapedNotes = new LRUCache<string, KernelReapNote>({ max: MAX_REAP_NOTES });
	const metadata = new WeakMap<TSession, KernelSessionInfo>();
	const generations = new WeakMap<TKernel, string>();

	function sessionInfo(session: TSession): KernelSessionInfo {
		const info = metadata.get(session)!;
		let generation = session.kernel.id ?? generations.get(session.kernel);
		if (!generation) {
			generation = crypto.randomUUID();
			generations.set(session.kernel, generation);
		}
		return {
			...info,
			generation,
			interpreter: session.kernel.interpreter ?? info.interpreter,
			state: resettingSessions.has(session.sessionKey)
				? "closing"
				: !session.kernel.isAlive()
					? "dead"
					: (executingDepth.get(session.sessionKey) ?? 0) > 0
						? "busy"
						: "idle",
		};
	}

	function listSessions(ownerId?: string): KernelSessionInfo[] {
		const result: KernelSessionInfo[] = [];
		for (const session of sessions.values()) {
			if (ownerId === undefined || session.ownerIds.has(ownerId)) result.push(sessionInfo(session));
		}
		for (const [key, starting] of startingSessions) {
			if (!sessions.has(key) && (ownerId === undefined || starting.ownerIds.has(ownerId))) {
				result.push({ ...starting.info });
			}
		}
		return result;
	}

	function keepaliveSession(sessionKey: string, ttlMs: number): KernelSessionInfo {
		validateKernelKeepalive(ttlMs);
		const session = sessions.get(sessionKey);
		if (!session) throw new Error(`Unknown ${descriptor.languageLabel} kernel lane`);
		if (resettingSessions.has(sessionKey)) throw new Error("Kernel lifecycle operation already in progress");
		if (!session.kernel.isAlive()) throw new Error("Kernel is not running");
		const info = metadata.get(session)!;
		info.keepAliveUntil = Math.max(info.keepAliveUntil ?? 0, Date.now() + ttlMs);
		armReap(sessionKey, Math.max(0, info.lastActivityAt + idleReapMs - Date.now()));
		return sessionInfo(session);
	}

	function armReap(sessionKey: string, delayMs = idleReapMs): void {
		const existing = reapTimers.get(sessionKey);
		if (existing) clearTimeout(existing);
		if (idleReapMs <= 0) return;
		if (!sessions.has(sessionKey)) return;
		const session = sessions.get(sessionKey)!;
		const leaseRemaining = (metadata.get(session)?.keepAliveUntil ?? 0) - Date.now();
		const timer = setTimeout(() => void reapFire(sessionKey), Math.max(delayMs, leaseRemaining));
		timer.unref?.();
		reapTimers.set(sessionKey, timer);
	}

	function clearReapState(sessionKey: string): void {
		const timer = reapTimers.get(sessionKey);
		if (timer) clearTimeout(timer);
		reapTimers.delete(sessionKey);
		executingDepth.delete(sessionKey);
		reapShutdownRetries.delete(sessionKey);
	}

	async function shutdownThenForget(
		sessionKey: string,
		session: TSession,
	): Promise<{ confirmed: boolean; error?: unknown }> {
		if (sessions.get(sessionKey) !== session) return { confirmed: false };
		if (!reapShutdownRetries.has(sessionKey)) descriptor.invalidateSession?.(session);
		try {
			const result = await shutdownSession(session, false);
			if (result?.confirmed === false || sessions.get(sessionKey) !== session) return { confirmed: false };
			sessions.delete(sessionKey);
			reapShutdownRetries.delete(sessionKey);
			return { confirmed: true };
		} catch (error) {
			return { confirmed: false, error };
		}
	}

	async function reapFire(sessionKey: string): Promise<void> {
		reapTimers.delete(sessionKey);
		const session = sessions.get(sessionKey);
		if (!session) return;
		if ((metadata.get(session)?.keepAliveUntil ?? 0) > Date.now()) {
			armReap(sessionKey, 0);
			return;
		}
		// Never reap around lifecycle transitions or while a cell is executing.
		if (startingSessions.has(sessionKey) || resettingSessions.has(sessionKey)) {
			armReap(sessionKey);
			return;
		}
		if ((executingDepth.get(sessionKey) ?? 0) > 0) {
			armReap(sessionKey);
			return;
		}
		// Busy covers anything the kernel is still waiting on: backgrounded cells,
		// monitors, awaited subagents/tool bridges. Unknown counts as busy.
		const busy = session.kernel.isAlive()
			? descriptor.kernelBusy
				? await descriptor.kernelBusy(session.kernel)
				: true
			: false;
		if (busy !== false) {
			armReap(sessionKey);
			return;
		}
		// The busy probe awaited: re-check the guards before tearing down.
		if (
			sessions.get(sessionKey) !== session ||
			startingSessions.has(sessionKey) ||
			resettingSessions.has(sessionKey) ||
			(executingDepth.get(sessionKey) ?? 0) > 0
		) {
			armReap(sessionKey);
			return;
		}
		const shutdown = await shutdownThenForget(sessionKey, session);
		if (!shutdown.confirmed) {
			const retries = (reapShutdownRetries.get(sessionKey) ?? 0) + 1;
			reapShutdownRetries.set(sessionKey, retries);
			logger.warn(`${descriptor.languageLabel} kernel idle-reap shutdown not confirmed`, {
				sessionKey,
				sessionId: session.sessionId,
				cwd: session.cwd,
				reason: shutdown.error ?? "not confirmed",
			});
			if (sessions.get(sessionKey) === session && retries <= MAX_REAP_SHUTDOWN_RETRIES) {
				armReap(sessionKey, Math.min(idleReapMs * 2 ** retries, idleReapMs * 8));
			}
			return;
		}
		logger.info(`${descriptor.languageLabel} kernel released after idle timeout`, {
			sessionKey,
			sessionId: session.sessionId,
			idleReapMs,
		});
		reapedNotes.set(sessionKey, { idleMs: idleReapMs, reapedAt: Date.now() });
	}

	const context: KernelSessionRegistryContext<TKernel, TOptions, TSession> = {
		sessions,
		startKernel: descriptor.startKernel,
		replaceSessionKernel,
	};

	function waitForStartup(promise: Promise<TSession>, options: TOptions): Promise<TSession> {
		return descriptor.waitForStartup?.(promise, options) ?? promise;
	}

	function isCurrent(session: TSession, kernel?: TKernel): boolean {
		return (
			sessions.get(session.sessionKey) === session &&
			(kernel === undefined || descriptor.validateKernel?.(session, kernel) !== false)
		);
	}

	async function acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<TSession> {
		const existing = sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}
		const starting = startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			return await waitForStartup(starting.promise, options);
		}
		const release = admission.reserve(options.kernelOwnerId ?? sessionId);
		const abort = new AbortController();
		const startupOptions = {
			...options,
			signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
		};
		const now = Date.now();
		const info: KernelSessionInfo = {
			sessionKey,
			sessionId,
			cwd,
			interpreter: options.interpreter,
			target: parseKernelTarget(options.target),
			generation: null,
			state: "starting",
			startedAt: now,
			lastActivityAt: now,
		};
		let startingSession!: StartingKernelSession<TSession>;
		const startup = (async () => {
			let kernel: TKernel;
			try {
				kernel = await descriptor.startKernel(cwd, startupOptions);
			} catch (error) {
				if (error instanceof KernelStartupCleanupError) {
					failedStartups.add({ owners: startingSession, error, release });
				} else release();
				throw error;
			}
			const session = descriptor.createSession({
				sessionKey,
				sessionId,
				cwd,
				kernel,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			});
			metadata.set(session, info);
			reservations.set(session, release);
			if (startingSessions.get(sessionKey) === startingSession) {
				sessions.set(sessionKey, session);
			}
			return session;
		})();
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
			info,
			abort,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		startingSessions.set(sessionKey, startingSession);
		const forgetStarting = (): void => {
			if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
		};
		void startup.then(forgetStarting, forgetStarting);
		return await waitForStartup(startup, options);
	}

	async function replaceSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.replaceSessionKernel) {
			return await descriptor.replaceSessionKernel(session, cwd, options, context);
		}
		if (descriptor.logBeforeReplacement) {
			logger.warn(`${descriptor.languageLabel} subprocess died or is unresponsive; spawning fresh process`, {
				sessionKey: session.sessionKey,
			});
		}
		const old = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		const shutdown = await old.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined);
		if (shutdown.confirmed === false)
			throw new Error(`${descriptor.languageLabel} kernel replacement shutdown not confirmed`);
		if (sessions.get(session.sessionKey) !== session) {
			throw new descriptor.cancelledErrorClass(false);
		}
		requireRemainingKernelTimeoutMs(options.deadlineMs, descriptor.cancelledErrorClass);
		const next = await descriptor.startKernel(cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			await next.shutdown().catch(() => undefined);
			throw new descriptor.cancelledErrorClass(false);
		}
		session.kernel = next;
		return next;
	}

	async function acquireLiveSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.acquireLiveSessionKernel) {
			return await descriptor.acquireLiveSessionKernel(session, cwd, options, context);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		if (!session.kernel.isAlive()) await replaceSessionKernel(session, cwd, options);
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		return session.kernel;
	}

	async function shutdownSession(session: TSession, resetting: boolean): Promise<RegistryKernelShutdownResult> {
		const result = await (descriptor.shutdownSession?.(session, resetting) ?? session.kernel.shutdown());
		if (result.confirmed !== false) {
			reservations.get(session)?.();
			reservations.delete(session);
		}
		return result;
	}

	async function resetSession(sessionKey: string): Promise<void> {
		const existing =
			sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!existing) return;
		descriptor.invalidateSession?.(existing);
		const result = await shutdownSession(existing, true);
		if (result.confirmed === false)
			throw new Error(`${descriptor.languageLabel} kernel reset shutdown not confirmed`);
		if (sessions.get(sessionKey) === existing) sessions.delete(sessionKey);
		clearReapState(sessionKey);
		reapedNotes.delete(sessionKey);
	}

	async function closeSession(
		sessionKey: string,
		options: { force?: boolean; ownerId?: string; cause?: KernelCloseCause } = {},
	): Promise<void> {
		if (resettingSessions.has(sessionKey)) throw new Error("Kernel lifecycle operation already in progress");
		const starting = startingSessions.get(sessionKey);
		const session = sessions.get(sessionKey);
		if (!session && !starting) throw new Error(`Unknown ${descriptor.languageLabel} kernel lane`);
		if (!options.force && (starting || (executingDepth.get(sessionKey) ?? 0) > 0)) {
			throw new Error("Kernel is busy; close requires force:true");
		}
		const operation = (async () => {
			if (session && !options.force && session.kernel.isAlive()) {
				const busy = await (descriptor.kernelBusy?.(session.kernel) ?? session.kernel.isBusy?.());
				if (busy !== false) throw new Error("Kernel is busy or its state is unknown; close requires force:true");
			}
			const owned = session ?? starting!;
			if (options.ownerId !== undefined && !owned.ownerIds.has(options.ownerId))
				throw new Error("Kernel is not owned by this session");
			if (options.ownerId !== undefined && owned.ownerIds.size > 1) {
				owned.ownerIds.delete(options.ownerId);
				starting?.ownerIds.delete(options.ownerId);
				return;
			}
			if (starting) starting.abort.abort(new Error("Kernel closed during startup"));
			if (session && (executingDepth.get(sessionKey) ?? 0) > 0)
				cellTerminations.set(
					session.sessionId,
					kernelCloseTermination(options.cause ?? "close", options.force === true),
				);
			await resetSession(sessionKey);
		})();
		resettingSessions.set(sessionKey, operation);
		try {
			await operation;
		} finally {
			if (resettingSessions.get(sessionKey) === operation) resettingSessions.delete(sessionKey);
		}
	}

	async function disposeFailedStartups(ownerId?: string): Promise<void> {
		await Promise.all(
			[...failedStartups].map(async entry => {
				if (ownerId !== undefined && !entry.owners.ownerIds.has(ownerId)) return;
				try {
					const result = await entry.error.shutdown();
					if (!result.confirmed) throw new Error("shutdown not confirmed");
					entry.release();
					failedStartups.delete(entry);
				} catch (error) {
					logger.warn(`${descriptor.languageLabel} failed startup shutdown not confirmed`, { error });
				}
			}),
		);
	}

	async function disposeAll(): Promise<void> {
		const pending = [...startingSessions.values()].map(starting => starting.promise);
		startingSessions.clear();
		if (descriptor.clearResetsOnDisposeAll) resettingSessions.clear();
		const started = await Promise.allSettled(pending);
		const all = [...sessions.entries()];
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (!all.some(([, session]) => session === result.value)) {
				all.push([result.value.sessionKey, result.value]);
			}
		}
		for (const [id, session] of all) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(id) === session) sessions.delete(id);
			clearReapState(id);
			reapedNotes.delete(id);
		}
		const results = await Promise.allSettled(all.map(([, session]) => shutdownSession(session, false)));
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(id)) sessions.set(id, session);
		}
		await disposeFailedStartups();
	}

	async function disposeByOwner(ownerId: string): Promise<void> {
		const toShutdown: TSession[] = [];
		const startingToShutdown: StartingKernelSession<TSession>[] = [];
		for (const session of [...sessions.values()]) {
			if (!session.ownerIds.has(ownerId)) continue;
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of [...startingSessions.entries()]) {
			if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			clearReapState(session.sessionKey);
			reapedNotes.delete(session.sessionKey);
		}
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			toShutdown.push(session);
		}
		const results = await Promise.allSettled(toShutdown.map(session => shutdownSession(session, false)));
		for (let i = 0; i < toShutdown.length; i += 1) {
			const session = toShutdown[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
		}
		await disposeFailedStartups(ownerId);
	}

	async function prepareSession(cwd: string, options: TOptions): Promise<TSession> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		if (failedStartups.size > 0) await disposeFailedStartups(options.kernelOwnerId ?? sessionId);
		const sessionKey = resolveOwnerScopedSessionKey({
			baseKey: descriptor.buildSessionKey(sessionId, cwd, options.interpreter, options),
			ownerId: options.kernelOwnerId,
			reset: options.reset === true,
			hasSession: key => sessions.has(key) || startingSessions.has(key),
			getOwners: key => sessions.get(key) ?? startingSessions.get(key),
		});
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
		if (options.reset) {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const running = sessions.get(sessionKey);
				if (running && (executingDepth.get(sessionKey) ?? 0) > 0)
					cellTerminations.set(running.sessionId, "was reset");
				const resetPromise = resetSession(sessionKey);
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
		const reapNote = reapedNotes.get(sessionKey);
		if (reapNote) {
			reapedNotes.delete(sessionKey);
			descriptor.notifySessionReaped?.(options, reapNote);
		}
		const session = await acquireSession(sessionKey, sessionId, cwd, options);
		armReap(sessionKey);
		if (options.signal?.aborted) {
			const timedOut =
				descriptor.isTimedOutCancellation?.(options.signal.reason, options.signal) ??
				isTimedOutCancellation(options.signal.reason, descriptor.cancelledErrorClass, options.signal);
			throw new descriptor.cancelledErrorClass(timedOut);
		}
		const kernel = await acquireLiveSessionKernel(session, cwd, options);
		if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
		metadata.get(session)!.lastActivityAt = Date.now();
		return session;
	}

	async function startSession(cwd: string, options: TOptions): Promise<KernelSessionInfo> {
		return sessionInfo(await prepareSession(cwd, options));
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult> {
		const session = await prepareSession(cwd, options);
		const { sessionKey, kernel } = session;
		if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
		const runOptions = { ...options, cwd };
		executingDepth.set(sessionKey, (executingDepth.get(sessionKey) ?? 0) + 1);
		try {
			return await descriptor.executeWithKernel(kernel, code, runOptions);
		} catch (err) {
			if (
				descriptor.isCancellation?.(err) ||
				isCancellationError(err, descriptor.cancelledErrorClass) ||
				options.signal?.aborted
			)
				throw err;
			if (kernel.isAlive()) throw err;
			throw new Error(
				`${descriptor.languageLabel} kernel died during execution; completion is uncertain and the cell was not replayed. The next call will start a fresh kernel.`,
				{ cause: err },
			);
		} finally {
			if (sessions.get(sessionKey) === session) {
				const depth = (executingDepth.get(sessionKey) ?? 1) - 1;
				if (depth <= 0) executingDepth.delete(sessionKey);
				else executingDepth.set(sessionKey, depth);
				metadata.get(session)!.lastActivityAt = Date.now();
				armReap(sessionKey);
			}
		}
	}

	return { disposeAll, disposeByOwner, executeOnSession, startSession, listSessions, closeSession, keepaliveSession };
}
