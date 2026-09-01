import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";



const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];


function startupMarker(text) {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {

	}
}

function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "proto"))) {
		return path.join(xdgDataHome, "proto", "natives");
	}
	return path.join(os.homedir(), ".proto", "natives");
}

function resolveLeafPackageDir(platformTag) {
	try {
		const require_ = createRequire(import.meta.url);
		return path.dirname(require_.resolve(`@oh-my-pi/pi-natives-${platformTag}/package.json`));
	} catch {
		return null;
	}
}






function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}

function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}


function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	nativeDir,
	leafPackageDir = null,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const leafCandidates = leafPackageDir ? addonFilenames.map(filename => path.join(leafPackageDir, filename)) : [];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates];
	}
	return [...new Set(releaseCandidates)];
}



function parseReleaseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlderReleaseVersion(candidate, current) {
	const candidateParts = parseReleaseVersion(candidate);
	const currentParts = parseReleaseVersion(current);
	if (!candidateParts || !currentParts) return false;
	for (let index = 0; index < candidateParts.length; index++) {
		if (candidateParts[index] !== currentParts[index]) {
			return candidateParts[index] < currentParts[index];
		}
	}
	return false;
}





const NATIVE_CACHE_CLEANUP_GRACE_MS = 10 * 60_000;


function prepareNativeVersionDir(versionedDir) {
	fs.mkdirSync(versionedDir, { recursive: true });
	const now = new Date();
	fs.utimesSync(versionedDir, now, now);
}


function cleanupStaleNativeVersions({ nativesDir, currentVersion }) {
	const removed = [];
	let entries;
	try {
		entries = fs.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isOlderReleaseVersion(entry.name, currentVersion)) continue;
		const targetPath = path.join(nativesDir, entry.name);
		try {
			const stat = fs.statSync(targetPath);
			if (Date.now() - stat.mtimeMs < NATIVE_CACHE_CLEANUP_GRACE_MS) continue;
			fs.rmSync(targetPath, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {

		}
	}
	return removed;
}







const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";


function runCommand(command, args) {
	if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
		try {
			const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode === 0) {
				return result.stdout.toString("utf-8").trim();
			}
		} catch {

		}
	}
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
}

function getVariantOverride() {
	const value = process.env.PI_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

function detectAvx2Support() {
	if (process.arch !== "x64") {
		return false;
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {


		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
			const features = runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features && /\bAVX2\b/i.test(features)) return true;
		}
		return false;
	}

	return false;
}


function selectCpuVariant({ arch, override, env, detectAvx2 }) {
	if (arch !== "x64") return { variant: null, source: "non-x64" };
	if (override === "modern" || override === "baseline") {
		return { variant: override, source: "override" };
	}
	const cached = env[VARIANT_CACHE_ENV_KEY];
	if (cached === "modern" || cached === "baseline") {
		return { variant: cached, source: "cache" };
	}
	const variant = detectAvx2() ? "modern" : "baseline";
	return {
		variant,
		source: "detect",
		cacheEnvKey: VARIANT_CACHE_ENV_KEY,
		cacheEnvValue: variant,
	};
}

function resolveCpuVariant(override) {
	const result = selectCpuVariant({
		arch: process.arch,
		override,
		env: process.env,
		detectAvx2: detectAvx2Support,
	});
	if (result.cacheEnvKey) {
		process.env[result.cacheEnvKey] = result.cacheEnvValue;
	}
	return result.variant;
}

function selectEmbeddedAddonFile(selectedVariant) {
	if (!embeddedAddon) return null;
	const defaultFile = embeddedAddon.files.find(file => file.variant === "default") || null;
	if (process.arch !== "x64") return defaultFile || embeddedAddon.files[0] || null;
	if (selectedVariant === "modern") {
		return (
			embeddedAddon.files.find(file => file.variant === "modern") ||
			embeddedAddon.files.find(file => file.variant === "baseline") ||
			null
		);
	}
	return embeddedAddon.files.find(file => file.variant === "baseline") || null;
}

function readTarString(buffer, offset, length) {
	const end = Math.min(offset + length, buffer.length);
	let stringEnd = offset;
	while (stringEnd < end && buffer[stringEnd] !== 0) stringEnd++;
	return buffer.toString("utf8", offset, stringEnd);
}

