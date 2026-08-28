import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getRemoteHostDir, getSshControlDir, isEnoent, logger, postmortem, ptree } from "@oh-my-pi/pi-utils";
import { buildSshTarget, sanitizeHostName } from "./utils";

export interface SSHConnectionTarget {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	compat?: boolean;
}

type SSHHostOs = "windows" | "linux" | "macos" | "unknown";
export type SSHHostShell = "cmd" | "powershell" | "bash" | "zsh" | "sh" | "unknown";
type SshPlatform = typeof process.platform;

interface SSHHostInfo {
	version: number;
	os: SSHHostOs;
	shell: SSHHostShell;

	transferShell?: "sh" | "bash" | "zsh";
	compatShell?: "bash" | "sh";
	compatEnabled: boolean;
}

const CONTROL_SOCKET_BASENAME = "%C.sock";

const CONTROL_SOCKET_NAME_BYTES = 40 + ".sock".length;

const MUX_TEMP_SUFFIX_BYTES = 1 + 16;

export function controlPathFitsBudget(controlDir: string, platform: SshPlatform): boolean {
	const sunPathLimit = platform === "darwin" ? 104 : 108;
	const worstCase = Buffer.byteLength(controlDir) + 1 + CONTROL_SOCKET_NAME_BYTES + MUX_TEMP_SUFFIX_BYTES;
	return worstCase < sunPathLimit;
}

export function sshControlFallbackDir(canonicalDir: string, uid: number, tmpBase = "/tmp"): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(uid))
		.update("\0")
		.update(canonicalDir)
		.digest("hex")
		.slice(0, 20);
	return path.join(tmpBase, `proto-${key}`);
}

interface ControlDirChoice {
	dir: string;

	shared: boolean;
}

export function resolveSshControlDir(opts: {
	canonicalDir: string;
	platform: SshPlatform;
	uid: number | undefined;
	tmpBase?: string;
}): ControlDirChoice {
	const { canonicalDir, platform, uid, tmpBase } = opts;
	if (uid === undefined) return { dir: canonicalDir, shared: false };
	if (controlPathFitsBudget(canonicalDir, platform)) return { dir: canonicalDir, shared: false };
	return { dir: sshControlFallbackDir(canonicalDir, uid, tmpBase), shared: true };
}

interface ControlDirGuardStat {
	isSymlink: boolean;
	isDir: boolean;
	uid: number;
	mode: number;
}

export function controlDirGuardError(stat: ControlDirGuardStat, expectedUid: number | undefined): string | null {
	if (stat.isSymlink) return "is a symlink";
	if (!stat.isDir) return "is not a directory";
	if (expectedUid !== undefined && stat.uid !== expectedUid) {
		return `is owned by uid ${stat.uid}, not ${expectedUid}`;
	}
	if ((stat.mode & 0o777) !== 0o700) return `must be mode 0700, got ${(stat.mode & 0o777).toString(8)}`;
	return null;
}

const { dir: CONTROL_DIR, shared: CONTROL_DIR_SHARED } = resolveSshControlDir({
	canonicalDir: getSshControlDir(),
	platform: process.platform,
	uid: process.getuid?.(),
});
const CONTROL_PATH = path.join(CONTROL_DIR, CONTROL_SOCKET_BASENAME);
const HOST_INFO_DIR = getRemoteHostDir();
const HOST_INFO_VERSION = 4;

const activeHosts = new Map<string, SSHConnectionTarget>();
const pendingConnections = new Map<string, Promise<void>>();
const hostInfoCache = new Map<string, SSHHostInfo>();

interface SSHArgsOptions {
	allowStdin?: boolean;
}

export function ensureSshControlDir(): void {
	fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
	if (CONTROL_DIR_SHARED) {
		assertOwnerPrivateDir(CONTROL_DIR);
		return;
	}
	try {
		fs.chmodSync(CONTROL_DIR, 0o700);
	} catch (err) {
		logger.debug("SSH control dir chmod failed", { path: CONTROL_DIR, error: String(err) });
	}
}

