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
