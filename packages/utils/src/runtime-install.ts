import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as Module from "node:module";
import * as path from "node:path";
import { withFileLock } from "./file-lock";

const RUNTIME_CONDITIONS: Record<string, true> = { node: true, require: true, default: true };

const RUNTIME_EXTENSIONS: readonly string[] = [".js", ".cjs", ".mjs", ".json", ".node"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectConditionalTarget(target: unknown): string | null {
	if (typeof target === "string") return target;
	if (Array.isArray(target)) {
		for (const entry of target) {
			const resolved = selectConditionalTarget(entry);
			if (resolved) return resolved;
		}
		return null;
	}
	if (isRecord(target)) {
		for (const condition in target) {
			if (!RUNTIME_CONDITIONS[condition]) continue;
			const resolved = selectConditionalTarget(target[condition]);
			if (resolved) return resolved;
		}
	}
	return null;
}

function resolveFileTarget(pkgDir: string, relative: string): string | null {
	const base = path.join(pkgDir, relative);
	const candidates = [base, ...RUNTIME_EXTENSIONS.map(ext => base + ext)];
	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isFile()) return candidate;
			if (stat.isDirectory()) {
				const indexed = resolveFileTarget(candidate, "index");
				if (indexed) return indexed;
			}
		} catch {}
	}
	return null;
}

function resolveExportsEntry(
	pkgDir: string,
	exports: Record<string, unknown>,
	subpath: string | undefined,
): string | null {
	let subpathMap = false;
	for (const key in exports) {
		subpathMap = key === "." || key.startsWith("./");
		break;
	}
	if (subpathMap) {
		const key = subpath ? `./${subpath}` : ".";
		if (!(key in exports)) return null;
		const target = selectConditionalTarget(exports[key]);
		return target ? resolveFileTarget(pkgDir, target) : null;
	}

	if (subpath) return null;
	const target = selectConditionalTarget(exports);
	return target ? resolveFileTarget(pkgDir, target) : null;
}

export function splitBareSpecifier(specifier: string): { packageName: string; subpath: string | undefined } {
	const segments = specifier.split("/");
	const take = specifier.startsWith("@") ? 2 : 1;
	const packageName = segments.slice(0, take).join("/");
	const subpath = segments.length > take ? segments.slice(take).join("/") : undefined;
	return { packageName, subpath };
}

export function resolveRuntimeModule(runtimeNodeModules: string, specifier: string): string | null {
	const { packageName, subpath } = splitBareSpecifier(specifier);
	const pkgDir = path.join(runtimeNodeModules, ...packageName.split("/"));
	const manifest = readManifest(pkgDir);
	if (!manifest) return subpath ? resolveFileTarget(pkgDir, subpath) : null;

	const { exports } = manifest;
	if (typeof exports === "string" || isRecord(exports)) {
		const map = typeof exports === "string" ? { ".": exports } : exports;
		const resolved = resolveExportsEntry(pkgDir, map, subpath);
		if (resolved) return resolved;
	}
	if (subpath) return resolveFileTarget(pkgDir, subpath);
	if (typeof manifest.main === "string") {
		const resolved = resolveFileTarget(pkgDir, manifest.main);
		if (resolved) return resolved;
	}
	return resolveFileTarget(pkgDir, "index.js");
}