export function assertOwnerPrivateDir(dir: string): void {
	const uid = process.getuid?.();
	let fd: number;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;

		if (code === "ELOOP" || code === "ENOTDIR") {
			let isSymlink = false;
			try {
				isSymlink = fs.lstatSync(dir).isSymbolicLink();
			} catch {}
			throw new Error(`SSH control directory ${dir} ${isSymlink ? "is a symlink" : "is not a directory"}`);
		}
		throw err;
	}
	try {
		let st = fs.fstatSync(fd);

		if ((uid === undefined || st.uid === uid) && (st.mode & 0o777) !== 0o700) {
			try {
				fs.fchmodSync(fd, 0o700);
				st = fs.fstatSync(fd);
			} catch (err) {
				logger.debug("SSH control dir chmod failed", { path: dir, error: String(err) });
			}
		}
		const reason = controlDirGuardError(
			{ isSymlink: false, isDir: st.isDirectory(), uid: st.uid, mode: st.mode },
			uid,
		);
		if (reason) {
			throw new Error(`SSH control directory ${dir} ${reason}`);
		}
	} finally {
		fs.closeSync(fd);
	}
}

function getHostInfoPath(name: string): string {
	return path.join(HOST_INFO_DIR, `${sanitizeHostName(name)}.json`);
}

async function validateKeyPermissions(keyPath?: string): Promise<void> {
	if (!keyPath) return;
	let stats: fs.Stats;
	try {
		stats = await fs.promises.stat(keyPath);
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`SSH key not found: ${keyPath}`);
		}
		throw err;
	}
	if (!stats.isFile()) {
		throw new Error(`SSH key is not a file: ${keyPath}`);
	}
	const mode = stats.mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(`SSH key permissions must be 600 or stricter: ${keyPath}`);
	}
}

function buildCommonArgs(host: SSHConnectionTarget, options?: SSHArgsOptions): string[] {
	const args = options?.allowStdin ? [] : ["-n"];

	args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=3600");
	args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new");

	if (host.port) {
		args.push("-p", String(host.port));
	}
	if (host.keyPath) {
		args.push("-i", host.keyPath);
	}

	return args;
}

const SSH_HELPER_TIMEOUT_MS = 30_000;

