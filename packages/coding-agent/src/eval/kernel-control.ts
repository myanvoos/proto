import * as path from "node:path";
import { currentExecutionOrigin } from "../jobs/origin";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { resolveEvalUrlRoots } from "./backend";
import { namespaceSessionId, readInterpreterSetting } from "./backend-helpers";
import {
	closeVmKernelSession,
	keepaliveVmKernelSession,
	listVmKernelSessions,
	startVmKernelSession,
} from "./js/context-manager";
import { NODE_REMOTE_TARGET_UNSUPPORTED } from "./js/node-runtime";
import {
	getKernelLaneConfiguration,
	KERNEL_LANGUAGES,
	type KernelLaneConfiguration,
	type KernelLanguage,
	listKernelLaneConfigurations,
	setKernelLaneConfiguration,
	validateKernelKeepalive,
} from "./kernel-environment";
import type { KernelSessionInfo } from "./kernel-session-registry";
import { type KernelTarget, parseKernelTarget } from "./kernel-target";
import {
	closePythonKernelSession,
	keepalivePythonKernelSession,
	listPythonKernelSessions,
	startPythonKernelSession,
} from "./py/executor";
import { pythonEnvironmentIdentity } from "./py/runtime";
import { defaultEvalSessionId } from "./session-id";

export interface KernelControlArgs {
	op: "list" | "start" | "inspect" | "close" | "reset" | "keepalive";
	language?: KernelLanguage;
	lane?: string;
	interpreter?: string;
	cwd?: string;
	target?: KernelTarget;
	ttlMs?: number;
	force?: boolean;
}

export interface KernelSnapshot {
	language: KernelLanguage;
	lane: string;
	generation: string | null;
	interpreter?: string;
	environment: { cwd: string; target: KernelTarget };
	state: KernelSessionInfo["state"];
	startedAt: number;
	lastActivityAt: number;
	keepAliveUntil?: number;
}

export interface KernelControlResult {
	op: KernelControlArgs["op"];
	kernels?: KernelSnapshot[];
	kernel?: KernelSnapshot;
	language?: KernelLanguage;
	lane?: string;
	closed?: boolean;
}

const operations = new Map<string, { op: KernelControlArgs["op"]; token: symbol }>();

