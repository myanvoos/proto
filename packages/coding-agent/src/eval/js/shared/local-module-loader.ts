import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { maybeTrackedModule } from "./fs-tracker";
import { collectModuleSourceSpecifiers, stripTypeScriptSyntax } from "./rewrite-imports";

interface LocalModuleEntry {
	version: number;
	identifier: string;
	module: vm.SourceTextModule;

	loaded?: Promise<void>;
}

/** A non-local import: `id` keys the synthetic-module cache; `specifier` names fs modules for tracking. */
interface ExternalImport {
	id: string;
	specifier: string;
	load(options?: ImportCallOptions): Promise<unknown>;
}

const LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);

export class LocalModuleLoader {
	#context: vm.Context | undefined;
	#sessionTag: string;
	#moduleMtimes = new Map<string, number>();
	#moduleDeps = new Map<string, Set<string>>();
	#moduleParents = new Map<string, Set<string>>();
	#nextModuleVersion = 0;
	#moduleEntries = new Map<string, LocalModuleEntry>();
	#moduleBuilds = new Map<string, Promise<LocalModuleEntry>>();
	#externalModules = new Map<string, Promise<vm.Module>>();
	#requireCache = new LRUCache<string, NodeJS.Require>({ max: 128 });
	#modulePaths = new WeakMap<vm.Module, string>();
	#linkChain: Promise<void> = Promise.resolve();