async function runSshSync(
	args: string[],
	timeoutMs = SSH_HELPER_TIMEOUT_MS,
): Promise<{ exitCode: number | null; stderr: string }> {
	const result = await ptree.exec(["ssh", ...args], {
		timeout: timeoutMs,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return { exitCode: result.exitCode, stderr: result.stderr.trim() };
}

async function runSshCaptureSync(
	args: string[],
	timeoutMs = SSH_HELPER_TIMEOUT_MS,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const result = await ptree.exec(["ssh", ...args], {
		timeout: timeoutMs,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

export const _sshHelpersForTests = { runSshSync, runSshCaptureSync };

function ensureSshBinary(): void {
	if (!$which("ssh")) {
		throw new Error("ssh binary not found on PATH");
	}
}

function parseOs(value: unknown): SSHHostOs | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "windows":
			return "windows";
		case "linux":
			return "linux";
		case "macos":
		case "darwin":
			return "macos";
		case "unknown":
			return "unknown";
		default:
			return null;
	}
}

function parseShell(value: unknown): SSHHostShell | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (normalized.includes("bash")) return "bash";
	if (normalized.includes("zsh")) return "zsh";
	if (normalized.includes("pwsh") || normalized.includes("powershell")) return "powershell";
	if (normalized.includes("cmd.exe") || normalized === "cmd") return "cmd";

	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (base === "sh" || base === "dash" || base === "ash" || base === "ksh" || base === "mksh") return "sh";
	return "unknown";
}

function parseCompatShell(value: unknown): "bash" | "sh" | undefined {
	if (value === "bash" || value === "sh") return value;
	return undefined;
}

function parseTransferShell(value: unknown): SSHHostInfo["transferShell"] {
	if (value === "sh" || value === "bash" || value === "zsh") return value;
	return undefined;
}

function applyCompatOverride(host: SSHConnectionTarget, info: SSHHostInfo): SSHHostInfo {
	const compatShell =
		info.compatShell ??
		(info.os === "windows" && info.shell === "bash"
			? "bash"
			: info.os === "windows" && info.shell === "sh"
				? "sh"
				: undefined);
	const compatEnabled = host.compat === false ? false : info.os === "windows" && compatShell !== undefined;
	if (host.compat === true && !compatShell) {
		logger.warn("SSH compat requested but no compatible shell detected", {
			host: host.name,
			shell: info.shell,
		});
	}
	return { ...info, version: info.version ?? 0, compatShell, compatEnabled };
}

export function parseHostInfo(value: unknown): SSHHostInfo | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const os = parseOs(record.os) ?? "unknown";
	const shell = parseShell(record.shell) ?? "unknown";
	const compatShell = parseCompatShell(record.compatShell);
	const transferShell = parseTransferShell(record.transferShell);
	const compatEnabled = typeof record.compatEnabled === "boolean" ? record.compatEnabled : false;
	const version = typeof record.version === "number" ? record.version : 0;
	return {
		version,
		os,
		shell,
		transferShell,
		compatShell,
		compatEnabled,
	};
}

function shouldRefreshHostInfo(host: SSHConnectionTarget, info: SSHHostInfo): boolean {
	if (info.version !== HOST_INFO_VERSION) return true;
	if (info.os === "unknown") return true;
	if (info.os !== "windows" && info.compatEnabled) return true;
	if (info.os === "windows" && info.compatEnabled && !info.compatShell) return true;
	if (info.os === "windows" && info.compatShell === "bash" && info.shell === "unknown") return true;
	if (host.compat === true && info.os === "windows" && !info.compatShell) return true;

	if (info.os !== "windows" && !info.transferShell) return true;
	return false;
}

async function loadHostInfoFromDisk(host: SSHConnectionTarget): Promise<SSHHostInfo | undefined> {
	const path = getHostInfoPath(host.name);
	try {
		const raw = await fs.promises.readFile(path, "utf-8");
		const parsed = parseHostInfo(JSON.parse(raw));
		if (!parsed) return undefined;
		const resolved = applyCompatOverride(host, parsed);
		hostInfoCache.set(host.name, resolved);
		return resolved;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to load SSH host info", { host: host.name, error: String(err) });
		return undefined;
	}
}

async function loadHostInfoFromDiskByName(hostName: string): Promise<SSHHostInfo | undefined> {
	const path = getHostInfoPath(hostName);
	try {
		const raw = await fs.promises.readFile(path, "utf-8");
		const parsed = parseHostInfo(JSON.parse(raw));
		if (!parsed) return undefined;
		return parsed;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to load SSH host info", { host: hostName, error: String(err) });
		return undefined;
	}
}

async function persistHostInfo(host: SSHConnectionTarget, info: SSHHostInfo): Promise<void> {
	try {
		const path = getHostInfoPath(host.name);
		const payload = { ...info, version: HOST_INFO_VERSION };
		hostInfoCache.set(host.name, payload);
		await Bun.write(path, JSON.stringify(payload, null, 2), { createPath: true });
	} catch (err) {
		logger.warn("Failed to persist SSH host info", { host: host.name, error: String(err) });
	}
}

export const HOST_PROBE_MARKER = "PI_HOST_PROBE=";

export const TRANSFER_PROBE_MARKER = "PI_TRANSFER_OK|";

const TRANSFER_SHELL_CANDIDATES = ["sh", "bash", "zsh"] as const;

export function extractProbePayload(stdout: string, stderr: string, marker = HOST_PROBE_MARKER): string | null {
	for (const blob of [stdout, stderr]) {
		if (!blob) continue;
		for (const line of blob.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith(marker)) {
				return trimmed.slice(marker.length);
			}
		}
	}
	return null;
}

export function findProbeMarker(stdout: string, stderr: string, marker: string): string | null {
	for (const blob of [stdout, stderr]) {
		if (!blob) continue;
		const idx = blob.indexOf(marker);
		if (idx !== -1) return blob.slice(idx + marker.length);
	}
	return null;
}

