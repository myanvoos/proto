import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { theme } from "../modes/theme/theme";
import { expandPath, normalizeLocalScheme } from "../tools/path-utils";
import type { HookUIContext } from "./hooks/types";

export function resolvePath(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expanded);
	if (expandedAndNormalized.startsWith("local://")) {
		throw new Error(
			`Path "${filePath}" uses internal scheme "local://" and must be resolved through the proper protocol handler, not as a filesystem path.`,
		);
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

export function createNoOpUIContext(): HookUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}

export class ExtensionExitError extends Error {
	readonly code: number | string | undefined;
	constructor(
		code: number | string | undefined,
		readonly alias = "process.exit",
	) {
		super(
			`Module called ${alias}(${code === undefined ? "" : String(code)}) during guarded extension/hook loading; ` +
				`PROTO extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
		this.code = code;
	}
}

type ExitAliasName = "process.exit" | "process.reallyExit";

const HOST_GUARD_STDIN_EVENTS = ["data", "readable", "end", "close", "error"] as const;
type StdinGuardEvent = (typeof HOST_GUARD_STDIN_EVENTS)[number];
type StdinGuardListener = (...args: unknown[]) => void;

let hostGuardDepth = 0;
let hostGuardOriginalProcessExit: typeof process.exit | null = null;
let hostGuardOriginalReallyExit: typeof process.reallyExit | null = null;
let hostGuardStdinListeners: Record<StdinGuardEvent, StdinGuardListener[]> | null = null;
let hostGuardStdinWasPaused = false;
let hostGuardStdinWasRaw = false;

function guardedExit(alias: ExitAliasName): (code?: number | string) => never {
	return (code?: number | string): never => {
		throw new ExtensionExitError(code, alias);
	};
}

export async function withHostGuard<T>(fn: () => Promise<T>): Promise<T> {
	if (hostGuardDepth === 0) {
		hostGuardOriginalProcessExit = process.exit;
		const processExitGuard = guardedExit("process.exit") as typeof process.exit;
		Reflect.set(processExitGuard, postmortem.NATIVE_PROCESS_EXIT, hostGuardOriginalProcessExit);
		process.exit = processExitGuard;

		if (typeof process.reallyExit === "function") {
			hostGuardOriginalReallyExit = process.reallyExit;
			const reallyExitGuard = guardedExit("process.reallyExit") as typeof process.reallyExit;
			Reflect.set(reallyExitGuard, postmortem.NATIVE_PROCESS_EXIT, hostGuardOriginalReallyExit);
			process.reallyExit = reallyExitGuard;
		}

		const stdin = process.stdin;
		hostGuardStdinWasPaused = stdin.isPaused();
		hostGuardStdinWasRaw = stdin.isRaw ?? false;
		const snapshot = {} as Record<StdinGuardEvent, StdinGuardListener[]>;
		for (const event of HOST_GUARD_STDIN_EVENTS) {
			snapshot[event] = stdin.rawListeners(event) as StdinGuardListener[];
		}
		hostGuardStdinListeners = snapshot;
	}
	hostGuardDepth++;
	try {
		return await fn();
	} finally {
		hostGuardDepth--;
		if (hostGuardDepth === 0) {
			if (hostGuardOriginalProcessExit) {
				process.exit = hostGuardOriginalProcessExit;
				hostGuardOriginalProcessExit = null;
			}
			if (hostGuardOriginalReallyExit) {
				process.reallyExit = hostGuardOriginalReallyExit;
				hostGuardOriginalReallyExit = null;
			}
			if (hostGuardStdinListeners) {
				const stdin = process.stdin;
				for (const event of HOST_GUARD_STDIN_EVENTS) {
					const before = hostGuardStdinListeners[event];

					const current = stdin.rawListeners(event) as StdinGuardListener[];
					const differs =
						current.length !== before.length || current.some((listener, index) => listener !== before[index]);
					if (!differs) continue;
					stdin.removeAllListeners(event);
					for (const listener of before) {
						stdin.on(event, listener);
					}
				}
				if (
					stdin.isTTY &&
					typeof stdin.setRawMode === "function" &&
					(stdin.isRaw ?? false) !== hostGuardStdinWasRaw
				) {
					stdin.setRawMode(hostGuardStdinWasRaw);
				}
				if (hostGuardStdinWasPaused && !stdin.isPaused()) {
					stdin.pause();
				} else if (!hostGuardStdinWasPaused && stdin.isPaused()) {
					stdin.resume();
				}
				hostGuardStdinListeners = null;
			}
		}
	}
}