function readTarOctal(buffer, offset, length) {
	const value = readTarString(buffer, offset, length).trim();
	if (!value) return 0;
	const parsed = Number.parseInt(value, 8);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid tar octal value: ${value}`);
	}
	return parsed;
}

function isZeroTarBlock(buffer, offset) {
	for (let index = 0; index < 512; index++) {
		if (buffer[offset + index] !== 0) return false;
	}
	return true;
}

function getTarEntryName(header) {
	const name = readTarString(header, 0, 100);
	const prefix = readTarString(header, 345, 155);
	return prefix ? `${prefix}/${name}` : name;
}

function isSafeEmbeddedAddonFilename(filename) {
	return filename.length > 0 && path.basename(filename) === filename && !filename.includes("/") && !filename.includes("\\");
}

function isEmbeddedAddonFileCurrent(targetPath, file) {
	try {
		const stat = fs.statSync(targetPath);
		if (!stat.isFile()) return false;
		return typeof file.size !== "number" || stat.size === file.size;
	} catch (err) {
		if (err && err.code === "ENOENT") return false;
		throw err;
	}
}

function writeEmbeddedAddonFile(targetPath, content) {
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(tempPath, content, { mode: 0o755 });
		fs.renameSync(tempPath, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {

		}
		throw err;
	}
}

function extractEmbeddedAddonArchive({ archivePath, files, targetDir }) {
	const pending = new Map();
	for (const file of files) {
		if (!isSafeEmbeddedAddonFilename(file.filename)) {
			throw new Error(`Unsafe embedded addon filename: ${file.filename}`);
		}
		const targetPath = path.join(targetDir, file.filename);
		if (!isEmbeddedAddonFileCurrent(targetPath, file)) {
			pending.set(file.filename, file);
		}
	}
	if (pending.size === 0) return [];

	const archive = zlib.gunzipSync(fs.readFileSync(archivePath));
	const writtenPaths = [];
	let offset = 0;

	while (offset + 512 <= archive.length) {
		if (isZeroTarBlock(archive, offset)) break;
		const header = archive.subarray(offset, offset + 512);
		const filename = getTarEntryName(header);
		const size = readTarOctal(header, 124, 12);
		const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		offset += 512;

		if (offset + size > archive.length) {
			throw new Error(`Truncated embedded addon archive entry: ${filename}`);
		}

		if (!isSafeEmbeddedAddonFilename(filename)) {
			throw new Error(`Unsafe embedded addon archive entry: ${filename}`);
		}
		if (typeflag !== "0") {
			throw new Error(`Unsupported embedded addon archive entry type ${typeflag}: ${filename}`);
		}

		const file = pending.get(filename);
		if (file) {
			if (typeof file.size === "number" && file.size !== size) {
				throw new Error(`Embedded addon size mismatch for ${filename}: expected ${file.size}, got ${size}`);
			}
			const targetPath = path.join(targetDir, filename);
			writeEmbeddedAddonFile(targetPath, archive.subarray(offset, offset + size));
			pending.delete(filename);
			writtenPaths.push(targetPath);
		}

		offset += Math.ceil(size / 512) * 512;
	}

	if (pending.size > 0) {
		throw new Error(`Embedded addon archive missing: ${[...pending.keys()].join(", ")}`);
	}

	return writtenPaths;
}

function maybeExtractEmbeddedAddon(ctx, errors) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return null;
	if (embeddedAddon.platformTag !== ctx.platformTag || embeddedAddon.version !== ctx.packageVersion) return null;

	const selectedEmbeddedFile = selectEmbeddedAddonFile(ctx.selectedVariant);
	if (!selectedEmbeddedFile) return null;
	const targetPath = path.join(ctx.versionedDir, selectedEmbeddedFile.filename);

	startupMarker("native:extractEmbeddedAddon:start");
	try {
		prepareNativeVersionDir(ctx.versionedDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon dir: ${message}`);
		return null;
	}

	if (embeddedAddon.archive) {
		try {
			extractEmbeddedAddonArchive({
				archivePath: embeddedAddon.archive.filePath,
				files: embeddedAddon.files,
				targetDir: ctx.versionedDir,
			});
			if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
				return targetPath;
			}
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): missing ${selectedEmbeddedFile.filename}`);
			return null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): ${message}`);
			return null;
		}
	}

	if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
		return targetPath;
	}
	if (!selectedEmbeddedFile.filePath) {
		errors.push(`embedded addon metadata missing file path for ${selectedEmbeddedFile.filename}`);
		return null;
	}

	try {
		const buffer = fs.readFileSync(selectedEmbeddedFile.filePath);
		fs.writeFileSync(targetPath, buffer);
		return targetPath;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon write (${selectedEmbeddedFile.filename}): ${message}`);
		return null;
	}
}



function isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedSentinel) {
	if (diskHasExpectedSentinel) return false;
	if (Object.keys(bindings).some(key => /^__piNativesV[A-Za-z0-9_]+$/.test(key))) return false;
	return (
		typeof bindings.countTokens === "function" &&
		typeof bindings.executeShell === "function" &&
		typeof bindings.visibleWidth === "function" &&
		typeof bindings.DesktopSession === "function" &&
		typeof bindings.DesktopSession.prototype?.capture === "function" &&
		typeof bindings.DesktopSession.prototype?.execute === "function" &&
		typeof bindings.DesktopSession.prototype?.close === "function"
	);
}

function validateLoadedBindings(ctx, bindings, candidate) {





	if (ctx.isWorkspaceLoad) return;
	if (typeof bindings[ctx.versionSentinelExport] === "function") return;










	const residentSentinel = Object.keys(bindings).find(
		key => key !== ctx.versionSentinelExport && /^__piNativesV[A-Za-z0-9_]+$/.test(key),
	);




	let diskHasExpectedSentinel = false;
	try {
		diskHasExpectedSentinel = fs.readFileSync(candidate).includes(ctx.versionSentinelExport);
	} catch {


	}
	if (isCompatiblePreSentinelNativeAddon(bindings, diskHasExpectedSentinel)) return;
	if (residentSentinel && diskHasExpectedSentinel) {
		const residentVersion = residentSentinel.slice("__piNativesV".length).replace(/_/g, ".");
		throw new Error(
			`Loaded ${candidate}, which exposes the @oh-my-pi/pi-natives@${residentVersion} version ` +
				`sentinel \`${residentSentinel}\` but not the @${ctx.packageVersion} sentinel ` +
				`\`${ctx.versionSentinelExport}\` this loader expects. proto was upgraded to ` +
				`${ctx.packageVersion} while this session was running; the ${residentVersion} addon is ` +
				"still resident in this process. Disk is already consistent — restart proto to pick up " +
				`${ctx.packageVersion} (reinstalling changes nothing).`,
		);
	}
	throw new Error(
		`Loaded ${candidate} but it does not expose the @oh-my-pi/pi-natives@${ctx.packageVersion} ` +
			`version sentinel \`${ctx.versionSentinelExport}\`. The .node file on disk is from a different ` +
			"release than this loader — reinstall to re-sync.",
	);
}