	constructor(sessionId: string) {
		// Node's contextified global compiles modules against separate intrinsics (`[] instanceof Array`
		// fails across it); its default — the current context — already shares the kernel's globals.
		this.#context = typeof Bun !== "undefined" ? vm.createContext(globalThis) : undefined;
		// node:crypto rather than Bun.hash: the Node kernel runtime shares this module.
		this.#sessionTag = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	}

	async importForRun(cwd: string, source: string, options?: ImportCallOptions): Promise<unknown> {
		this.#refreshTrackedLocalModules();
		return await this.#importFromBase(cwd, source, options);
	}

	async importForModule(
		moduleUrl: string,
		source: string,
		cwd: string,
		options?: ImportCallOptions,
	): Promise<unknown> {
		this.#refreshTrackedLocalModules();
		const modulePath = this.filenameForUrl(moduleUrl);
		const baseDir = modulePath ? path.dirname(modulePath) : cwd;
		return await this.#importFromBase(baseDir, source, options);
	}

	requireForFile(moduleUrlOrPath: string | undefined, cwd: string): NodeJS.Require {
		const basePath = this.filenameForUrl(moduleUrlOrPath) ?? path.join(cwd, "[eval]");
		let cached = this.#requireCache.get(basePath);
		if (!cached) {
			cached = buildRequire(basePath);
			this.#requireCache.set(basePath, cached);
		}
		return cached;
	}

	filenameForUrl(moduleUrlOrPath: string | undefined): string | null {
		if (!moduleUrlOrPath) return null;
		if (moduleUrlOrPath.startsWith("file://")) return fileURLToPath(moduleUrlOrPath);
		return path.isAbsolute(moduleUrlOrPath) ? moduleUrlOrPath : null;
	}

	dirnameForUrl(moduleUrlOrPath: string | undefined, cwd: string): string {
		const filename = this.filenameForUrl(moduleUrlOrPath);
		return filename ? path.dirname(filename) : cwd;
	}

	async #importFromBase(baseDir: string, source: string, options?: ImportCallOptions): Promise<unknown> {
		const local = resolveLocalModulePath(baseDir, source);
		if (local) return (await this.#loadLocalModule(local)).namespace;
		const external = resolveExternalImport(baseDir, source);
		return maybeTrackedModule(external.specifier, await external.load(options));
	}

	async #ensureLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const existing = this.#moduleEntries.get(modulePath);
		if (existing) return existing;
		const building = this.#moduleBuilds.get(modulePath);
		if (building) return await building;
		const buildPromise = this.#buildLocalModule(modulePath).finally(() => {
			if (this.#moduleBuilds.get(modulePath) === buildPromise) this.#moduleBuilds.delete(modulePath);
		});
		this.#moduleBuilds.set(modulePath, buildPromise);
		return await buildPromise;
	}

	async #buildLocalModule(modulePath: string): Promise<LocalModuleEntry> {
		const rawSource = fs.readFileSync(modulePath, "utf8");
		const stripped = stripTypeScriptSyntax(rawSource, {
			force: isTypeScriptModulePath(modulePath),
			loader: stripLoaderForPath(modulePath),
		});
		const moduleDir = path.dirname(modulePath);
		const localDeps = new Set<string>();
		for (const specifier of await collectModuleSourceSpecifiers(stripped)) {
			const local = resolveLocalModulePath(moduleDir, specifier);
			if (local) localDeps.add(local);
		}
		this.#setModuleDependencies(modulePath, localDeps);
		this.#moduleMtimes.set(modulePath, fs.statSync(modulePath).mtimeMs);
		const version = ++this.#nextModuleVersion;
		const fileUrl = pathToFileURL(modulePath).href;
		const identifier = `${fileUrl}?proto-session=${this.#sessionTag}&v=${version}`;
		const wrappedSource = buildModuleSource(stripped, modulePath);
		const module = new vm.SourceTextModule(wrappedSource, {
			...(this.#context ? { context: this.#context } : {}),
			identifier,
			initializeImportMeta: meta => {
				Object.assign(meta, {
					url: fileUrl,
					path: modulePath,
					dir: moduleDir,
					filename: modulePath,
					dirname: moduleDir,
				});
			},
			importModuleDynamically: async specifier => {
				return await this.#resolveDynamicImport(modulePath, String(specifier));
			},
		});
		this.#modulePaths.set(module, modulePath);
		const entry: LocalModuleEntry = { version, identifier, module };
		this.#moduleEntries.set(modulePath, entry);
		return entry;
	}

	async #loadLocalModule(modulePath: string): Promise<vm.SourceTextModule> {
		const entry = await this.#ensureLocalModule(modulePath);
		entry.loaded ??= this.#linkAndEvaluate(entry, modulePath);
		await entry.loaded;
		return entry.module;
	}

	async #linkAndEvaluate(entry: LocalModuleEntry, modulePath: string): Promise<void> {
		const { module } = entry;
		try {
			await this.#serializeLink(async () => {
				if (module.status === "unlinked") await module.link(this.#linkResolve);
			});
			if (module.status === "linked") await module.evaluate();
		} catch (error) {
			this.#invalidateFailedLoad(modulePath);
			throw error;
		}
		if (module.status === "errored") {
			this.#invalidateFailedLoad(modulePath);
			throw module.error;
		}
	}

	#serializeLink<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#linkChain.then(run);
		this.#linkChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#linkResolve = async (specifier: string, referencingModule: vm.Module): Promise<vm.Module> => {
		const referrerPath = this.#modulePaths.get(referencingModule);
		if (referrerPath === undefined) {
			throw new Error(`local module loader: unknown referrer while linking "${specifier}"`);
		}
		const baseDir = path.dirname(referrerPath);
		const local = resolveLocalModulePath(baseDir, specifier);
		if (local) return (await this.#ensureLocalModule(local)).module;
		return await this.#ensureExternalModule(resolveExternalImport(baseDir, specifier));
	};

	async #resolveDynamicImport(referrerPath: string, specifier: string): Promise<vm.Module> {
		const baseDir = path.dirname(referrerPath);
		const local = resolveLocalModulePath(baseDir, specifier);
		if (local) return await this.#loadLocalModule(local);
		return await this.#ensureExternalModule(resolveExternalImport(baseDir, specifier));
	}

	#invalidateFailedLoad(rootPath: string): void {
		const stack = [rootPath];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === undefined || seen.has(current)) continue;
			seen.add(current);
			const entry = this.#moduleEntries.get(current);
			if (entry && entry.module.status === "evaluated") continue;
			this.#moduleEntries.delete(current);
			this.#moduleBuilds.delete(current);
			const deps = this.#moduleDeps.get(current);
			if (deps) for (const dep of deps) stack.push(dep);
			this.#moduleMtimes.delete(current);
			this.#setModuleDependencies(current, new Set());
			this.#moduleDeps.delete(current);
		}
	}

	async #ensureExternalModule(external: ExternalImport): Promise<vm.Module> {
		const existing = this.#externalModules.get(external.id);
		if (existing) return await existing;
		const loadPromise = (async () => {
			const namespace = maybeTrackedModule(external.specifier, await external.load()) as Record<string, unknown>;
			const exportNames = Object.keys(namespace);
			const module = new vm.SyntheticModule(
				exportNames,
				function () {
					for (const name of exportNames) {
						this.setExport(name, namespace[name]);
					}
				},
				{ ...(this.#context ? { context: this.#context } : {}), identifier: external.id },
			);
			await module.link(() => {
				throw new Error("Synthetic external modules have no dependencies");
			});
			await module.evaluate();
			return module;
		})();
		this.#externalModules.set(external.id, loadPromise);
		try {
			return await loadPromise;
		} catch (error) {
			if (this.#externalModules.get(external.id) === loadPromise) this.#externalModules.delete(external.id);
			throw error;
		}
	}

	#refreshTrackedLocalModules(): void {
		const changed: string[] = [];
		for (const [modulePath, previousMtime] of this.#moduleMtimes.entries()) {
			let nextMtime: number | undefined;
			try {
				nextMtime = fs.statSync(modulePath).mtimeMs;
			} catch {
				nextMtime = undefined;
			}
			if (nextMtime === previousMtime) continue;
			if (nextMtime === undefined) this.#moduleMtimes.delete(modulePath);
			else this.#moduleMtimes.set(modulePath, nextMtime);
			changed.push(modulePath);
		}
		for (const modulePath of changed) {
			this.#invalidateModuleAndParents(modulePath, new Set());
		}
	}

	#invalidateModuleAndParents(modulePath: string, seen: Set<string>): void {
		if (seen.has(modulePath)) return;
		seen.add(modulePath);
		this.#moduleEntries.delete(modulePath);
		this.#moduleBuilds.delete(modulePath);
		this.#moduleMtimes.delete(modulePath);
		const parents = [...(this.#moduleParents.get(modulePath) ?? [])];
		this.#setModuleDependencies(modulePath, new Set());
		this.#moduleDeps.delete(modulePath);
		for (const parent of parents) this.#invalidateModuleAndParents(parent, seen);
	}

	#setModuleDependencies(modulePath: string, deps: Set<string>): void {
		const previousDeps = this.#moduleDeps.get(modulePath);
		if (previousDeps) {
			for (const dep of previousDeps) {
				const parents = this.#moduleParents.get(dep);
				if (!parents) continue;
				parents.delete(modulePath);
				if (parents.size === 0) this.#moduleParents.delete(dep);
			}
		}
		this.#moduleDeps.set(modulePath, new Set(deps));
		for (const dep of deps) {
			const parents = this.#moduleParents.get(dep) ?? new Set<string>();
			parents.add(modulePath);
			this.#moduleParents.set(dep, parents);
		}
	}
}