function readManifest(pkgDir: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface ModuleResolver {
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
}

interface ResolverRegistration {
	runtimeNodeModules: string;
	stubs: Record<string, string>;
}

const REGISTRY = Symbol.for("proto.runtimeModuleResolver.registry");
const PATCHED = Symbol.for("proto.runtimeModuleResolver.patched");

function resolverRegistry(): ResolverRegistration[] {
	const holder = globalThis as { [REGISTRY]?: ResolverRegistration[] };
	holder[REGISTRY] ??= [];
	return holder[REGISTRY];
}
function pathContains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parentFilename(parent: unknown): string | null {
	if (!isRecord(parent)) return null;
	const filename = parent.filename;
	return typeof filename === "string" ? filename : null;
}

export interface RuntimeResolverOptions {
	runtimeNodeModules: string;

	stubs?: Record<string, string>;
}

export function installRuntimeModuleResolver({ runtimeNodeModules, stubs = {} }: RuntimeResolverOptions): () => void {
	const registry = resolverRegistry();
	const existing = registry.find(entry => entry.runtimeNodeModules === runtimeNodeModules);
	if (existing) Object.assign(existing.stubs, stubs);
	else registry.push({ runtimeNodeModules, stubs: { ...stubs } });

	const resolver = (Module as unknown as { default?: ModuleResolver } & ModuleResolver).default ?? Module;
	const target = resolver as unknown as ModuleResolver & { [PATCHED]?: () => void };
	const uninstall = (): void => {
		const entries = resolverRegistry();
		const index = entries.findIndex(entry => entry.runtimeNodeModules === runtimeNodeModules);
		if (index !== -1) entries.splice(index, 1);
		if (entries.length === 0) target[PATCHED]?.();
	};
	if (target[PATCHED]) return uninstall;
	const pristine = target._resolveFilename;
	const original = pristine.bind(target);
	target._resolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown): string => {
		let stockResolved: string | null = null;
		let stockError: unknown;
		try {
			stockResolved = original(request, parent, isMain, options);
		} catch (error) {
			stockError = error;
		}
		const bare = !request.startsWith(".") && !request.startsWith("node:") && !path.isAbsolute(request);
		if (bare) {
			const parentFile = parentFilename(parent);
			for (const registration of resolverRegistry()) {
				const parentInRuntime = parentFile !== null && pathContains(registration.runtimeNodeModules, parentFile);
				if (parentInRuntime) {
					const stub = registration.stubs[request];
					if (stub) return stub;
					if (!stockResolved || !pathContains(registration.runtimeNodeModules, stockResolved)) {
						const fallback = resolveRuntimeModule(registration.runtimeNodeModules, request);
						if (fallback) return fallback;
					}
				}
				if (stockResolved) {
					const { packageName } = splitBareSpecifier(request);
					const pkgDir = path.join(registration.runtimeNodeModules, ...packageName.split("/"));
					if (!stockResolved.startsWith(pkgDir + path.sep)) continue;
					if (path.relative(pkgDir, stockResolved).split(path.sep).includes("node_modules")) continue;
					const expected = resolveRuntimeModule(registration.runtimeNodeModules, request);
					if (expected) return expected;
				} else {
					const stub = registration.stubs[request];
					if (stub) return stub;
					const fallback = resolveRuntimeModule(registration.runtimeNodeModules, request);
					if (fallback) return fallback;
				}
			}
		}
		if (stockResolved) return stockResolved;
		throw stockError;
	};
	target[PATCHED] = () => {
		target._resolveFilename = pristine;
		delete target[PATCHED];
	};
	return uninstall;
}

export interface RuntimeInstallSpec {
	dependencies: Record<string, string>;

	overrides?: Record<string, string>;

	trustedDependencies?: string[];
}

export type RuntimeInstallPhase = "initiate" | "download" | "done";

export interface EnsureRuntimeInstalledOptions {
	runtimeDir: string;
	install: RuntimeInstallSpec;

	probePackage?: string;

	onPhase?: (phase: RuntimeInstallPhase) => void;
	lockAttempts?: number;
	lockSleepMs?: number;
}

/** Best-effort cleanup for lock directories orphaned by older installers. */
async function removeLegacyInstallLock(runtimeDir: string): Promise<void> {
	try {
		const lockDir = `${runtimeDir}.lock`;
		const stat = await fsp.stat(lockDir).catch(() => null);
		if (stat?.isDirectory()) await fsp.rm(lockDir, { recursive: true, force: true });
	} catch {
		// The legacy directory is inert now that installs use a distinct lock path.
	}
}

export async function writeRuntimeManifest(runtimeDir: string, install: RuntimeInstallSpec): Promise<void> {
	await fsp.mkdir(runtimeDir, { recursive: true });
	const manifest: Record<string, unknown> = {
		private: true,
		type: "module",
		dependencies: install.dependencies,
	};
	if (install.overrides && Object.keys(install.overrides).length) manifest.overrides = install.overrides;
	if (install.trustedDependencies?.length) manifest.trustedDependencies = install.trustedDependencies;
	await Bun.write(path.join(runtimeDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

export async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

async function runRuntimeInstall(runtimeDir: string): Promise<void> {
	const proc = Bun.spawn([process.execPath, "install", "--cwd", runtimeDir, "--production"], {
		env: { ...Bun.env, BUN_BE_BUN: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode === 0) return;
	const output = `${stdout}\n${stderr}`.trim();
	throw new Error(
		`Failed to install runtime at ${runtimeDir} with ${process.execPath} install (exit ${exitCode}): ${output}`,
	);
}

export async function ensureRuntimeInstalled(options: EnsureRuntimeInstalledOptions): Promise<string> {
	const { runtimeDir, install, onPhase, lockAttempts = 240, lockSleepMs = 250 } = options;
	let probePackage = options.probePackage;
	if (!probePackage) {
		for (const name in install.dependencies) {
			probePackage = name;
			break;
		}
	}
	if (!probePackage) throw new Error(`Runtime install at ${runtimeDir} declares no dependencies`);
	const probeManifest = Bun.file(path.join(runtimeDir, "node_modules", ...probePackage.split("/"), "package.json"));
	if (await probeManifest.exists()) return runtimeDir;

	onPhase?.("initiate");
	await fsp.mkdir(path.dirname(runtimeDir), { recursive: true });
	await removeLegacyInstallLock(runtimeDir);
	return withFileLock(
		`${runtimeDir}.install`,
		async () => {
			if (await probeManifest.exists()) return runtimeDir;
			await writeRuntimeManifest(runtimeDir, install);
			onPhase?.("download");
			await runRuntimeInstall(runtimeDir);
			onPhase?.("done");
			return runtimeDir;
		},
		{ retries: lockAttempts, retryDelayMs: lockSleepMs },
	);
}
