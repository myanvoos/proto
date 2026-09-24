import { type ShellEmbeddedCode, scanShellEmbeddedCode } from "@oh-my-pi/pi-natives";

/**
 * Program text a bash command hands to an interpreter (`python -c …`,
 * `.venv/bin/python - <<EOF`, `node -e …`) or writes to a source file through
 * a `cat`/`tee` heredoc. The native scan reads the command with the embedded
 * shell's own tokenizer, so quoting, heredocs and redirections resolve exactly
 * as they execute; partial (streaming) commands are closed before scanning.
 */

export interface BashKernelCell {
	language: "python" | "js";
	code: string;
}

/** An interpreter program plus the offsets of its raw region (heredoc body or code word) in the command. */
export interface BashCodeCell extends BashKernelCell {
	start: number;
	end: number;
	/** Executes as a persistent kernel cell rather than a real interpreter process. */
	kernel: boolean;
}

export interface BashFileWriteSpan {
	/** Destination path after shell quote removal, with `/` separators. */
	path: string;
	code: string;
	start: number;
	end: number;
}

// Rendering asks several questions of the same command per frame (cell,
// mixed-ness, regions, writes); keep the last few scans instead of re-parsing.
const SCAN_CACHE_LIMIT = 8;
const scanCache = new Map<string, ShellEmbeddedCode>();

function scan(command: string): ShellEmbeddedCode {
	const cached = scanCache.get(command);
	if (cached) return cached;
	const result = scanShellEmbeddedCode(command);
	if (scanCache.size >= SCAN_CACHE_LIMIT) {
		const oldest = scanCache.keys().next().value;
		if (oldest !== undefined) scanCache.delete(oldest);
	}
	scanCache.set(command, result);
	return result;
}

/**
 * The first interpreter call in the command that runs as a kernel cell. The
 * renderer keys kernel status/diff/JSON affordances off it; it must not be used
 * to execute the shell.
 */
export function detectBashKernelCell(command: string): BashKernelCell | undefined {
	const cell = scan(command).cells.find(candidate => candidate.kernel);
	return cell ? { language: cell.language, code: cell.code } : undefined;
}

/** Whether the command's kernel cell has shell source around the interpreter call. */
export function isBashKernelCellMixed(command: string): boolean {
	return scan(command).cells.find(cell => cell.kernel)?.mixed === true;
}

/** Every inline interpreter program in the command, kernel-routed or not, in source order. */
export function findBashCodeCells(command: string): BashCodeCell[] {
	return scan(command).cells.map(cell => ({
		language: cell.language,
		code: cell.code,
		start: cell.start,
		end: cell.end,
		kernel: cell.kernel,
	}));
}

/** Source bodies written by `cat > file <<EOF` / `tee file <<EOF` forms, in source order. */
export function findBashFileWrites(command: string): BashFileWriteSpan[] {
	return scan(command).writes.map(write => ({
		path: write.path.replaceAll("\\", "/"),
		code: write.code,
		start: write.start,
		end: write.end,
	}));
}
