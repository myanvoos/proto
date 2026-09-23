import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import type { Args } from "./args";

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
		}
	} catch {}
}

export async function applyStartupCwd(parsed: Args): Promise<void> {
	// `--add-dir` grants the session a workspace root; a path that is missing or is a file cannot,
	// and used to be accepted only to do nothing.
	for (const dir of parsed.addDir ?? []) await assertUsableDirectory(dir, "--add-dir");
	if (parsed.cwd) {
		await assertUsableDirectory(parsed.cwd, "--cwd");
		setProjectDir(parsed.cwd);

		parsed.cwd = getProjectDir();
		return;
	}
	await maybeAutoChdir(parsed);
}

/** Report a bad directory flag as a usage error instead of letting a raw ENOENT escape. */
export async function assertUsableDirectory(dir: string, flag: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(dir);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
		const reason = code === "ENOENT" ? "No such directory." : `Cannot read it (${code ?? formatError(error)}).`;
		throw new CliUsageError(`Invalid ${flag} value: ${JSON.stringify(dir)}. ${reason}`);
	}
	if (!stat.isDirectory()) {
		throw new CliUsageError(`Invalid ${flag} value: ${JSON.stringify(dir)}. Not a directory.`);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
