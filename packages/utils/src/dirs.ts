import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

export const APP_NAME: string = "proto";

export const BINARY_NAME: string = "proto";

export const CONFIG_DIR_NAME: string = ".proto";

export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

export const VERSION: string = version;

export const USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;

export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_ENV_KEYS = ["PROTO_PROFILE", "PI_PROFILE"] as const;

export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (!PROFILE_NAME_RE.test(normalized)) {
		throw new Error(`Invalid PROTO profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}.`);
	}
	return normalized;
}

export function resolveProfileEnv(proto: string | undefined, pi: string | undefined): string | undefined {
	return normalizeProfileName(proto !== undefined ? proto : pi);
}

function getProfileFromEnv(): string | undefined {
	return resolveProfileEnv(process.env.PROTO_PROFILE, process.env.PI_PROFILE);
}

function readProfileFromEnvSafe(): string | undefined {
	try {
		return getProfileFromEnv();
	} catch {
		return undefined;
	}
}

function getBaseConfigRoot(): string {
	return path.join(os.homedir(), getConfigDirName());
}

function getProfileConfigRoot(profile: string | undefined): string {
	const root = getBaseConfigRoot();
	return profile ? path.join(root, "profiles", profile) : root;
}

function readPiProfileFromEnvSafe(): string | undefined {
	try {
		return normalizeProfileName(process.env.PI_PROFILE);
	} catch {
		return undefined;
	}
}

function getProfileAgentDir(profile: string): string {
	return path.join(getProfileConfigRoot(profile), "agent");
}

function isProfileDerivedAgentDir(profile: string | undefined, agentDirEnv: string | undefined): boolean {
	return profile !== undefined && agentDirEnv === getProfileAgentDir(profile);
}

function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	return resolveEquivalentPath(inputPath);
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	if (relative === "") return true;
	if (path.isAbsolute(relative)) return false;
	// Only a leading `..` PATH SEGMENT escapes the root. A plain `startsWith("..")`
	// also rejects legitimate children whose name merely begins with dots (`..foo`).
	return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

export function getProjectDir(): string {
	return projectDir;
}

export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

export function getConfigDirName(): string {
	return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

export function getConfigAgentDirName(): string {
	const profile = getActiveProfile();
	return profile ? path.join(getConfigDirName(), "profiles", profile, "agent") : `${getConfigDirName()}/agent`;
}

type XdgCategory = "data" | "state" | "cache";

class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(options: { agentDirOverride?: string; profile?: string } = {}) {
		const profile = normalizeProfileName(options.profile);
		this.configRoot = getProfileConfigRoot(profile);

		const defaultAgent = path.join(this.configRoot, "agent");
		const agentDirOverride = profile ? undefined : options.agentDirOverride;
		this.agentDir = agentDirOverride ? path.resolve(expandTildePath(agentDirOverride)) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (!value) return undefined;
				try {
					const appRoot = path.join(value, APP_NAME);
					if (profile) {
						const profilePath = path.join(appRoot, "profiles", profile);
						if (fs.existsSync(profilePath)) {
							return profilePath;
						}
						return undefined;
					}
					if (fs.existsSync(appRoot)) {
						return appRoot;
					}
				} catch {}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};

		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const cached = this.#agentCache.get(subdir);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(subdir, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

function resolvePreProfileAgentDir(
	profile: string | undefined,
	agentDirEnv: string | undefined,
	profileAgentDirSource: string | undefined = profile,
): string | undefined {
	return isProfileDerivedAgentDir(profile ?? profileAgentDirSource, agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = readProfileFromEnvSafe();

function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile
		? undefined
		: resolvePreProfileAgentDir(undefined, process.env.PI_CODING_AGENT_DIR, readPiProfileFromEnvSafe());
}

let dirs = new DirResolver({
	agentDirOverride: resolveActiveAgentDirOverride(),
	profile: activeProfile,
});

let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir(
	activeProfile,
	process.env.PI_CODING_AGENT_DIR,
	activeProfile ?? readPiProfileFromEnvSafe(),
);

const RESOLVER_HOME = os.homedir();

export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

export function getConfigRootDir(): string {
	return dirs.configRoot;
}

export function setAgentDir(dir: string): void {
	activeProfile = undefined;
	dirs = new DirResolver({ agentDirOverride: dir });
	process.env.PI_CODING_AGENT_DIR = dir;
	preProfileAgentDirEnv = dir;
	for (const key of PROFILE_ENV_KEYS) {
		delete process.env[key];
	}
}

export function setProfile(profile: string | undefined): void {
	const next = normalizeProfileName(profile);
	if (next && !activeProfile) {
		preProfileAgentDirEnv = resolvePreProfileAgentDir(
			undefined,
			process.env.PI_CODING_AGENT_DIR,
			readPiProfileFromEnvSafe(),
		);
	}
	activeProfile = next;
	if (activeProfile) {
		dirs = new DirResolver({ profile: activeProfile });
		process.env.PROTO_PROFILE = activeProfile;
		process.env.PI_PROFILE = activeProfile;
		process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
	} else {
		for (const key of PROFILE_ENV_KEYS) {
			delete process.env[key];
		}
		if (preProfileAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = preProfileAgentDirEnv;
		}
		dirs = new DirResolver({ agentDirOverride: preProfileAgentDirEnv });
	}
}

export function getActiveProfile(): string | undefined {
	return activeProfile;
}

export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}

export function getAgentDir(): string {
	return dirs.agentDir;
}

export interface AgentDirEnvIssue {
	level: "error" | "warning";
	message: string;
}

/**
 * `PI_CODING_AGENT_DIR` decides where every session, credential and database lives, so a value that
 * cannot work has to be reported before anything is written. A relative value silently follows the
 * working directory and a file where a directory belongs only surfaces as an sqlite error much later.
 */
export function validateAgentDirEnv(raw = process.env.PI_CODING_AGENT_DIR): AgentDirEnvIssue | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return {
			level: "warning",
			message: `PI_CODING_AGENT_DIR is set but empty; using the default agent directory ${getAgentDir()}`,
		};
	}
	if (isProfileDerivedAgentDir(getActiveProfile(), trimmed)) return undefined;
	const expanded = expandTildePath(trimmed);
	if (!path.isAbsolute(expanded)) {
		return {
			level: "error",
			message:
				`PI_CODING_AGENT_DIR must be an absolute path, but is "${raw}". ` +
				`It would resolve to ${path.resolve(expanded)} and move with the working directory, ` +
				"so sessions and credentials would be split across directories.",
		};
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(expanded);
	} catch {
		return undefined; // A missing directory is fine: it is created on first use.
	}
	if (!stat.isDirectory()) {
		return {
			level: "error",
			message: `PI_CODING_AGENT_DIR must point to a directory, but ${expanded} is a ${stat.isSymbolicLink() ? "symlink" : "file"}.`,
		};
	}
	try {
		fs.accessSync(expanded, fs.constants.W_OK | fs.constants.X_OK);
	} catch {
		return { level: "error", message: `PI_CODING_AGENT_DIR is not writable: ${expanded}` };
	}
	return undefined;
}

