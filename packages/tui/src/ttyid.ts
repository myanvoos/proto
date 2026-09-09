import { CString, dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";

export function isInsideHerdr(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.HERDR_ENV === "1") return true;
	return Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
}

export function isInsideTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.TMUX || env.STY || env.ZELLIJ || isInsideHerdr(env)) return true;
	if (env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}

export function getTtyPath(): string | null {
	if (os.platform() === "linux") {
		try {
			const ttyPath = fs.readlinkSync("/proc/self/fd/0");
			if (ttyPath.startsWith("/dev/")) {
				return ttyPath;
			}
		} catch {
			return null;
		}
	} else {
		try {
			const libName = os.platform() === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
			const lib = dlopen(libName, {
				ttyname: { args: [FFIType.i32], returns: FFIType.ptr },
			});
			try {
				const result = lib.symbols.ttyname(0);
				return result ? new CString(result).toString() : null;
			} finally {
				lib.close();
			}
		} catch {
			return null;
		}
	}
	return null;
}

export function getTerminalId(): string | null {
	if (process.stdin.isTTY) {
		try {
			const ttyPath = getTtyPath();
			if (ttyPath?.startsWith("/dev/")) {
				return ttyPath.slice(5).replace(/\//g, "-");
			}
		} catch {}
	}

	const zellijPane = process.env.ZELLIJ_PANE_ID;
	if (zellijPane) {
		const zellijSession = process.env.ZELLIJ_SESSION_NAME?.replace(/[\\/]/g, "-");
		return zellijSession ? `zellij-${zellijSession}-${zellijPane}` : `zellij-${zellijPane}`;
	}

	const tmuxPane = process.env.TMUX_PANE;
	if (tmuxPane) return `tmux-${tmuxPane}`;

	const cmuxSurface = process.env.CMUX_SURFACE_ID;
	if (cmuxSurface) return `cmux-${cmuxSurface}`;

	const kittyId = process.env.KITTY_WINDOW_ID;
	if (kittyId) return `kitty-${kittyId}`;

	const weztermPane = process.env.WEZTERM_PANE;
	if (weztermPane) return `wezterm-${weztermPane}`;

	const terminalSessionId = process.env.TERM_SESSION_ID;
	if (terminalSessionId) return `apple-${terminalSessionId}`;

	return null;
}
