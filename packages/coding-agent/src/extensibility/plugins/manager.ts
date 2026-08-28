import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
	getProjectPluginOverridesPath,
	isEnoent,
	logger,
} from "@oh-my-pi/pi-utils";
import { resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { loadExtensions } from "../extensions/loader";
import { refreshBunGitCache } from "./bun-git-cache";
import { type GitSource, parseGitUrl } from "./git-url";
import { resolvePluginManifestEntries } from "./loader";
import { getInstalledPluginsRegistryPath, readInstalledPluginsRegistry } from "./marketplace/registry";
import { parsePluginId } from "./marketplace/types";
import { extractPackageName, parsePluginSpec } from "./parser";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";

const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

const SHELL_METACHARS = /[;&|`$(){}<>\\\n\r\t]/;

function validatePackageName(name: string): void {
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(`Invalid package name: ${name}`);
	}

	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

function validateGitSpec(spec: string): void {
	if (SHELL_METACHARS.test(spec)) {
		throw new Error(`Invalid characters in plugin source: ${spec}`);
	}
}

function gitInstallSpec(original: string, source: GitSource): string {
	if (/^github:/i.test(original) || !/^[a-z]+:[^/]/i.test(original)) {
		return original;
	}
	if (!source.ref || source.repo.includes("#")) {
		return source.repo;
	}
	return `${source.repo}#${source.ref}`;
}

function findGitPackageName(source: GitSource, deps: Record<string, string>): string | undefined {
	for (const [key, value] of Object.entries(deps)) {
		if (typeof value !== "string") {
			continue;
		}
		const installedSource = parseGitUrl(value);
		if (installedSource && installedSource.host === source.host && installedSource.path === source.path) {
			return key;
		}
	}
	return undefined;
}

interface PluginPackageSnapshot {
	readonly actualName: string;
	readonly packagePath: string;
	readonly backupRoot: string;
	readonly backupPath: string;
}

interface RuntimePackageJson {
	name?: unknown;
	version: string;
	proto?: PluginManifest;
	pi?: PluginManifest;
}

export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;

	constructor(cwd: string = getProjectDir()) {
		this.#cwd = cwd;
	}

	async #readRuntimeConfigAt(lockPath: string): Promise<PluginRuntimeConfig> {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn("Failed to load plugin runtime config", { path: lockPath, error: String(err) });
			return normalizePluginRuntimeConfig({});
		}
	}

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		return this.#readRuntimeConfigAt(getPluginsLockfile());
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) return {};
			logger.warn("Failed to load project plugin overrides", { path: overridesPath, error: String(err) });
			return {};
		}
	}

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = getPluginsPackageJson();
		try {
			await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				await Bun.write(
					pkgJsonPath,
					JSON.stringify(
						{
							name: "proto-plugins",
							private: true,
							dependencies: {},
						},
						null,
						2,
					),
				);
				return;
			}
			throw err;
		}
	}

	async #readDeps(pkgJsonPath: string): Promise<Record<string, string>> {
		try {
			const json = await Bun.file(pkgJsonPath).json();
			return (json.dependencies as Record<string, string>) ?? {};
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
	}

	async #removeDependencyEntry(pkgJsonPath: string, name: string): Promise<void> {
		const pkgJson: { dependencies?: Record<string, string>; [key: string]: unknown } =
			await Bun.file(pkgJsonPath).json();
		if (!pkgJson.dependencies || !(name in pkgJson.dependencies)) {
			return;
		}
		delete pkgJson.dependencies[name];
		await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}

	#collectInstalledNames(deps: Record<string, string>, config: PluginRuntimeConfig): Set<string> {
		const installedNames = new Set<string>();
		for (const name of Object.keys(deps)) {
			installedNames.add(name);
		}
		for (const name of Object.keys(config.plugins)) {
			installedNames.add(name);
		}
		return installedNames;
	}
	async #resolvePlugin(
		fallbackName: string,
		pluginPath: string,
		config: PluginRuntimeConfig,
		projectOverrides: ProjectPluginOverrides,
	): Promise<InstalledPlugin | undefined> {
		let pluginPkg: RuntimePackageJson;
		try {
			pluginPkg = await Bun.file(path.join(pluginPath, "package.json")).json();
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw err;
		}

		const name = typeof pluginPkg.name === "string" && pluginPkg.name.length > 0 ? pluginPkg.name : fallbackName;
		const manifest: PluginManifest = pluginPkg.proto || pluginPkg.pi || { version: pluginPkg.version };
		manifest.version = pluginPkg.version;
		const runtimeState = config.plugins[name] || {
			version: pluginPkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;

		return {
			name,
			version: pluginPkg.version,
			path: pluginPath,
			manifest,
			enabledFeatures: projectOverrides.features?.[name] ?? runtimeState.enabledFeatures,
			enabled: runtimeState.enabled && !isDisabledInProject,
		};
	}
	async #collectMarketplaceRuntimePackageRealpaths(): Promise<Map<string, Set<string>>> {
		const registry = await readInstalledPluginsRegistry(getInstalledPluginsRegistryPath());
		const packageRealpaths = new Map<string, Set<string>>();
		await Promise.all(
			Object.entries(registry.plugins).flatMap(([pluginId, entries]) =>
				entries.map(async entry => {
					if ((entry.scope ?? "user") !== "user") return;
					const packageJsonPath = path.join(entry.installPath, "package.json");
					const parsedId = parsePluginId(pluginId);
					let packageName = parsedId?.name ?? pluginId;
					try {
						const pkg: RuntimePackageJson = await Bun.file(packageJsonPath).json();
						if (typeof pkg.name === "string" && pkg.name.length > 0) {
							packageName = pkg.name;
						}
					} catch (err) {
						if (!isEnoent(err)) {
							logger.debug("Failed to inspect marketplace plugin package path", {
								path: entry.installPath,
								error: String(err),
							});
							return;
						}
					}

					try {
						const installRealpath = await fs.promises.realpath(entry.installPath);
						const realpaths = packageRealpaths.get(packageName) ?? new Set<string>();
						realpaths.add(installRealpath);
						packageRealpaths.set(packageName, realpaths);
					} catch (err) {
						if (isEnoent(err)) return;
						throw err;
					}
				}),
			),
		);
		return packageRealpaths;
	}

	async #isMarketplaceRuntimeLink(
		name: string,
		deps: Record<string, string>,
		marketplaceRuntimeRealpaths: Map<string, Set<string>>,
		pluginPath: string,
	): Promise<boolean> {
		if (name in deps) return false;
		const realpaths = marketplaceRuntimeRealpaths.get(name);
		if (!realpaths) return false;
		try {
			return realpaths.has(await fs.promises.realpath(pluginPath));
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #snapshotInstalledPackage(actualName: string | undefined): Promise<PluginPackageSnapshot | null> {
		if (!actualName) {
			return null;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		try {
			await fs.promises.lstat(packagePath);
		} catch (err) {
			if (isEnoent(err)) {
				return null;
			}
			throw err;
		}

		const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-plugin-backup-"));
		const backupPath = path.join(backupRoot, "package");
		await fs.promises.cp(packagePath, backupPath, { recursive: true, verbatimSymlinks: true });
		return { actualName, packagePath, backupRoot, backupPath };
	}

	async #cleanupSnapshot(snapshot: PluginPackageSnapshot | null): Promise<void> {
		if (!snapshot) {
			return;
		}
		try {
			await fs.promises.rm(snapshot.backupRoot, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove plugin install backup", { plugin: snapshot.actualName, error: String(err) });
		}
	}

	async #rollbackFailedInstall(
		actualName: string | undefined,
		packageJsonBefore: string,
		bunLockBefore: string | null,
		snapshot: PluginPackageSnapshot | null,
	): Promise<void> {
		await Bun.write(getPluginsPackageJson(), packageJsonBefore);

		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		if (bunLockBefore === null) {
			await fs.promises.rm(bunLockPath, { force: true });
		} else {
			await Bun.write(bunLockPath, bunLockBefore);
		}

		if (!actualName) {
			return;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		await fs.promises.rm(packagePath, { recursive: true, force: true });
		if (!snapshot) {
			return;
		}
		await fs.promises.mkdir(path.dirname(snapshot.packagePath), { recursive: true });
		await fs.promises.cp(snapshot.backupPath, snapshot.packagePath, { recursive: true, verbatimSymlinks: true });
	}

	async #validateInstalledExtensions(plugin: InstalledPlugin): Promise<void> {
		const declaredEntries = resolvePluginManifestEntries(plugin, "extensions");
		if (declaredEntries.length === 0) {
			return;
		}

		const errors: string[] = [];
		const loadable: string[] = [];
		for (const { entry, resolvedPath } of declaredEntries) {
			if (resolvedPath === null) {
				errors.push(`${entry}: declared extension entry not found on disk`);
			} else {
				loadable.push(resolvedPath);
			}
		}

		if (loadable.length > 0) {
			const result = await loadExtensions(loadable, this.#cwd);
			for (const failure of result.errors) {
				errors.push(`${failure.path}: ${failure.error}`);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Plugin ${plugin.name} extension validation failed:\n${errors.join("\n")}`);
		}
	}

	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		const gitSource = parseGitUrl(spec.packageName);
		if (gitSource) {
			validateGitSpec(spec.packageName);
		} else {
			validatePackageName(spec.packageName);
		}

		await this.#ensurePackageJson();

		if (options.dryRun) {
			return {
				name: spec.packageName,
				version: "0.0.0-dryrun",
				path: "",
				manifest: { version: "0.0.0-dryrun" },
				enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
				enabled: true,
			};
		}
		const pkgJsonPath = getPluginsPackageJson();
		const packageJsonBefore = await Bun.file(pkgJsonPath).text();

		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		let bunLockBefore: string | null;
		try {
			bunLockBefore = await Bun.file(bunLockPath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			bunLockBefore = null;
		}
		const depsBefore = await this.#readDeps(pkgJsonPath);
		const packageInstallSpec = gitSource ? gitInstallSpec(spec.packageName, gitSource) : spec.packageName;
		const existingActualName = gitSource
			? findGitPackageName(gitSource, depsBefore)
			: extractPackageName(spec.packageName);
		const packageSnapshot = await this.#snapshotInstalledPackage(existingActualName);

		let actualName: string | undefined;
		try {
			if (gitSource && existingActualName) {
				const installedSource = parseGitUrl(depsBefore[existingActualName] ?? "");
				if (installedSource && installedSource.ref !== gitSource.ref) {
					await this.#removeDependencyEntry(pkgJsonPath, existingActualName);
				}
			}

			const installProc = Bun.spawn(["bun", "install", packageInstallSpec], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const [installExit, , installStderr] = await Promise.all([
				installProc.exited,
				new Response(installProc.stdout).text(),
				new Response(installProc.stderr).text(),
			]);
			if (installExit !== 0) {
				throw new Error(`bun install failed: ${installStderr}`);
			}

			if (gitSource) {
				const depsAfter = await this.#readDeps(pkgJsonPath);
				let resolved: string | undefined;
				for (const key of Object.keys(depsAfter)) {
					if (!(key in depsBefore)) {
						resolved = key;
						break;
					}
				}

				if (!resolved) {
					resolved = findGitPackageName(gitSource, depsAfter);
				}
				if (!resolved) {
					throw new Error(
						`Installed ${spec.packageName} but could not determine package name from plugins/package.json`,
					);
				}
				actualName = resolved;
			} else {
				actualName = extractPackageName(spec.packageName);
			}

			if (gitSource && existingActualName) {
				await refreshBunGitCache(gitSource, getPluginsDir());
				const updateProc = Bun.spawn(["bun", "update", actualName], {
					cwd: getPluginsDir(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				const [updateExit, , updateStderr] = await Promise.all([
					updateProc.exited,
					new Response(updateProc.stdout).text(),
					new Response(updateProc.stderr).text(),
				]);
				if (updateExit !== 0) {
					throw new Error(`bun update ${actualName} failed: ${updateStderr}`);
				}
			}

			const pkgPath = path.join(getPluginsNodeModules(), actualName, "package.json");
			let pkg: { name: string; version: string; proto?: PluginManifest; pi?: PluginManifest };
			try {
				pkg = await Bun.file(pkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(`Package installed but package.json not found at ${pkgPath}`);
				}
				throw err;
			}
			const manifest: PluginManifest = pkg.proto || pkg.pi || { version: pkg.version };
			manifest.version = pkg.version;

			let enabledFeatures: string[] | null = null;
			if (spec.features === "*") {
				enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
			} else if (Array.isArray(spec.features)) {
				if (spec.features.length > 0) {
					if (manifest.features) {
						for (const feat of spec.features) {
							if (!(feat in manifest.features)) {
								throw new Error(
									`Unknown feature "${feat}" in ${actualName}. Available: ${Object.keys(manifest.features).join(", ")}`,
								);
							}
						}
					}
					enabledFeatures = spec.features;
				} else {
					enabledFeatures = [];
				}
			}

			const installedPlugin: InstalledPlugin = {
				name: pkg.name,
				version: pkg.version,
				path: path.join(getPluginsNodeModules(), actualName),
				manifest,
				enabledFeatures,
				enabled: true,
			};

			await this.#validateInstalledExtensions(installedPlugin);

			const config = await this.#ensureConfigLoaded();
			config.plugins[pkg.name] = {
				version: pkg.version,
				enabledFeatures,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return installedPlugin;
		} catch (err) {
			try {
				await this.#rollbackFailedInstall(
					actualName ?? existingActualName,
					packageJsonBefore,
					bunLockBefore,
					packageSnapshot,
				);
			} catch (rollbackErr) {
				const message = err instanceof Error ? err.message : String(err);
				const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				throw new Error(`${message}\nRollback failed: ${rollbackMessage}`);
			}
			throw err;
		} finally {
			await this.#cleanupSnapshot(packageSnapshot);
		}
	}

	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const proc = Bun.spawn(["bun", "uninstall", name], {
			cwd: getPluginsDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const [exitCode] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(`npm uninstall failed for ${name}`);
		}

		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	async getPlugin(name: string, options: { path?: string } = {}): Promise<InstalledPlugin | undefined> {
		const [config, projectOverrides] = await Promise.all([this.#ensureConfigLoaded(), this.#loadProjectOverrides()]);
		if (options.path) {
			return this.#resolvePlugin(name, options.path, config, projectOverrides);
		}
		const projectPlugin = await this.#resolvePluginAtActiveProjectRoot(name, projectOverrides);
		const deps = await this.#readDeps(getPluginsPackageJson());
		const userPlugin = this.#collectInstalledNames(deps, config).has(name)
			? await this.#resolvePlugin(name, path.join(getPluginsNodeModules(), name), config, projectOverrides)
			: undefined;
		if (projectPlugin?.enabled || !userPlugin) {
			return projectPlugin;
		}
		return userPlugin;
	}

	async #resolvePluginAtActiveProjectRoot(
		name: string,
		projectOverrides: ProjectPluginOverrides,
	): Promise<InstalledPlugin | undefined> {
		const registryPath = await resolveActiveProjectRegistryPath(this.#cwd);
		if (!registryPath) return undefined;
		const projectRoot = path.dirname(registryPath);
		if (path.resolve(projectRoot) === path.resolve(getPluginsDir())) return undefined;
		const [projectDeps, projectConfig] = await Promise.all([
			this.#readDeps(path.join(projectRoot, "package.json")),
			this.#readRuntimeConfigAt(path.join(projectRoot, "proto-plugins.lock.json")),
		]);
		if (!this.#collectInstalledNames(projectDeps, projectConfig).has(name)) return undefined;
		return this.#resolvePlugin(name, path.join(projectRoot, "node_modules", name), projectConfig, projectOverrides);
	}

	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		let deps: Record<string, string> = {};
		try {
			const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
			deps = pkg.dependencies ?? {};
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		const [projectOverrides, config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#loadProjectOverrides(),
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const plugins: InstalledPlugin[] = [];
		const installedNames = this.#collectInstalledNames(deps, config);
		for (const name of installedNames) {
			const pluginPath = path.join(getPluginsNodeModules(), name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const plugin = await this.#resolvePlugin(name, pluginPath, config, projectOverrides);
			if (plugin) {
				plugins.push(plugin);
			}
		}

		return plugins;
	}

	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = path.resolve(this.#cwd, localPath);

		const pkgFilePath = path.join(absolutePath, "package.json");
		let pkg: { name?: string; version: string; proto?: PluginManifest; pi?: PluginManifest };
		try {
			pkg = await Bun.file(pkgFilePath).json();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`package.json not found at ${absolutePath}`);
			throw err;
		}
		if (!pkg.name) {
			throw new Error("package.json must have a name field");
		}

		await this.#ensurePluginsDir();

		const linkPath = path.join(getPluginsNodeModules(), pkg.name);

		if (pkg.name.startsWith("@")) {
			const scopeDir = path.join(getPluginsNodeModules(), pkg.name.split("/")[0]);
			await fs.promises.mkdir(scopeDir, { recursive: true });
		}

		try {
			const stats = await fs.promises.lstat(linkPath);
			if (stats.isSymbolicLink() || stats.isDirectory()) {
				await fs.promises.unlink(linkPath);
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		await fs.promises.symlink(absolutePath, linkPath);

		const manifest: PluginManifest = pkg.proto || pkg.pi || { version: pkg.version };
		manifest.version = pkg.version;

		const config = await this.#ensureConfigLoaded();
		config.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		await this.#saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}
		config.plugins[name].enabled = enabled;
		await this.#saveRuntimeConfig();
	}

	async getEnabledFeatures(name: string): Promise<string[] | null> {
		const config = await this.#ensureConfigLoaded();
		return config.plugins[name]?.enabledFeatures ?? null;
	}

	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}

		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find(p => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`Unknown feature "${feat}" in ${name}. Available: ${Object.keys(plugin.manifest.features).join(", ")}`,
						);
					}
				}
			}
		}

		config.plugins[name].enabledFeatures = features;
		await this.#saveRuntimeConfig();
	}

	async getPluginSettings(name: string): Promise<Record<string, unknown>> {
		const config = await this.#ensureConfigLoaded();
		const global = config.settings[name] || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		return { ...global, ...project };
	}

	async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.settings[name]) {
			config.settings[name] = {};
		}
		config.settings[name][key] = value;
		await this.#saveRuntimeConfig();
	}

	async deletePluginSetting(name: string, key: string): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (config.settings[name]) {
			delete config.settings[name][key];
			await this.#saveRuntimeConfig();
		}
	}

	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		const pluginsDir = getPluginsDir();
		const pluginsDirExists = fs.existsSync(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirExists ? "ok" : "warning",
			message: pluginsDirExists ? `Found at ${pluginsDir}` : "Not created yet",
		});

		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		let hasPkgJson = true;
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				hasPkgJson = false;
				pkg = {};
			} else {
				throw err;
			}
		}
		checks.push({
			name: "package_manifest",
			status: hasPkgJson ? "ok" : "warning",
			message: hasPkgJson ? "Found" : "Not created yet",
		});

		const nodeModulesPath = getPluginsNodeModules();
		const hasNodeModules = fs.existsSync(nodeModulesPath);
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : hasPkgJson ? "error" : "warning",
			message: hasNodeModules ? "Found" : "Missing (run npm install in plugins dir)",
		});

		const deps = pkg.dependencies || {};
		const [config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const installedNames = this.#collectInstalledNames(deps, config);

		for (const name of installedNames) {
			const pluginPath = path.join(nodeModulesPath, name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			const fromDependencies = name in deps;

			let pluginPkg: { version: string; description?: string; proto?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!fs.existsSync(pluginPath)) {
						if (fromDependencies) {
							const fixed = options.fix ? await this.#fixMissingPlugin() : false;
							checks.push({
								name: `plugin:${name}`,
								status: "error",
								message: "Missing from node_modules",
								fixed,
							});
						} else {
							const fixed = options.fix ? await this.#removeOrphanedConfig(name) : false;
							checks.push({
								name: `orphan:${name}`,
								status: "warning",
								message: "Plugin in config but not installed",
								fixed,
							});
						}
					} else {
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing package.json",
						});
					}
					continue;
				}
				throw err;
			}
			const hasManifest = !!(pluginPkg.proto || pluginPkg.pi);
			const manifest: PluginManifest | undefined = pluginPkg.proto || pluginPkg.pi;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No proto/pi manifest (not an proto plugin)`,
			});

			if (manifest?.tools) {
				const toolsPath = path.join(pluginPath, manifest.tools);
				if (!fs.existsSync(toolsPath)) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			if (manifest?.hooks) {
				const hooksPath = path.join(pluginPath, manifest.hooks);
				if (!fs.existsSync(hooksPath)) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			if (manifest?.extensions) {
				for (const extensionPath of manifest.extensions) {
					const resolvedExtensionPath = path.join(pluginPath, extensionPath);
					if (!fs.existsSync(resolvedExtensionPath)) {
						checks.push({
							name: `plugin:${name}:extension:${extensionPath}`,
							status: "error",
							message: `Extension entry "${extensionPath}" not found`,
						});
					}
				}
			}

			const runtimeState = config.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? await this.#removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		return checks;
	}

	async #fixMissingPlugin(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exit] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return exit === 0;
		} catch {
			return false;
		}
	}

	async #removeInvalidFeature(name: string, feat: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		const state = config.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter(f => f !== feat);
			await this.#saveRuntimeConfig();
			return true;
		}
		return false;
	}

	async #removeOrphanedConfig(name: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
		return true;
	}
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

export function validateSetting(value: unknown, schema: PluginSettingSchema): ValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