function buildRequire(fromPath: string): NodeJS.Require {
	const basePath = path.extname(fromPath) ? fromPath : path.join(fromPath, "[eval]");
	return createRequire(pathToFileURL(basePath).href);
}

function buildModuleSource(source: string, modulePath: string): string {
	const moduleDir = path.dirname(modulePath);
	return [
		`const require = globalThis.__proto_get_require__(${JSON.stringify(pathToFileURL(modulePath).href)});`,
		`const __filename = ${JSON.stringify(modulePath)};`,
		`const __dirname = ${JSON.stringify(moduleDir)};`,
		source,
	].join("\n");
}

function resolveImportSpecifier(cwd: string, source: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
	try {
		return Bun.resolveSync(source, cwd);
	} catch {
		return source;
	}
}

/**
 * The managed local module a specifier names, if any. Bun resolves as Bun would (extension probing,
 * tsconfig paths); Node keeps Node's ESM rule that a relative specifier is the exact file.
 */
function resolveLocalModulePath(baseDir: string, source: string): string | undefined {
	if (!isLocalPathSpecifier(source)) return undefined;
	const resolved =
		typeof Bun !== "undefined" ? resolveImportSpecifier(baseDir, source) : path.resolve(baseDir, source);
	if (!isManagedLocalModulePath(resolved)) return undefined;
	if (typeof Bun === "undefined" && !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) return undefined;
	return resolved;
}

function resolveExternalImport(baseDir: string, source: string): ExternalImport {
	if (typeof Bun !== "undefined") {
		const target = normalizeImportTarget(resolveImportSpecifier(baseDir, source));
		return {
			id: target,
			specifier: target,
			load: options => (options !== undefined ? import(target, options) : import(target)),
		};
	}
	// Node resolves bare specifiers through the default ESM loader as if imported from a module in baseDir.
	const referrer = path.join(baseDir, "[eval]");
	return {
		id: `${pathToFileURL(referrer).href}\0${source}`,
		specifier: source,
		load: options => nodeImporter(referrer)(source, options),
	};
}

type NodeImporter = (specifier: string, options?: ImportCallOptions) => Promise<unknown>;
const nodeImporters = new LRUCache<string, NodeImporter>({ max: 128 });

function nodeImporter(referrer: string): NodeImporter {
	let importer = nodeImporters.get(referrer);
	if (!importer) {
		importer = new vm.Script("(specifier, options) => import(specifier, options)", {
			filename: referrer,
			importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
		}).runInThisContext() as NodeImporter;
		nodeImporters.set(referrer, importer);
	}
	return importer;
}

function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}

function isTypeScriptModulePath(modulePath: string): boolean {
	const ext = path.extname(modulePath);
	return ext === ".ts" || ext === ".tsx" || ext === ".mts";
}

function stripLoaderForPath(modulePath: string): "ts" | "tsx" {
	return path.extname(modulePath) === ".tsx" ? "tsx" : "ts";
}

function isManagedLocalModulePath(target: string): boolean {
	return (
		path.isAbsolute(target) &&
		LOCAL_MODULE_EXTENSIONS.has(path.extname(target)) &&
		!target.includes(`${path.sep}node_modules${path.sep}`)
	);
}

function normalizeImportTarget(target: string): string {
	if (path.isAbsolute(target)) return pathToFileURL(target).href;
	return target;
}
