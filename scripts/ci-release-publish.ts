#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	type GeneratedLeafPackage,
	generateNpmPackages,
	LEAF_TARGETS,
} from "../packages/natives/scripts/gen-npm-packages.ts";
import { fixEmitExtensions } from "./fix-emit-extensions.ts";

export interface PublishPackage {
	dir: string;
	kind: "typescript" | "native";

	preBuild?: readonly (readonly string[])[];

	extraFiles?: readonly string[];

	extraTypeConfigs?: readonly string[];

	publishJs?: boolean;

	publishBin?: Readonly<Record<string, string>>;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest {
	[key: string]: JsonValue | undefined;
	name?: string;
	version?: string;
	private?: boolean;
	license?: string;
	files?: JsonValue[];
	optionalDependencies?: JsonObject;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const MIT_LICENSE = "LICENSE";
const THIRD_PARTY_NOTICES = "THIRD-PARTY-NOTICES.txt";

export function legalPayloadFiles(license: string | undefined): string[] {
	switch (license) {
		case "MIT":
			return [MIT_LICENSE, THIRD_PARTY_NOTICES];
		default:
			throw new Error(`Unsupported package license: ${license ?? "<missing>"}`);
	}
}

export async function stageLegalPayloads(
	pkgDir: string,
	license: string | undefined,
	write: boolean,
	sourceRoot = repoRoot,
): Promise<string[]> {
	const files = legalPayloadFiles(license);
	for (const file of files) {
		const destination = path.join(pkgDir, file);
		if (await Bun.file(destination).exists()) continue;
		const source = path.join(sourceRoot, file);
		if (!(await Bun.file(source).exists())) {
			throw new Error(`Missing legal payload ${file} for ${path.relative(repoRoot, pkgDir)}`);
		}
		if (write) await fs.copyFile(source, destination);
	}
	return files;
}

function nativeLeafTagFromArgs(argv: readonly string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--native-leaf") {
			const tag = argv[i + 1];
			if (!tag) throw new Error("--native-leaf requires a native target tag");
			return tag;
		}
		if (arg.startsWith("--native-leaf=")) return arg.slice("--native-leaf=".length);
	}
	return null;
}

const nativeLeafTag = nativeLeafTagFromArgs(process.argv.slice(2));
export const packages: PublishPackage[] = [
	{ dir: "packages/utils", kind: "typescript" },
	{ dir: "packages/omptype", kind: "typescript", publishJs: true },
	{ dir: "packages/catalog", kind: "typescript" },
	{ dir: "packages/ai", kind: "typescript" },
	{ dir: "packages/natives", kind: "native" },
	{ dir: "packages/tui", kind: "typescript" },
	{ dir: "packages/hashline", kind: "typescript" },
	{ dir: "packages/agent", kind: "typescript" },
	{ dir: "packages/coding-agent", kind: "typescript", publishBin: { proto: "dist/cli.js" } },
];

function rewriteSrcToTypes(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/types/${rel}.d.ts`;
}

function rewriteSrcToJs(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/js/${rel}.js`;
}

function rewriteExports(exports: JsonValue, publishJs: boolean): JsonValue {
	if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return exports;
	const src = exports as JsonObject;
	const out: JsonObject = {};
	for (const key in src) {
		const val = src[key];
		if (publishJs && typeof val === "string" && val.startsWith("./src/")) {
			out[key] = { types: rewriteSrcToTypes(val), bun: val, default: rewriteSrcToJs(val) };
			continue;
		}
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof (val as JsonObject).types === "string" &&
			((val as JsonObject).types as string).startsWith("./src/")
		) {
			const srcTypes = (val as JsonObject).types as string;
			if (publishJs) {
				out[key] = { types: rewriteSrcToTypes(srcTypes), bun: srcTypes, default: rewriteSrcToJs(srcTypes) };
			} else {
				const next: JsonObject = { ...(val as JsonObject) };
				next.types = rewriteSrcToTypes(srcTypes);
				out[key] = next;
			}
		} else {
			out[key] = val;
		}
	}
	return out;
}

