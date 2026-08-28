import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";

const DEFAULT_DIRENV_TIMEOUT_MS = 30_000;

export async function findEnvrc(startDir: string): Promise<string | null> {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, ".envrc");
		try {
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

interface DirenvExportDiff {
	set: Record<string, string>;

	unset: string[];
}

export function parseDirenvExport(jsonText: string): DirenvExportDiff {
	const trimmed = jsonText.trim();
	if (trimmed.length === 0) return { set: {}, unset: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { set: {}, unset: [] };
	}
	const set: Record<string, string> = {};
	const unset: string[] = [];
	if (parsed && typeof parsed === "object") {
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === null) unset.push(key);
			else if (typeof value === "string") set[key] = value;
		}
	}
	return { set, unset };
}

let direnvLookup: { bin: string | null } | undefined;
function direnvBinary(): string | null {
	if (!direnvLookup) direnvLookup = { bin: $which("direnv") };
	return direnvLookup.bin;
}

function cleanSpawnEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !key.startsWith("DIRENV_")) out[key] = value;
	}
	return out;
}

async function runDirenv(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const abortSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
	const proc = Bun.spawn([bin, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		signal: abortSignal,
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

export async function loadDirenvEnv(
	cwd: string,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DirenvExportDiff | null> {
	const envrcPath = await findEnvrc(cwd);
	if (!envrcPath) return null;
	const bin = direnvBinary();
	if (!bin) return null;

	const dir = path.dirname(envrcPath);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_DIRENV_TIMEOUT_MS;
	const env = cleanSpawnEnv();
	try {
		const { exitCode, stdout, stderr } = await runDirenv(bin, ["export", "json"], dir, timeoutMs, env, opts?.signal);
		if (exitCode !== 0) {
			if (stderr.includes("is blocked")) {
				logger.debug("direnv .envrc not allowed; skipping", { dir });
			} else {
				logger.warn("direnv export failed", { dir, exitCode });
			}
			return null;
		}
		return parseDirenvExport(stdout);
	} catch (err) {
		logger.warn("direnv load failed", { dir, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
