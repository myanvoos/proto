import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSafeProjectCwd, logger, postmortem } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import fnEnvHelper from "./shell-snapshot-fn-env.sh" with { type: "text" };

const SNAPSHOT_CACHE_MAX_ENTRIES = 16;
const cachedSnapshotPaths = new LRUCache<string, string>({
	max: SNAPSHOT_CACHE_MAX_ENTRIES,
	dispose: snapshotPath => {
		try {
			fs.unlinkSync(snapshotPath);
		} catch {}
	},
});
const SNAPSHOT_TIMEOUT_MS = 2_000;
const inflightSnapshots = new Map<string, Promise<string | null>>();
const failedSnapshots = new LRUCache<string, number>({ max: SNAPSHOT_CACHE_MAX_ENTRIES });
const SNAPSHOT_FAILURE_RETRY_MS = 60_000;

const SHELL_INCOMPATIBLE_ALIAS_BODY = /[()|&;<>`]/;

const SNAPSHOT_ALIAS_LINE = /^alias -- ([^\s=]+)='(.*)'\s*$/;

export function sanitizeSnapshotForEngine(content: string): { content: string; dropped: string[] } {
	const dropped: string[] = [];
	const lines = content.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const m = line.match(SNAPSHOT_ALIAS_LINE);
		if (m) {
			const value = m[2].replace(/'\\''/g, "'");
			if (SHELL_INCOMPATIBLE_ALIAS_BODY.test(value)) {
				dropped.push(m[1]);
				continue;
			}
		}
		out.push(line);
	}
	return { content: out.join("\n"), dropped };
}

function scrubSnapshotInPlace(snapshotPath: string): void {
	try {
		const raw = fs.readFileSync(snapshotPath, "utf8");
		const { content, dropped } = sanitizeSnapshotForEngine(raw);
		if (dropped.length === 0) return;
		fs.writeFileSync(snapshotPath, content);
		logger.debug("shell-snapshot: dropped shell-incompatible aliases", { dropped });
	} catch (err) {
		logger.debug("shell-snapshot: scrub failed", { err: String(err) });
	}
}

function sanitizeSnapshotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const sanitized = { ...env };
	delete sanitized.BASH_ENV;
	delete sanitized.ENV;
	return sanitized;
}

function getShellConfigFile(shell: string, env: Record<string, string | undefined>): string {
	const home = env.HOME || os.homedir();
	if (shell.includes("zsh")) return path.resolve(home, ".zshrc");
	if (shell.includes("bash")) return path.resolve(home, ".bashrc");
	return path.resolve(home, ".profile");
}

function snapshotCacheKey(shell: string, rcFile: string, env: Record<string, string | undefined>): string {
	let rcIdentity = "missing";
	try {
		const stat = fs.statSync(rcFile, { bigint: true });
		rcIdentity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
	} catch {}
	const capturedEnv = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return JSON.stringify([shell, rcFile, rcIdentity, capturedEnv]);
}

function generateSnapshotScript(shell: string, snapshotPath: string, rcFile: string): string {
	const hasRcFile = fs.existsSync(rcFile);
	const isZsh = shell.includes("zsh");
	const commonTools =
		"ls|dir|vdir|cat|head|tail|less|more|grep|egrep|fgrep|rg|find|fd|locate|sed|awk|perl|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|pwd|readlink|stat|cut|sort|uniq|xargs|tee|tr|basename|dirname";
	const commonFunctionRegex = `^(${commonTools})$`;
	const commonAliasRegex = `^(alias )?(${commonTools})=`;

	const escapedPath = snapshotPath.replace(/'/g, "'\\''");

	const listFunctionNames = isZsh ? "typeset +f" : "declare -F | command cut -d' ' -f3";
	const printFunction = isZsh ? "typeset -f" : "declare -f";
	const functionExtractor = `# Force autoload all functions first
${printFunction} > /dev/null 2>&1
__proto_all=$(${listFunctionNames} 2>/dev/null | command sort -u)
__proto_next=$(printf '%s\\n' "$__proto_all" | command grep -vE '^(_|__)' | command grep -vE '${commonFunctionRegex}')
__proto_kept=$(command mktemp)
while [ -n "$__proto_next" ]; do
   printf '%s\\n' "$__proto_next" >> "$__proto_kept"
   __proto_next=$(printf '%s\\n' "$__proto_next" | while IFS= read -r __proto_f; do ${printFunction} "$__proto_f" 2>/dev/null; done \\
      | command grep -oE '[A-Za-z_][A-Za-z0-9_.-]*' | command sort -u | command grep -xF -f <(printf '%s\\n' "$__proto_all") \\
      | command grep -vE '${commonFunctionRegex}' | command grep -vxF -f "$__proto_kept")
done
while IFS= read -r __proto_f; do ${printFunction} "$__proto_f" 2>/dev/null; done < "$__proto_kept"
command rm -f "$__proto_kept"`;

	const optionsScript = isZsh
		? `
echo "# Shell Options" >> "$SNAPSHOT_FILE"
setopt 2>/dev/null | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
`
		: `
echo "# Shell Options" >> "$SNAPSHOT_FILE"
shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"
set -o 2>/dev/null | awk '$2 == "on" && $1 !~ /^(onecmd|monitor|restricted)$/ {print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
`;

	return `
SNAPSHOT_FILE='${escapedPath}'

# Snapshot may inline env-var values referenced by captured functions (#3470).
# Defence in depth: (a) JS caller pre-creates the file at 0600 so the shell's
# \`>|\`/\`>>\` redirections truncate/append without changing the inode mode,
# (b) we \`umask 077\` before AND after sourcing the rc so any other file the
# script creates is private even when the rc resets umask to 022, (c) JS
# caller chmods file + dir after the script exits.
umask 077

# Source user's rc file if it exists
${hasRcFile ? `source "${rcFile}" < /dev/null 2>/dev/null` : "# No user config file to source"}

# Re-tighten umask in case the rc reset it (common \`.bashrc\`/\`.zshrc\` set
# \`umask 022\` for the interactive shell).
umask 077

# Create/clear the snapshot file
echo "# Shell snapshot - generated by proto agent" >| "$SNAPSHOT_FILE"

# Unalias everything first to avoid conflicts when sourced
echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

# Capture function definitions into a variable so we can both persist them
# and scan their bodies for env-var references (issue #3470).
__proto_funcs=$(
${functionExtractor}
)
echo "# Functions" >> "$SNAPSHOT_FILE"
printf '%s\\n' "$__proto_funcs" >> "$SNAPSHOT_FILE"

# Re-export uppercase identifiers referenced by snapshotted functions whose
# value is set in the rc-sourced shell. Without this, activation idioms like
# mise's \`mise()\` -> \`command "$__MISE_EXE" "$@"\` blow up because the helper
# var is lost (issue #3470). Helper definitions are POSIX-shell so the same
# block works for both bash and zsh.
echo "# Captured function environment" >> "$SNAPSHOT_FILE"
${fnEnvHelper}
printf '%s\\n' "$__proto_funcs" | __proto_emit_referenced_exports >> "$SNAPSHOT_FILE"
unset -f __proto_sq_quote __proto_emit_export_for __proto_emit_referenced_exports 2>/dev/null
unset __proto_funcs __proto_qbuf __proto_qout __proto_sq __proto_xv __proto_name 2>/dev/null

${optionsScript}

# Export aliases (limit to 1000)
echo "# Aliases" >> "$SNAPSHOT_FILE"
alias 2>/dev/null | grep -vE '${commonAliasRegex}' | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"

# Export PATH
echo "export PATH='$PATH'" >> "$SNAPSHOT_FILE"

# Verify snapshot was created
if [ ! -f "$SNAPSHOT_FILE" ]; then
   echo "Error: Snapshot file was not created" >&2
   exit 1
fi
`.trim();
}

export async function getOrCreateSnapshot(
	shell: string,
	env: Record<string, string | undefined>,
	timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<string | null> {
	const snapshotEnv = sanitizeSnapshotEnv(env);
	const rcFile = getShellConfigFile(shell, snapshotEnv);
	const cacheKey = snapshotCacheKey(shell, rcFile, snapshotEnv);

	const cached = cachedSnapshotPaths.get(cacheKey);
	if (cached && fs.existsSync(cached)) return cached;
	if (cached) {
		cachedSnapshotPaths.delete(cacheKey);
	}

	const inflight = inflightSnapshots.get(cacheKey);
	if (inflight) return inflight;
	if (performance.now() < (failedSnapshots.get(cacheKey) ?? 0)) return null;
	const creation = createSnapshot(shell, snapshotEnv, rcFile, cacheKey, timeoutMs)
		.catch(() => null)
		.then(snapshotPath => {
			inflightSnapshots.delete(cacheKey);
			if (snapshotPath) failedSnapshots.delete(cacheKey);
			else failedSnapshots.set(cacheKey, performance.now() + SNAPSHOT_FAILURE_RETRY_MS);
			return snapshotPath;
		});
	inflightSnapshots.set(cacheKey, creation);
	return creation;
}

async function createSnapshot(
	shell: string,
	snapshotEnv: Record<string, string | undefined>,
	rcFile: string,
	cacheKey: string,
	timeoutMs: number,
): Promise<string | null> {
	const uid = process.getuid?.();
	const snapshotDir = path.join(
		os.tmpdir(),
		uid === undefined ? "proto-shell-snapshots" : `proto-shell-snapshots-${uid}`,
	);

	const shellName = shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : "sh";
	const snapshotPath = path.join(snapshotDir, `snapshot-${shellName}-${crypto.randomUUID()}.sh`);

	try {
		fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

		try {
			fs.chmodSync(snapshotDir, 0o700);
		} catch {}

		fs.writeFileSync(snapshotPath, "", { mode: 0o600 });
	} catch (err) {
		logger.debug("shell-snapshot: snapshot dir unusable", { dir: snapshotDir, err: String(err) });
		return null;
	}

	const script = generateSnapshotScript(shell, snapshotPath, rcFile);

	let succeeded = false;
	try {
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(snapshotEnv)) {
			if (value !== undefined) {
				spawnEnv[key] = value;
			}
		}
		const child = Bun.spawn([shell, "-c", script], {
			cwd: getSafeProjectCwd(),
			env: spawnEnv,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});

		await child.exited;
		if (child.exitCode === 0 && fs.existsSync(snapshotPath)) {
			try {
				fs.chmodSync(snapshotPath, 0o600);
			} catch {}
			scrubSnapshotInPlace(snapshotPath);
			cachedSnapshotPaths.set(cacheKey, snapshotPath);
			succeeded = true;
			return snapshotPath;
		}
	} catch {
	} finally {
		if (!succeeded) {
			try {
				fs.rmSync(snapshotPath, { force: true });
			} catch {}
		}
	}

	return null;
}

postmortem.register("shell-snapshot", () => {
	cachedSnapshotPaths.clear();
});