export async function rewriteManifest(pkg: PublishPackage, write: boolean): Promise<PackageManifest> {
	const manifestPath = path.join(repoRoot, pkg.dir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	if (pkg.publishBin) manifest.bin = { ...pkg.publishBin };
	if (typeof manifest.types === "string" && manifest.types.startsWith("./src/")) {
		manifest.types = rewriteSrcToTypes(manifest.types);
	}
	if (pkg.publishJs && typeof manifest.main === "string") {
		manifest.main = rewriteSrcToJs(manifest.main);
	}
	if (manifest.exports !== undefined) manifest.exports = rewriteExports(manifest.exports, pkg.publishJs === true);
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	for (const legalFile of legalPayloadFiles(manifest.license)) {
		if (!files.includes(legalFile)) files.push(legalFile);
	}
	const hasDist = files.includes("dist");
	if (!hasDist && !files.includes("dist/types")) files.push("dist/types");
	if (pkg.publishJs && !hasDist && !files.includes("dist/js")) files.push("dist/js");
	for (const extra of pkg.extraFiles ?? []) {
		if (!hasDist && !files.includes(extra)) files.push(extra);
	}
	manifest.files = files;
	if (write) await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	for (const argv of pkg.preBuild ?? []) {
		await $`${argv}`.cwd(pkgDir);
	}
	await $`bun x tsgo -p tsconfig.publish.json`.cwd(pkgDir);
	for (const cfg of pkg.extraTypeConfigs ?? []) {
		await $`bun x tsgo -p ${cfg}`.cwd(pkgDir);
	}
	if (pkg.publishJs) {
		await $`bun x tsgo -p tsconfig.publish.js.json`.cwd(pkgDir);
	}
	const sourceManifest = (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
	await stageLegalPayloads(pkgDir, sourceManifest.license, !isDryRun);

	await fixEmitExtensions(path.join(pkgDir, "dist/types"), ".d.ts");
	if (pkg.publishJs) {
		await fixEmitExtensions(path.join(pkgDir, "dist/js"), ".js");
	}
	return rewriteManifest(pkg, !isDryRun);
}

function buildNativeOptionalDependencies(version: string): JsonObject {
	const optionalDependencies: JsonObject = {};
	for (const target of LEAF_TARGETS) {
		optionalDependencies[`@oh-my-pi/pi-natives-${target.tag}`] = version;
	}
	return optionalDependencies;
}

export async function prepareNativeCorePackage(pkgDir: string, write: boolean): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	if (typeof manifest.version !== "string") throw new Error(`Missing version in ${manifestPath}`);
	const legalFiles = await stageLegalPayloads(pkgDir, manifest.license, write);
	manifest.optionalDependencies = buildNativeOptionalDependencies(manifest.version);
	manifest.files = [
		"native/index.js",
		"native/index.d.ts",
		"native/clipboard.js",
		"native/clipboard.d.ts",
		"native/desktop.js",
		"native/desktop.d.ts",
		"native/desktop-adapter.js",
		"native/desktop-adapter.d.ts",
		"native/loader-state.js",
		"native/loader-state.d.ts",
		"native/embedded-addon.js",
		"README.md",
		...legalFiles,
	];
	if (write) await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

export interface PackedTarball {
	name: string;
	version: string;
	path: string;
}

export async function inspectPackedTarball(tarballPath: string): Promise<PackedTarball> {
	const extracted = await $`tar -xOzf ${tarballPath} package/package.json`.quiet().nothrow();
	if (extracted.exitCode !== 0) {
		throw new Error(`Could not read packed manifest from ${tarballPath}: ${extracted.stderr.toString().trim()}`);
	}
	const manifest = JSON.parse(extracted.stdout.toString()) as PackageManifest;
	if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
		throw new Error(`Packed manifest is missing name/version: ${tarballPath}`);
	}
	return { name: manifest.name, version: manifest.version, path: tarballPath };
}

async function packAndPublish(dir: string, name: string): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun pm pack && npm publish --access public (${path.relative(repoRoot, dir)})`);
		return;
	}
	console.log(`Publishing ${name}…`);
	const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-pack-"));
	try {
		const packed = await $`bun pm pack --quiet --destination ${packDir}`.cwd(dir).quiet().nothrow();
		const packOutput = `${packed.stdout.toString()}${packed.stderr.toString()}`.trim();
		if (packed.exitCode !== 0) {
			if (packOutput) console.log(packOutput);
			process.exit(packed.exitCode ?? 1);
		}
		const tarball = (await fs.readdir(packDir)).find(entry => entry.endsWith(".tgz"));
		if (!tarball) throw new Error(`bun pm pack produced no tarball for ${name} (${path.relative(repoRoot, dir)})`);
		const packedTarball = await inspectPackedTarball(path.join(packDir, tarball));

		const preflight = await $`npm view ${`${packedTarball.name}@${packedTarball.version}`} version`.quiet().nothrow();
		if (preflight.exitCode === 0 && preflight.stdout.toString().trim()) {
			console.log(`Skipping ${packedTarball.name} (version already published)`);
			return;
		}
		const result = await $`npm publish ${packedTarball.path} --access public`.quiet().nothrow();
		const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
		if (output) console.log(output);
		if (result.exitCode !== 0) {
			if (isVersionAlreadyPublished(output)) {
				console.log(`Skipping ${packedTarball.name} (version already published)`);
				return;
			}
			process.exit(result.exitCode ?? 1);
		}
	} finally {
		await fs.rm(packDir, { recursive: true, force: true });
	}
}

export function isVersionAlreadyPublished(output: string): boolean {
	return (
		/npm (?:error|err!) code (E409|EPUBLISHCONFLICT)\b/i.test(output) ||
		/you cannot publish over (?:the )?previously published versions?\b/i.test(output)
	);
}

async function publishGeneratedLeafPackage(leaf: GeneratedLeafPackage): Promise<void> {
	await packAndPublish(leaf.dir, leaf.manifest.name);
}

async function publishNativeLeafPackage(tag: string): Promise<void> {
	const pkg = packages.find(candidate => candidate.kind === "native");
	if (!pkg) throw new Error("No native package configured");
	const pkgDir = path.join(repoRoot, pkg.dir);
	const coreManifest = (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
	if (typeof coreManifest.version !== "string") throw new Error(`Missing version in ${pkg.dir}/package.json`);
	await stageLegalPayloads(pkgDir, coreManifest.license ?? "MIT", !isDryRun);
	const leaves = await generateNpmPackages({
		packageDir: pkgDir,
		dryRun: isDryRun,
		version: coreManifest.version,
		tags: [tag],
	});
	const leaf = leaves[0];
	if (!leaf) throw new Error(`No native leaf generated for ${tag}`);
	await publishGeneratedLeafPackage(leaf);
}

async function publishNativePackage(pkg: PublishPackage): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const manifest = await prepareNativeCorePackage(pkgDir, !isDryRun);
	const name = manifest.name ?? path.basename(pkg.dir);
	if (isDryRun) {
		console.log(`DRY RUN native core manifest rewrite (${pkg.dir})`);
		console.log(
			JSON.stringify({ optionalDependencies: manifest.optionalDependencies, files: manifest.files }, null, "\t"),
		);
	}
	await packAndPublish(pkgDir, name);
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	if (pkg.kind === "native") {
		await publishNativePackage(pkg);
		return;
	}
	const pkgDir = path.join(repoRoot, pkg.dir);
	const manifest = await preparePackage(pkg);
	const name = manifest.name ?? path.basename(pkg.dir);
	if (manifest.private) {
		console.log(`Skipping ${name} (private)`);
		return;
	}
	await packAndPublish(pkgDir, name);
}

if (import.meta.main) {
	if (nativeLeafTag) {
		await publishNativeLeafPackage(nativeLeafTag);
	} else {
		for (const pkg of packages) {
			await publishPackage(pkg);
		}
	}
}