export function osFromUname(value: string): SSHHostOs | undefined {
	const uname = value.toLowerCase();
	if (uname.includes("darwin")) return "macos";
	if (uname.includes("linux") || uname.includes("gnu")) return "linux";
	if (uname.includes("mingw") || uname.includes("msys") || uname.includes("cygwin") || uname.includes("windows")) {
		return "windows";
	}
	return undefined;
}

async function probeTransferShell(
	host: SSHConnectionTarget,
): Promise<{ shell: SSHHostInfo["transferShell"]; uname: string }> {
	for (const candidate of TRANSFER_SHELL_CANDIDATES) {
		const remote = `${candidate} -lc 'printf "${TRANSFER_PROBE_MARKER}"; uname -s 2>/dev/null || true'`;
		const probe = await runSshCaptureSync(await buildRemoteCommand(host, remote));
		if (probe.exitCode !== 0) continue;
		const tail = findProbeMarker(probe.stdout, probe.stderr, TRANSFER_PROBE_MARKER);
		if (tail === null) continue;
		return { shell: candidate, uname: tail.trim() };
	}
	return { shell: undefined, uname: "" };
}

async function probeHostInfo(host: SSHConnectionTarget): Promise<SSHHostInfo> {
	const command = `echo "${HOST_PROBE_MARKER}$OSTYPE|$SHELL|$BASH_VERSION" 2>/dev/null || echo "${HOST_PROBE_MARKER}%OS%|%COMSPEC%|"`;
	const result = await runSshCaptureSync(await buildRemoteCommand(host, command));
	const payload = extractProbePayload(result.stdout, result.stderr);
	if (payload === null) {
		logger.debug("SSH host probe failed", { host: host.name, error: result.stderr });
		const transferProbe = await probeTransferShell(host);
		const fallback: SSHHostInfo = {
			version: HOST_INFO_VERSION,
			os: transferProbe.shell ? (osFromUname(transferProbe.uname) ?? "unknown") : "unknown",
			shell: "unknown",
			transferShell: transferProbe.shell,
			compatShell: undefined,
			compatEnabled: false,
		};
		hostInfoCache.set(host.name, fallback);
		return fallback;
	}

	const [rawOs = "", rawShell = "", rawBash = ""] = payload.split("|");
	const ostype = rawOs.trim();
	const shellRaw = rawShell.trim();
	const bashVersion = rawBash.trim();
	const payloadLower = payload.toLowerCase();
	const osLower = ostype.toLowerCase();
	const shellLower = shellRaw.toLowerCase();
	const unexpandedPosixVars =
		payload.includes("$OSTYPE") || payload.includes("$SHELL") || payload.includes("$BASH_VERSION");
	const windowsDetected =
		osLower.includes("windows") ||
		osLower.includes("msys") ||
		osLower.includes("cygwin") ||
		osLower.includes("mingw") ||
		payloadLower.includes("windows_nt") ||
		payloadLower.includes("comspec") ||
		shellLower.includes("cmd") ||
		shellLower.includes("powershell") ||
		unexpandedPosixVars ||
		payload.includes("%OS%");

	let os: SSHHostOs = "unknown";
	if (windowsDetected) {
		os = "windows";
	} else if (osLower.includes("darwin")) {
		os = "macos";
	} else if (osLower.includes("linux") || osLower.includes("gnu")) {
		os = "linux";
	}

	let shell = parseShell(shellLower) ?? "unknown";
	if (shell === "unknown" && os === "windows" && !shellLower) {
		shell = "cmd";
	}

	let transferShell: SSHHostInfo["transferShell"];
	if (os !== "windows") {
		const probe = await probeTransferShell(host);
		transferShell = probe.shell;

		if (transferShell && os === "unknown") {
			os = osFromUname(probe.uname) ?? os;
		}
	}

	const hasBash = !unexpandedPosixVars && (Boolean(bashVersion) || shell === "bash");
	let compatShell: SSHHostInfo["compatShell"];
	if (os === "windows" && host.compat !== false) {
		const bashProbe = await runSshCaptureSync(await buildRemoteCommand(host, 'bash -lc "echo PI_BASH_OK"'));
		if (bashProbe.exitCode === 0 && bashProbe.stdout.includes("PI_BASH_OK")) {
			compatShell = "bash";
		} else {
			const shProbe = await runSshCaptureSync(await buildRemoteCommand(host, 'sh -lc "echo PI_SH_OK"'));
			if (shProbe.exitCode === 0 && shProbe.stdout.includes("PI_SH_OK")) {
				compatShell = "sh";
			}
		}
	} else if (os === "windows" && hasBash) {
		compatShell = "bash";
	} else if (os === "windows" && shell === "sh") {
		compatShell = "sh";
	}
	const compatEnabled = host.compat === false ? false : os === "windows" && compatShell !== undefined;

	const info: SSHHostInfo = applyCompatOverride(host, {
		version: HOST_INFO_VERSION,
		os,
		shell,
		transferShell,
		compatShell,
		compatEnabled,
	});

	hostInfoCache.set(host.name, info);
	await persistHostInfo(host, info);
	return info;
}

