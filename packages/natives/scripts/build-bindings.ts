import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import { generateEnumExports } from "./gen-enums";

process.env.PCRE2_SYS_STATIC ??= "1";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(import.meta.dir, "../native");
const packageJsonPath = path.join(import.meta.dir, "../package.json");

const localAddon = resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detectHostAvx2Support(),
});
const effectiveVariant = localAddon.x64Variant;
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

if (!Bun.env.RUSTFLAGS) {
	if (effectiveVariant === "modern") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v3";
	} else if (effectiveVariant === "baseline") {
		Bun.env.RUSTFLAGS = "-C target-cpu=x86-64-v2";
	}
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		await fs.rename(tempPath, dest);
	} catch {
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				throw new Error(`Cannot replace ${path.basename(dest)}: ${(unlinkErr as Error).message}`);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(
		entry => entry.startsWith(`pi_natives.${process.platform}-${process.arch}`) && entry.endsWith(".node"),
	);

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${process.platform}-${process.arch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${process.platform}-${process.arch}:\n${formattedCandidates}`,
	);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	const sourcePath = path.join(outputDir, "index.d.ts");
	const destPath = path.join(nativeDir, "index.d.ts");
	try {
		await fs.copyFile(sourcePath, destPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to install generated index.d.ts: ${message}`);
	}
}

const canonicalAddonFilename = localAddon.filename;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives bindings for ${process.platform}-${process.arch}${variantSuffix} (local)…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(
	path.join(nativeDir, ".build", `${process.platform}-${process.arch}-${effectiveVariant ?? "default"}-local-`),
);

const require_ = createRequire(import.meta.url);
const napiManifestPath = require_.resolve("@napi-rs/cli/package.json");
const napiManifest: unknown = require_(napiManifestPath);
const napiBinEntry =
	typeof napiManifest === "object" &&
	napiManifest !== null &&
	"bin" in napiManifest &&
	typeof napiManifest.bin === "object" &&
	napiManifest.bin !== null &&
	"napi" in napiManifest.bin &&
	typeof napiManifest.bin.napi === "string"
		? napiManifest.bin.napi
		: null;
if (!napiBinEntry) {
	throw new Error(`@napi-rs/cli manifest at ${napiManifestPath} declares no string \`bin.napi\` entry`);
}
const napiBin = path.join(path.dirname(napiManifestPath), napiBinEntry);

const cargoProfile = Bun.env.PROTO_NATIVE_CARGO_PROFILE?.trim() || "local";

const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	buildOutputDir,
	"--profile",
	cargoProfile,
];

const BUILD_LOG_TAIL_LINES = 40;

function tailSection(label: string, text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed) return "";
	const lines = trimmed.split("\n");
	const capped = lines.length > BUILD_LOG_TAIL_LINES;
	const shown = capped ? lines.slice(-BUILD_LOG_TAIL_LINES) : lines;
	return `\n--- ${label}${capped ? ` (last ${BUILD_LOG_TAIL_LINES} lines)` : ""} ---\n${shown.join("\n")}`;
}

try {
	const buildResult = await $`${process.execPath} ${napiBin} ${napiArgs}`.nothrow();
	if (buildResult.exitCode !== 0) {
		const stdout = buildResult.stdout?.toString("utf-8") ?? "";
		const stderr = buildResult.stderr?.toString("utf-8") ?? "";
		const detail = `${tailSection("stdout", stdout)}${tailSection("stderr", stderr)}`;
		throw new Error(`napi build failed (exit ${buildResult.exitCode})${detail}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	await generateEnumExports();

	console.log("Bindings build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
