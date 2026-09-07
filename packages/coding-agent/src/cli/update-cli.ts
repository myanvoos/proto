import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { $env, $which, BINARY_NAME, compareVersions, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { $ } from "bun";
import { theme } from "../modes/theme/theme";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

const REPO = "myanvoos/proto";
const HOMEBREW_FORMULA = "myanvoos/tap/proto";
const MISE_TOOL = "github:myanvoos/proto";
const NIX_STORE_DIR = "/nix/store";

const GITHUB_API = "https://api.github.com";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface ReleaseInfo {
	tag: string;
	version: string;
}

interface ReleaseBinaryAsset {
	url: string;
	size: number;
	digest: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false || release.prerelease !== false) {
		throw new Error(`GitHub release ${expectedTag} is not a published stable release`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${REPO}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}

	return {
		url: expectedUrl,
		size: asset.size,
		digest: `sha256:${digest.toLowerCase()}`,
	};
}

function githubApiToken(): string | undefined {
	return $env.GITHUB_TOKEN || $env.GH_TOKEN;
}

async function fetchReleaseJson(
	apiPath: string,
	timeoutMs: number,
	fetchImpl: Fetch = fetch,
	githubToken: string | undefined = githubApiToken(),
): Promise<unknown> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

	let response: Response;
	try {
		response = await fetchImpl(`${GITHUB_API}${apiPath}`, {
			headers,
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching GitHub release metadata after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if ((response.status === 403 && !githubToken) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub release metadata: ${response.statusText}`);
	}

	return await response.json();
}

async function getReleaseBinaryAsset(
	expectedVersion: string,
	binaryName: string,
	fetchImpl: Fetch = fetch,
	githubToken: string | undefined = githubApiToken(),
): Promise<ReleaseBinaryAsset> {
	const tag = `v${expectedVersion}`;
	const release = await fetchReleaseJson(
		`/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
		RELEASE_METADATA_TIMEOUT_MS,
		fetchImpl,
		githubToken,
	);
	return resolveReleaseBinaryAsset(release, tag, binaryName);
}

interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
}

export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = createHash("sha256");
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean; plugins: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, BINARY_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	return path.normalize(filePath);
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isSymlinkPath(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;

	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function isPathInManagerRoot(linkTarget: string, nodeModulesDir: string): boolean {
	if (isPathInDirectoryLexical(linkTarget, nodeModulesDir)) return true;

	const nodeModulesReal = tryRealpath(path.resolve(nodeModulesDir));
	return nodeModulesReal !== undefined && isPathInDirectoryLexical(linkTarget, nodeModulesReal);
}

function resolveNpmGlobalNodeModulesDir(globalBinDir: string | undefined): string | undefined {
	if (!globalBinDir) return undefined;
	return path.join(path.dirname(globalBinDir), "lib", "node_modules");
}

function isManagerOwnedBinEntry(linkTarget: string | undefined, nodeModulesDir: string | undefined): boolean {
	return linkTarget === undefined || (nodeModulesDir !== undefined && isPathInManagerRoot(linkTarget, nodeModulesDir));
}

type UpdateMethod = "brew" | "mise" | "nix" | "bun" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;

	bunGlobalDir?: string;

	ompIsRegularFile?: boolean;

	ompLinkTarget?: string;

	allowPackageManagers?: boolean;
}

type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "nix" }
	| { method: "binary"; path: string; replacesSymlink: boolean };

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const {
		allowPackageManagers = true,
		bunGlobalDir,
		homebrewPrefix,
		miseBinDirs = [],
		miseDataDir,
		npmBinDir,
		ompIsRegularFile = false,
		ompLinkTarget,
	} = options;
	if (isPathInDirectory(ompPath, NIX_STORE_DIR)) return "nix";
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";

	const bunNodeModulesDir = resolveBunGlobalNodeModulesDirFromLocations({
		globalDir: bunGlobalDir,
		globalBinDir: bunBinDir,
	});
	if (
		allowPackageManagers &&
		bunBinDir &&
		isPathInDirectory(ompPath, bunBinDir) &&
		!ompIsRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, bunNodeModulesDir)
	) {
		return "bun";
	}
	const npmNodeModulesDir = resolveNpmGlobalNodeModulesDir(npmBinDir);
	if (
		allowPackageManagers &&
		npmBinDir &&
		isPathInDirectory(ompPath, npmBinDir) &&
		!ompIsRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, npmNodeModulesDir)
	) {
		return "npm";
	}
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