export async function getHostInfo(hostName: string): Promise<SSHHostInfo | undefined> {
	const cached = hostInfoCache.get(hostName);
	if (cached) return cached;
	return loadHostInfoFromDiskByName(hostName);
}

export async function ensureHostInfo(host: SSHConnectionTarget): Promise<SSHHostInfo> {
	const cached = hostInfoCache.get(host.name);
	if (cached) {
		const resolved = applyCompatOverride(host, cached);
		hostInfoCache.set(host.name, resolved);
		if (!shouldRefreshHostInfo(host, resolved)) return resolved;
	}
	const fromDisk = await loadHostInfoFromDisk(host);
	if (fromDisk && !shouldRefreshHostInfo(host, fromDisk)) return fromDisk;
	await ensureConnection(host);
	const current = hostInfoCache.get(host.name);
	if (current && !shouldRefreshHostInfo(host, current)) return current;
	return probeHostInfo(host);
}

export async function buildRemoteCommand(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHArgsOptions,
): Promise<string[]> {
	await validateKeyPermissions(host.keyPath);
	return [...buildCommonArgs(host, options), buildSshTarget(host.username, host.host), command];
}

let registered = false;

export async function ensureConnection(host: SSHConnectionTarget): Promise<void> {
	const key = host.name;
	const pending = pendingConnections.get(key);
	if (pending) {
		await pending;
		return;
	}

	const promise = (async () => {
		ensureSshBinary();
		ensureSshControlDir();
		await validateKeyPermissions(host.keyPath);

		if (!registered) {
			registered = true;
			postmortem.register("ssh-cleanup", async () => {
				await closeAllConnections();
			});
		}

		const target = buildSshTarget(host.username, host.host);
		const check = await runSshSync(["-O", "check", ...buildCommonArgs(host), target]);
		if (check.exitCode === 0) {
			activeHosts.set(key, host);
			if (!hostInfoCache.has(key) && !(await loadHostInfoFromDisk(host))) {
				await probeHostInfo(host);
			}
			return;
		}

		const start = await runSshSync(["-M", "-N", "-f", ...buildCommonArgs(host), target]);
		if (start.exitCode !== 0) {
			const detail = start.stderr ? `: ${start.stderr}` : "";
			throw new Error(`Failed to start SSH master for ${target}${detail}`);
		}

		activeHosts.set(key, host);
		if (!hostInfoCache.has(key) && !(await loadHostInfoFromDisk(host))) {
			await probeHostInfo(host);
		}
	})();

	pendingConnections.set(key, promise);
	try {
		await promise;
	} finally {
		pendingConnections.delete(key);
	}
}

async function closeConnectionInternal(host: SSHConnectionTarget): Promise<void> {
	const target = buildSshTarget(host.username, host.host);
	await runSshSync(["-O", "exit", ...buildCommonArgs(host), target]);
}

export async function closeAllConnections(): Promise<void> {
	for (const [name, host] of Array.from(activeHosts.entries())) {
		await closeConnectionInternal(host);
		activeHosts.delete(name);
	}
}

export function getControlPathTemplate(): string {
	return CONTROL_PATH;
}

export function getControlDir(): string {
	return CONTROL_DIR;
}