export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

export function getLogPath(date = new Date(), pid = process.pid): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.${pid}.log`);
}

export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), "proto-plugins.lock.json");
}

export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/**
 * Expands a leading `~`. Environment variables and config files carry the literal character when the
 * shell never got a chance to expand it, and `path.resolve` would otherwise create a directory named `~`.
 */
export function expandTildePath(value: string): string {
	if (value === "~") return os.homedir();
	if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;
	// Join through `path` so the accepted backslash form does not survive as a
	// literal filename character on POSIX (`~\\wt` -> `/home/u\\wt`).
	return path.join(os.homedir(), value.slice(2).replace(/\\/g, "/"));
}

function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const p = expandTildePath(trimmed);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

let worktreesDirOverride: string | undefined;

export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

export function getWorktreesDir(): string {
	return resolveWorktreeBase(process.env.PROTO_WORKTREE_DIR) ?? worktreesDirOverride ?? dirs.rootSubdir("wt", "data");
}

export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

export function getBrowserRelayDir(): string {
	return dirs.rootSubdir("browser-relay", "data");
}

export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

export function getAutoQaDbPath(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}

export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

export function getAuthBrokerSnapshotCachePath(): string {
	const override = process.env.PROTO_AUTH_BROKER_SNAPSHOT_CACHE;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "auth-broker-snapshot.enc"), "cache");
}

export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

function adoptLegacyFile(legacyPath: string, targetPath: string): void {
	if (targetPath === legacyPath) return;
	try {
		if (fs.existsSync(targetPath) || !fs.existsSync(legacyPath)) return;
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.copyFileSync(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
	} catch {}
}

export function getSecretPlaceholderKeyPath(): string {
	const keyPath = dirs.agentSubdir(undefined, "secret-placeholder.key", "state");
	adoptLegacyFile(path.join(dirs.agentDir, "secret-placeholder.key"), keyPath);
	return keyPath;
}

export function getDaemonRuntimeRoot(): string {
	return dirs.rootSubdir(path.join("run", "daemons"), "state");
}

export function getDaemonRuntimeDir(projectDir: string): string {
	const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
	return path.join(getDaemonRuntimeRoot(), key);
}

export function getGlobalDaemonRuntimeRoot(): string {
	return path.join(getBaseConfigRoot(), "run", "daemons", "global");
}

export function getGlobalDaemonRuntimeDir(service: string): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(service)) {
		throw new Error(`Invalid global daemon service name: ${JSON.stringify(service)}`);
	}
	return path.join(getGlobalDaemonRuntimeRoot(), service);
}

export function getProviderInFlightRoot(): string {
	return dirs.rootSubdir(path.join("run", "provider-inflight"), "state");
}

export function getMarketplacesRegistryPath(): string {
	const registryPath = dirs.rootSubdir("marketplaces.json", "data");
	adoptLegacyFile(path.join(dirs.configRoot, "marketplaces.json"), registryPath);
	return registryPath;
}

export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}

let cachedInstallId: string | null = null;

const INSTALL_ID_FILE = "install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getBaseConfigRoot(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (UUID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}

		observedInvalid = existing.length > 0;
	} catch {}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });

		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (UUID_RE.test(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
	}

	cachedInstallId = next;
	return next;
}