export function resolveUpdateTargetFromPath(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateTarget {
	let ompIsRegularFile = false;
	let ompIsSymlink = false;
	let ompLinkTarget: string | undefined;
	let ompRealpath: string | undefined;
	try {
		const stat = fs.lstatSync(ompPath);
		ompIsRegularFile = stat.isFile() && !stat.isSymbolicLink();
		ompIsSymlink = stat.isSymbolicLink();
		if (ompIsSymlink) {
			const rawTarget = fs.readlinkSync(ompPath);
			const linkDir = path.dirname(ompPath);
			ompLinkTarget = path.resolve(tryRealpath(linkDir) ?? linkDir, rawTarget);
			ompRealpath = tryRealpath(ompPath);
		}
	} catch {}

	const method = resolveUpdateMethod(ompPath, bunBinDir, {
		...options,
		allowPackageManagers: false,
		ompIsRegularFile,
		ompLinkTarget,
	});
	if (method === "brew" || method === "mise" || method === "nix") return { method };

	// A bun/npm-owned symlink is overwritten in place by the standalone binary
	// rather than followed to the package payload it points at.
	const managerLauncher =
		ompIsSymlink &&
		resolveUpdateMethod(ompPath, bunBinDir, {
			...options,
			allowPackageManagers: true,
			ompIsRegularFile,
			ompLinkTarget,
		}) !== "binary";
	const binaryPath = ompIsSymlink && !managerLauncher ? (ompRealpath ?? ompPath) : ompPath;
	return { method: "binary", path: binaryPath, replacesSymlink: ompIsSymlink && binaryPath === ompPath };
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();
	if (!ompPath) throw new Error(`Could not resolve ${BINARY_NAME} binary path in PATH`);

	// Package-manager locations are probed only to recognize a bun/npm-owned
	// launcher symlink; they are never used to run an install.
	const probeManagers = isSymlinkPath(ompPath);
	const bunBinDir = probeManagers ? await getBunGlobalBinDir() : undefined;
	const npmBinDir = probeManagers ? await getNpmGlobalBinDir() : undefined;

	return resolveUpdateTargetFromPath(ompPath, bunBinDir, {
		bunGlobalDir: probeManagers ? process.env.BUN_INSTALL_GLOBAL_DIR : undefined,
		homebrewPrefix,
		miseBinDirs,
		miseDataDir,
		npmBinDir,
	});
}

export async function getLatestRelease(options: { timeoutMs?: number } = {}): Promise<ReleaseInfo> {
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	const release = await fetchReleaseJson(`/repos/${REPO}/releases/latest`, timeoutMs);
	if (!isRecord(release) || typeof release.tag_name !== "string" || release.tag_name.length === 0) {
		throw new Error(`Malformed GitHub release metadata for ${REPO}: missing tag_name`);
	}
	const tag = release.tag_name;
	return { tag, version: tag.startsWith("v") ? tag.slice(1) : tag };
}

interface BunGlobalInstallLocations {
	globalDir?: string;
	globalBinDir?: string;
}

export function resolveBunGlobalNodeModulesDirFromLocations({
	globalDir,
	globalBinDir,
}: BunGlobalInstallLocations): string | undefined {
	if (globalDir && globalDir.length > 0) return path.join(globalDir, "node_modules");
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	return undefined;
}

interface MuslDetectionOptions {
	platform?: NodeJS.Platform;
	alpineRelease?: boolean;
	lddOutput?: string;
}

function detectLddOutput(): string | undefined {
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return undefined;
	}
}

function isMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}

export function isMuslLinuxForTest(options: Required<MuslDetectionOptions>): boolean {
	return isMuslLinux(options);
}

function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = isMuslLinux() ? "linux-musl" : "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	return `${BINARY_NAME}-${os}-${archName}`;
}

function resolveOmpPath(): string | undefined {
	return $which(BINARY_NAME) ?? undefined;
}

async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	try {
		const result = await $`${binaryPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: binaryPath };
		const output = result.text().trim();

		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: binaryPath };
	} catch {
		return { ok: false, path: binaryPath };
	}
}

async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	return await verifyBinaryAtPath(ompPath, expectedVersion);
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${BINARY_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		printVerifiedVersion(expectedVersion);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow(`You may need to reinstall: ${installerHint()}`));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak") ? ".bak" : entry.endsWith(".new") ? ".new" : undefined;
		if (!suffix) continue;

		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		const full = path.join(dir, entry);
		if (suffix === ".new") {
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${BINARY_NAME} binary`,
			);
		}

		backupReady = false;

		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

async function updateViaHomebrew(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating Homebrew formulae..."));
	const update = await $`brew update`.nothrow();
	if (update.exitCode !== 0) {
		throw new Error(`brew update failed with exit code ${update.exitCode}`);
	}

	console.log(chalk.dim("Updating via Homebrew..."));
	const args = buildHomebrewUpdateArgs(force);
	const result = await $`brew ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`brew ${args[0]} failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion);
}

async function updateViaMise(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating via mise..."));
	const args = buildMiseUpgradeArgs();
	const result = await $`mise ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion);
}

let updateAttemptSeq = 0;

export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		verifyInstalledVersion?: typeof verifyInstalledVersion;
	} = {},
): Promise<void> {
	const binaryName = options.binaryName ?? getBinaryName();

	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	const asset = await getReleaseBinaryAsset(expectedVersion, binaryName, options.fetchImpl, options.githubToken);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));

	await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion,
			verifyInstalledVersion: options.verifyInstalledVersion ?? verifyInstalledVersion,
		});

		await sweepStaleUpdateArtifacts(targetPath);
	});
	printVerifiedVersion(expectedVersion);
	console.log(chalk.dim(`Restart ${BINARY_NAME} to use the new version`));
}

function installerHint(): string {
	return `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh`;
}

export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		return;
	}

	try {
		const target = await resolveUpdateTarget();
		if (target.method === "nix") {
			console.log(chalk.yellow("This installation is managed by Nix and cannot update itself."));
			console.log(chalk.dim("Update the flake input or profile that provides proto, then rebuild."));
		} else if (target.method === "brew") {
			await updateViaHomebrew(release.version, opts.force);
		} else if (target.method === "mise") {
			await updateViaMise(release.version, opts.force);
		} else {
			if (target.replacesSymlink) {
				console.log(chalk.dim("Replacing the package-manager launcher with the standalone binary."));
			}
			await updateViaBinaryAt(target.path, release.version);
			if (target.replacesSymlink) {
				console.log(
					chalk.yellow(
						`This install is no longer managed by bun/npm. Removing the old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
					),
				);
			}
		}
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}
