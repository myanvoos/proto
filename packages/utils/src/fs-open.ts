import * as fs from "node:fs";

/** `O_CLOEXEC` (absent from `fs.constants`): Linux and Darwin kernel ABI values; 0 elsewhere rather than an unknown bit. */
const O_CLOEXEC = process.platform === "linux" ? 0o2000000 : process.platform === "darwin" ? 0x0100_0000 : 0;

/**
 * `fs.openSync` with close-on-exec. Bun's `fs.open*` omits `O_CLOEXEC` (libuv adds it on Node), so descriptors held
 * past a spawn — session transcripts, spools — leak into every command the bash tool's shell `fork`/`exec`s. Flags are
 * numeric only: the bit cannot be OR-ed into `"a"`/`"w+"` strings.
 */
export function openCloexecSync(filePath: string, flags: number, mode?: number): number {
	return fs.openSync(filePath, flags | O_CLOEXEC, mode);
}