function installNativeTokioRuntime(bindings) {
	const install = bindings.__ompInstallTokioRuntime;
	if (typeof install !== "function") return;
	try {
		install();
		startupMarker("native:tokioRuntime:installed");
	} catch (err) {
		startupMarker(`native:tokioRuntime:failed:${err instanceof Error ? err.message : String(err)}`);
	}
}


function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `https://proto.sh${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @oh-my-pi/pi-natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Explicit targets: sh scripts/build-natives.sh <target> --dest packages/natives/native"
	);
}



function initLoaderContext(overrides = {}) {
	const platform = overrides.platform ?? process.platform;
	const platformTag = `${platform}-${process.arch}`;
	const packageVersion = packageJson.version;
	const nativeDir = overrides.nativeDir ?? path.join(import.meta.dir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const nativesDir = getNativesDir();
	const versionedDir = path.join(nativesDir, packageVersion);
	const userDataDir = path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary =
		overrides.isCompiledBinary ??
		detectCompiledBinary({
			embeddedAddon,
			env: process.env,
			importMetaUrl: import.meta.url,
		});
	const isWorkspaceLoad = !isCompiledBinary && !nativeDir.includes("/node_modules/");
	const leafPackageDir =
		isCompiledBinary || isWorkspaceLoad
			? null
			: overrides.leafPackageDir === undefined
				? resolveLeafPackageDir(platformTag)
				: overrides.leafPackageDir;
	const selectedVariant = resolveCpuVariant(getVariantOverride());
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch: process.arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;

	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		nativeDir,
		leafPackageDir,
		execDir,
		versionedDir,
		userDataDir,
	});








	const versionSentinelExport = `__piNativesV${packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`;

	return {
		platformTag,
		packageVersion,
		nativeDir,
		leafPackageDir,
		versionedDir,
		isCompiledBinary,
		selectedVariant,
		addonFilenames,
		addonLabel,
		candidates,
		versionSentinelExport,
		isWorkspaceLoad,
		nativesDir,
	};
}

export function loadNative() {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const errors = [];
	const embeddedCandidate = maybeExtractEmbeddedAddon(ctx, errors);
	const runtimeCandidates =
		typeof embeddedCandidate === "string" ? [embeddedCandidate, ...ctx.candidates] : ctx.candidates;

	for (const candidate of runtimeCandidates) {
		try {
			startupMarker(`native:require:${path.basename(candidate)}`);
			const bindings = require_(candidate);
			validateLoadedBindings(ctx, bindings, candidate);
			installNativeTokioRuntime(bindings);
			cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });
			startupMarker("native:loadNative:done");
			return bindings;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${message}`);
		}
	}

	if (!SUPPORTED_PLATFORMS.includes(ctx.platformTag)) {
		throw new Error(
			`Unsupported platform: ${ctx.platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load pi_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