export function parseKernelControlArgs(value: unknown): KernelControlArgs {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("kernel arguments must be an object");
	const args = value as Record<string, unknown>;
	const allowed = ["op", "language", "lane", "interpreter", "cwd", "target", "ttlMs", "force"];
	for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unknown kernel field: ${key}`);
	if (typeof args.op !== "string" || !["list", "start", "inspect", "close", "reset", "keepalive"].includes(args.op))
		throw new Error("Unknown kernel operation");
	if (args.language !== undefined && !KERNEL_LANGUAGES.includes(args.language as KernelLanguage))
		throw new Error(`language must be ${KERNEL_LANGUAGES.join(", ")}`);
	if (args.op !== "list" && args.language === undefined) throw new Error("language is required for this operation");
	if (
		args.lane !== undefined &&
		(typeof args.lane !== "string" || args.lane.length < 1 || args.lane.length > 128 || /[\0\r\n]/u.test(args.lane))
	)
		throw new Error("lane must contain 1–128 characters without NUL or newlines");
	for (const key of ["interpreter", "cwd"]) {
		const item = args[key];
		if (item !== undefined && (typeof item !== "string" || !item.trim() || /[\0\r\n]/u.test(item)))
			throw new Error(`${key} must be a nonempty string without NUL or newlines`);
	}
	if (args.force !== undefined && typeof args.force !== "boolean") throw new Error("force must be a boolean");
	if (args.force !== undefined && args.op !== "close")
		throw new Error("force is only valid for close; reset explicitly replaces the kernel");
	if (args.ttlMs !== undefined) {
		if (typeof args.ttlMs !== "number") throw new Error("ttlMs must be a number");
		validateKernelKeepalive(args.ttlMs);
		if (args.op !== "start" && args.op !== "reset" && args.op !== "keepalive")
			throw new Error("ttlMs is only valid for start, reset, or keepalive");
	}
	if (args.op === "keepalive" && args.ttlMs === undefined) throw new Error("keepalive requires ttlMs");
	for (const key of ["cwd", "target"]) {
		if (args[key] !== undefined && args.op !== "start" && args.op !== "reset")
			throw new Error(`${key} is only valid for start or reset`);
	}
	if (args.interpreter !== undefined && args.op === "list")
		throw new Error("interpreter selects one kernel of a lane; list reports every interpreter");
	return {
		...args,
		...(args.target !== undefined ? { target: parseKernelTarget(args.target) } : {}),
	} as unknown as KernelControlArgs;
}

function interpreterIdentity(language: KernelLanguage, interpreter: string): string {
	return language === "python" ? pythonEnvironmentIdentity(interpreter) : interpreter;
}

export function kernelLaneSessionId(session: ToolSession, lane = "main"): string {
	const base = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);
	return lane === "main" ? base : `${base}:lane:${encodeURIComponent(lane)}`;
}

function languageSessionId(session: ToolSession, language: KernelLanguage, lane = "main"): string {
	return namespaceSessionId(kernelLaneSessionId(session, lane), `${language}:`);
}

export function resolveKernelLaneConfiguration(
	session: ToolSession,
	language: KernelLanguage,
	lane = "main",
): KernelLaneConfiguration | undefined {
	const sessionId = languageSessionId(session, language, lane);
	return getKernelLaneConfiguration(session.getEvalKernelOwnerId?.() ?? sessionId, language, sessionId);
}

function scopedSessions(session: ToolSession, language: KernelLanguage): KernelSessionInfo[] {
	const base = languageSessionId(session, language);
	const ownerId = session.getEvalKernelOwnerId?.() ?? undefined;
	const list = language === "python" ? listPythonKernelSessions(ownerId) : listVmKernelSessions(ownerId);
	return list.filter(info => info.sessionId === base || info.sessionId.startsWith(`${base}:lane:`));
}

function snapshot(session: ToolSession, language: KernelLanguage, info: KernelSessionInfo): KernelSnapshot {
	const base = languageSessionId(session, language);
	return {
		language,
		lane: info.sessionId === base ? "main" : decodeURIComponent(info.sessionId.slice(base.length + ":lane:".length)),
		generation: info.generation,
		interpreter: info.interpreter,
		environment: { cwd: info.cwd, target: info.target },
		state: info.state,
		startedAt: info.startedAt,
		lastActivityAt: info.lastActivityAt,
		keepAliveUntil: info.keepAliveUntil,
	};
}

function laneConfiguration(
	session: ToolSession,
	args: KernelControlArgs,
	previous?: KernelSessionInfo,
): KernelLaneConfiguration {
	const language = args.language!;
	const retained = resolveKernelLaneConfiguration(session, language, args.lane);
	const target = args.target ?? retained?.target ?? previous?.target ?? { kind: "local" };
	const remote = target.kind !== "local";
	if (remote && language === "node") throw new Error(NODE_REMOTE_TARGET_UNSUPPORTED);
	const requestedCwd = args.cwd ?? (remote ? target.cwd : undefined) ?? retained?.cwd ?? previous?.cwd ?? session.cwd;
	if (remote && !requestedCwd.startsWith("/")) throw new Error("Remote kernel cwd must be an absolute target path");
	const cwd = remote ? requestedCwd : path.resolve(session.cwd, requestedCwd);
	const interpreter =
		args.interpreter ??
		(remote ? target.interpreter : undefined) ??
		retained?.interpreter ??
		(!retained && !remote ? previous?.interpreter : undefined) ??
		(language === "python" && !remote ? readInterpreterSetting(session, "python.interpreter") : undefined);
	// A runtime-reported executable is an observation, not a replacement for an
	// intentionally unset interpreter or a remote hostCommand launcher.
	return {
		cwd,
		interpreter,
		target: parseKernelTarget(remote ? { ...target, cwd, ...(interpreter ? { interpreter } : {}) } : target),
	};
}

async function startKernel(
	session: ToolSession,
	args: KernelControlArgs,
	configuration: KernelLaneConfiguration,
	signal: AbortSignal,
): Promise<KernelSessionInfo> {
	const language = args.language!;
	const sessionId = languageSessionId(session, language, args.lane);
	const ownerId = session.getEvalKernelOwnerId?.() ?? undefined;
	if (language === "python")
		return await startPythonKernelSession({
			...configuration,
			sessionId,
			kernelOwnerId: ownerId,
			signal,
			reset: args.op === "reset",
			toolSession: session,
			localRoots: resolveEvalUrlRoots(session),
			sessionFile: session.getSessionFile?.() ?? undefined,
			artifactsDir: session.getArtifactsDir?.() ?? undefined,
		});
	const info = await startVmKernelSession({
		...configuration,
		runtime: language,
		sessionKey: sessionId,
		sessionId,
		ownerId,
		signal,
		discoveryCwd: session.cwd,
		reset: args.op === "reset",
		localRoots: resolveEvalUrlRoots(session),
	});
	if (signal.aborted) {
		await closeVmKernelSession(info.sessionKey, true, ownerId);
		signal.throwIfAborted();
	}
	return info;
}

export async function handleKernelControl(
	session: ToolSession,
	value: unknown,
	signal?: AbortSignal,
): Promise<KernelControlResult> {
	const args = parseKernelControlArgs(value);
	signal?.throwIfAborted();
	if (args.op === "list") {
		const languages = args.language ? [args.language] : KERNEL_LANGUAGES;
		const kernels = languages
			.flatMap(language => scopedSessions(session, language).map(info => snapshot(session, language, info)))
			.filter(info => args.lane === undefined || info.lane === args.lane)
			.sort((a, b) => a.language.localeCompare(b.language) || a.lane.localeCompare(b.lane));
		return { op: args.op, kernels };
	}
	const language = args.language!;
	const lane = args.lane ?? "main";
	const origin = currentExecutionOrigin();
	// A cell cannot replace or close the kernel it runs in; a shell command on the same lane can.
	if (
		(args.op === "reset" || args.op === "close") &&
		origin?.kind === "kernel" &&
		origin.lane === lane &&
		origin.language === language
	)
		throw new Error(
			`Cannot ${args.op} the ${language} kernel of lane ${lane} from a cell running in it. Issue it from a shell command or a separate bash lane.`,
		);
	const sessionId = languageSessionId(session, language, lane);
	const ownerId = session.getEvalKernelOwnerId?.() ?? sessionId;
	let candidates = scopedSessions(session, language).filter(info => info.sessionId === sessionId);
	// A lane holds one Python kernel per interpreter; `interpreter` picks one of them.
	if (args.interpreter !== undefined && candidates.length > 1) {
		const wanted = interpreterIdentity(language, path.resolve(session.cwd, args.interpreter));
		const matching = candidates.filter(
			info => info.interpreter !== undefined && interpreterIdentity(language, info.interpreter) === wanted,
		);
		if (matching.length > 0) candidates = matching;
	}
	const current = candidates.find(info => info.sessionKey.endsWith(`\0fork\0${ownerId}`)) ?? candidates[0];
	if (!current && args.op !== "start") throw new Error(`Unknown ${language} kernel lane: ${lane}`);
	if (candidates.length > 1 && !current?.sessionKey.endsWith(`\0fork\0${ownerId}`)) {
		const interpreters = candidates.map(info => info.interpreter ?? "default").join(", ");
		throw new Error(
			`Ambiguous ${language} kernel lane: ${lane} has kernels for ${interpreters}; pass interpreter to choose one`,
		);
	}
	if (args.op === "inspect") return { op: args.op, kernel: snapshot(session, language, current!) };
	if (args.op === "keepalive") {
		const updated =
			language === "python"
				? keepalivePythonKernelSession(current!.sessionKey, args.ttlMs!)
				: keepaliveVmKernelSession(current!.sessionKey, args.ttlMs!);
		return { op: args.op, kernel: snapshot(session, language, updated) };
	}
	const operationKey = JSON.stringify([ownerId, language, sessionId]);
	const inFlight = operations.get(operationKey);
	const interruptsStartup =
		inFlight?.op === "start" &&
		current?.state === "starting" &&
		(args.op === "reset" || (args.op === "close" && args.force === true));
	if (inFlight && !interruptsStartup) throw new Error("Kernel lifecycle operation already in progress");
	const token = Symbol();
	operations.set(operationKey, { op: args.op, token });
	try {
		if (args.op === "close") {
			if (language === "python") await closePythonKernelSession(current!.sessionKey, args.force, ownerId);
			else await closeVmKernelSession(current!.sessionKey, args.force, ownerId);
			setKernelLaneConfiguration(ownerId, language, sessionId, undefined);
			return { op: args.op, language, lane, closed: true };
		}
		const enabled = resolveEvalBackends(session);
		if (!(language === "python" ? enabled.python : enabled.js))
			throw new Error(`${language} kernel backend is disabled`);
		session.assertEvalExecutionAllowed?.();
		const configuration = laneConfiguration(session, args, current);
		if (args.op === "start" && current && (current.state === "idle" || current.state === "busy")) {
			const existing = laneConfiguration(session, { op: "start", language, lane }, current);
			if (JSON.stringify(configuration) !== JSON.stringify(existing))
				throw new Error("Kernel lane already exists with a different environment; use reset to replace it");
			const info =
				args.ttlMs === undefined
					? current
					: language === "python"
						? keepalivePythonKernelSession(current.sessionKey, args.ttlMs)
						: keepaliveVmKernelSession(current.sessionKey, args.ttlMs);
			return { op: args.op, kernel: snapshot(session, language, info) };
		}
		const previous = getKernelLaneConfiguration(ownerId, language, sessionId);
		setKernelLaneConfiguration(ownerId, language, sessionId, configuration);
		const abort = new AbortController();
		const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
		try {
			// Replacing the kernel: a cell it cancels reports the reset, not a force-close.
			if (current && (args.op === "reset" || current.state === "dead")) {
				if (language === "python") await closePythonKernelSession(current.sessionKey, true, ownerId, "reset");
				else await closeVmKernelSession(current.sessionKey, true, ownerId, "reset");
			}
			const startup = startKernel(session, args, configuration, combinedSignal);
			const started = await (session.trackEvalExecution?.(startup, abort) ?? startup);
			const info =
				args.ttlMs === undefined
					? started
					: language === "python"
						? keepalivePythonKernelSession(started.sessionKey, args.ttlMs)
						: keepaliveVmKernelSession(started.sessionKey, args.ttlMs);
			return { op: args.op, kernel: snapshot(session, language, info) };
		} catch (error) {
			if (operations.get(operationKey)?.token === token) {
				setKernelLaneConfiguration(
					ownerId,
					language,
					sessionId,
					abort.signal.aborted || session.isDisposed?.() ? undefined : previous,
				);
			}
			throw error;
		}
	} finally {
		if (operations.get(operationKey)?.token === token) operations.delete(operationKey);
	}
}

function laneOfSessionId(session: ToolSession, language: KernelLanguage, sessionId: string): string | undefined {
	const base = languageSessionId(session, language);
	if (sessionId === base) return "main";
	if (!sessionId.startsWith(`${base}:lane:`)) return undefined;
	return decodeURIComponent(sessionId.slice(base.length + ":lane:".length));
}

/** Every kernel of the caller, across languages, lanes and interpreters. */
export function listOwnedKernels(session: ToolSession): KernelSnapshot[] {
	return KERNEL_LANGUAGES.flatMap(language =>
		scopedSessions(session, language).map(info => snapshot(session, language, info)),
	).sort((a, b) => a.language.localeCompare(b.language) || a.lane.localeCompare(b.lane));
}

/** Lanes whose kernel configuration outlives their kernels (idle reaping), by language. */
export function listConfiguredKernelLanes(session: ToolSession): Map<string, KernelLanguage[]> {
	const lanes = new Map<string, KernelLanguage[]>();
	const ownerId = session.getEvalKernelOwnerId?.() ?? undefined;
	if (ownerId === undefined) return lanes;
	for (const { language, sessionId } of listKernelLaneConfigurations(ownerId)) {
		const lane = laneOfSessionId(session, language, sessionId);
		if (lane === undefined) continue;
		lanes.set(lane, [...(lanes.get(lane) ?? []), language]);
	}
	return lanes;
}

/**
 * Kernel teardown for one lane, reserved synchronously so no kernel lifecycle
 * operation interleaves with the lane control. Construction fails, before any
 * side effect, when another lifecycle operation that cannot be interrupted owns
 * one of the lane's kernels.
 */
export interface LaneKernelRelease {
	/** Kernels the lane holds, as observed when the release was reserved. */
	readonly kernels: KernelSnapshot[];
	/** Some kernel is starting, executing, or closing. */
	readonly busy: boolean;
	/** Force-closes the kernels; `close` also forgets every retained configuration of the lane. */
	run(cause: "reset" | "close"): Promise<void>;
	/** Releases the reservation without touching any kernel. Idempotent. */
	abandon(): void;
}

export function reserveLaneKernelRelease(session: ToolSession, lane: string): LaneKernelRelease {
	const targets = KERNEL_LANGUAGES.map(language => {
		const sessionId = languageSessionId(session, language, lane);
		const ownerId = session.getEvalKernelOwnerId?.() ?? sessionId;
		const infos = scopedSessions(session, language).filter(info => info.sessionId === sessionId);
		return { language, sessionId, ownerId, infos, operationKey: JSON.stringify([ownerId, language, sessionId]) };
	});
	for (const target of targets) {
		const inFlight = operations.get(target.operationKey);
		const interruptible = inFlight?.op === "start" && target.infos.every(info => info.state === "starting");
		if (inFlight && !interruptible) throw new Error("Kernel lifecycle operation already in progress");
	}
	const token = Symbol();
	for (const target of targets) operations.set(target.operationKey, { op: "close", token });
	let settled = false;
	const abandon = () => {
		if (settled) return;
		settled = true;
		for (const target of targets)
			if (operations.get(target.operationKey)?.token === token) operations.delete(target.operationKey);
	};
	const kernels = targets.flatMap(target => target.infos.map(info => snapshot(session, target.language, info)));
	return {
		kernels,
		busy: kernels.some(kernel => kernel.state !== "idle" && kernel.state !== "dead"),
		abandon,
		run: async cause => {
			if (settled) throw new Error("Lane kernel release already settled");
			try {
				const closing = targets.flatMap(target =>
					target.infos.map(info =>
						target.language === "python"
							? closePythonKernelSession(info.sessionKey, true, target.ownerId, cause)
							: closeVmKernelSession(info.sessionKey, true, target.ownerId, cause),
					),
				);
				const results = await Promise.allSettled(closing);
				if (cause === "close")
					for (const target of targets)
						setKernelLaneConfiguration(target.ownerId, target.language, target.sessionId, undefined);
				const failure = results.find(result => result.status === "rejected");
				if (failure) throw failure.reason;
			} finally {
				abandon();
			}
		},
	};
}
