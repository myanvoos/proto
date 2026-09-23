import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

export function isInsideTmux(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.TMUX);
}

const TMUX_PASSTHROUGH_PREFIX = "\x1bPtmux;";

export function wrapTmuxPassthrough(payload: string): string {
	return `${TMUX_PASSTHROUGH_PREFIX}${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Decode the first tmux passthrough envelope in `line`, un-doubling the escaped
 * ESC bytes and preserving any trailing content (e.g. a cursor-restore suffix).
 * Returns null when no envelope is present or the envelope is malformed.
 */
export function unwrapTmuxPassthrough(line: string): string | null {
	const start = line.indexOf(TMUX_PASSTHROUGH_PREFIX);
	if (start === -1) return null;
	let out = line.slice(0, start);
	let i = start + TMUX_PASSTHROUGH_PREFIX.length;
	while (i < line.length) {
		const code = line.charCodeAt(i);
		if (code !== 0x1b) {
			out += line[i];
			i++;
			continue;
		}
		const next = line.charCodeAt(i + 1);
		if (next === 0x1b) {
			out += "\x1b";
			i += 2;
			continue;
		}
		if (next === 0x5c) return out + line.slice(i + 2);
		return null;
	}
	return null;
}

export function wrapTmuxPassthroughIfNeeded(payload: string, env: NodeJS.ProcessEnv = Bun.env): string {
	return isInsideTmux(env) ? wrapTmuxPassthrough(payload) : payload;
}

const CLIENT_TERMTYPE_NAME = /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/u;
const CLIENT_TERMTYPE_TIMEOUT_MS = 500;
let cachedClientTerminalName: string | null | undefined;

function queryTmuxClientTerminalName(env: NodeJS.ProcessEnv): string | null {
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return null;
	try {
		const result = Bun.spawnSync([tmux, "display-message", "-p", "#{client_termtype}"], {
			env,
			stdout: "pipe",
			stderr: "ignore",
			timeout: CLIENT_TERMTYPE_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (result.exitCode !== 0) return null;
		return CLIENT_TERMTYPE_NAME.exec(result.stdout.toString().trim())?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the terminal emulator name recorded for this tmux client.
 *
 * tmux (>= 3.2) overwrites the pane's `TERM_PROGRAM` with its own, but keeps
 * the attached client's terminal-type reply in `#{client_termtype}`. The local
 * IPC query runs once per process and degrades to `null` when unavailable.
 */
export function resolveTmuxClientTerminalName(env: NodeJS.ProcessEnv = Bun.env): string | null {
	if (!isInsideTmux(env) || isBunTestRuntime()) return null;
	if (cachedClientTerminalName === undefined) cachedClientTerminalName = queryTmuxClientTerminalName(env);
	return cachedClientTerminalName;
}
