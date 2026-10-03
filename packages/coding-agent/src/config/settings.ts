import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import { resolveHyperlinkPolicy, setTerminalHyperlinks } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	hasFsCode,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
	pathIsWithin,
	procmgr,
	setWorktreesDir,
	toError,
} from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { JSONC, YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import type { CompactionMethod } from "../session/compaction-method-config";
import { AUTO_IMAGE_PROVIDER_ORDER, isImageProviderId } from "../tools/image-providers";
import { isSearchProviderId, SEARCH_PROVIDER_ORDER } from "../web/search/types";
import { stringifyYamlConfig } from "./config-file";
import {
	type ConfigIssue,
	formatUnknownStatusLineSegments,
	normalizeSettingsLayer,
	unknownStatusLineSegments,
} from "./settings-normalize";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

export type { ConfigIssue } from "./settings-normalize";
export type * from "./settings-schema";
export * from "./settings-schema";

export interface RawSettings {
	[key: string]: unknown;
}

type YamlLoadResult =
	| { kind: "missing" }
	| { kind: "loaded"; settings: RawSettings; source: string }
	| { kind: "invalid"; error: unknown; source: string; backupPath?: string }
	| { kind: "unreadable"; error: unknown };

/** The config.yml content a pending global change was made against; an unreadable file matches nothing. */
type YamlSnapshot = { kind: "missing" } | { kind: "content"; source: string } | { kind: "unreadable" };

type PendingYamlMutation = {
	snapshot: YamlSnapshot;
	baseValue: unknown;
};

function yamlSnapshotFromLoadResult(result: YamlLoadResult): YamlSnapshot {
	switch (result.kind) {
		case "missing":
		case "unreadable":
			return { kind: result.kind };
		case "loaded":
		case "invalid":
			return { kind: "content", source: result.source };
	}
}

function yamlSnapshotsMatch(left: YamlSnapshot, right: YamlSnapshot): boolean {
	if (left.kind === "unreadable" || left.kind !== right.kind) return false;
	return left.kind === "missing" || (right.kind === "content" && left.source === right.source);
}

/** A pending change applies unless the file changed since it was made and now holds a different value there. */
function pendingChangeApplies(
	mutation: PendingYamlMutation | undefined,
	onDisk: YamlSnapshot,
	onDiskValue: unknown,
): boolean {
	if (mutation === undefined || mutation.snapshot.kind === "unreadable") return false;
	return yamlSnapshotsMatch(mutation.snapshot, onDisk) || Bun.deepEquals(onDiskValue, mutation.baseValue);
}

type MainYamlReadResult = {
	settings: RawSettings | null;
	configPath: string | null;
};

type ProjectSettingsReadResult = {
	settings: RawSettings;
	fileSettings: RawSettings;
	shellPathSource: string | undefined;
};

type ConfigOverlayReadResult = {
	settings: RawSettings;
	shellPathSource: string | undefined;
};

interface SettingsOptions {
	cwd?: string;

	agentDir?: string;

	inMemory?: boolean;

	readOnly?: boolean;

	overrides?: Partial<Record<SettingPath, unknown>>;

	configFiles?: string[];
}

function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

const SETTING_PATH_SEGMENTS: Record<SettingPath, readonly string[]> = Object.fromEntries(
	(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingPath => [settingPath, settingPath.split(".")]),
) as unknown as Record<SettingPath, readonly string[]>;

function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	return normalized;
}

export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const invalidProviders: string[] = [];
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
			invalidProviders.push(provider);
			continue;
		}
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	if (invalidProviders.length > 0) {
		throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
	}
	return normalized;
}

const QUARANTINED_CONFIG_PATTERN = /^config\.ya?ml\.broken-/;

/** Linux MAXSYMLINKS: bounds a chain that turns cyclic after realpath() reported it dangling. */
const MAX_SYMLINK_HOPS = 40;

function fsError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

async function requireDirectory(dir: string, filePath: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(dir);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		throw fsError("ENOTDIR", `symlink target requires a directory but ${dir} is gone for ${filePath}`);
	}
	if (!stat.isDirectory()) {
		throw fsError("ENOTDIR", `symlink target requires a directory but ${dir} is not one for ${filePath}`);
	}
}

/**
 * Where writing through the dangling symlink `filePath` lands, so recreating the config keeps every user-managed
 * link in the chain. Each target is followed one physical component at a time like the kernel does: an existing
 * directory link is entered before a later `..` pops its real parent. Past the first missing component the rest is
 * joined lexically, and anything that would need to enter that component (`..`, a trailing `/`) fails with ENOTDIR
 * instead of landing a file somewhere the link never reads.
 */
async function resolveDanglingSymlinkTarget(filePath: string): Promise<string> {
	let current = filePath;
	for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
		let target: string;
		try {
			target = await fs.promises.readlink(current);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			// An intermediate link vanished mid-walk: land on the deepest resolved hop, never the chain head.
			return current === filePath ? path.resolve(filePath) : current;
		}
		let acc = path.parse(target).root;
		if (!path.isAbsolute(target)) {
			acc = path.dirname(current);
			try {
				acc = await fs.promises.realpath(acc);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		let frozen = false;
		for (const segment of target.slice(path.parse(target).root.length).split(/\/+/)) {
			if (segment === "" || segment === "." || segment === "..") {
				if (frozen) {
					throw fsError(
						"ENOTDIR",
						`symlink target needs an unresolved component to be a directory for ${filePath}`,
					);
				}
				await requireDirectory(acc, filePath);
				if (segment === "..") acc = path.dirname(acc);
				continue;
			}
			const candidate = path.join(acc, segment);
			if (frozen) {
				acc = candidate;
				continue;
			}
			try {
				acc = await fs.promises.realpath(candidate);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				acc = candidate;
				frozen = true;
			}
		}
		let isLink = false;
		try {
			isLink = (await fs.promises.lstat(acc)).isSymbolicLink();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (!isLink) return acc;
		current = acc;
	}
	throw fsError("ELOOP", `symlink chain for ${filePath} exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle)`);
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);
type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function expandTilde(p: string): string {
	return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	return pathIsWithin(normalizePathPrefix(prefix), path.resolve(cwd));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function migrateNestedLeafRename(
	raw: RawSettings,
	root: string,
	parent: string,
	oldLeaf: string,
	newLeaf: string,
	isLeafValue: (value: unknown) => boolean,
): void {
	const rootObj = isRecord(raw[root]) ? (raw[root] as Record<string, unknown>) : undefined;
	const nestedParent = rootObj?.[parent];
	const flatParent = raw[`${root}.${parent}`];
	const oldParentPath = `${root}.${parent}`;

	const candidates = [
		rootObj?.[newLeaf],
		raw[`${root}.${newLeaf}`],
		isRecord(nestedParent) ? nestedParent[oldLeaf] : undefined,
		raw[`${oldParentPath}.${oldLeaf}`],
	];
	const resolvedLeaf = candidates.find(isLeafValue);

	const recoveredParent =
		typeof nestedParent === "boolean" ? nestedParent : typeof flatParent === "boolean" ? flatParent : undefined;

	const ensureRoot = (): Record<string, unknown> => {
		const current = raw[root];
		if (isRecord(current)) return current;
		const created: Record<string, unknown> = {};
		raw[root] = created;
		return created;
	};

	if (resolvedLeaf !== undefined) {
		const target = ensureRoot();
		if (!isLeafValue(target[newLeaf])) {
			target[newLeaf] = resolvedLeaf;
		}
	}

	delete raw[`${oldParentPath}.${oldLeaf}`];
	delete raw[`${root}.${newLeaf}`];
	if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		const parentObj = (raw[root] as Record<string, unknown>)[parent] as Record<string, unknown>;
		delete parentObj[oldLeaf];
		if (Object.keys(parentObj).length === 0) {
			delete (raw[root] as Record<string, unknown>)[parent];
		}
	}

	if (recoveredParent !== undefined) {
		const target = ensureRoot();
		if (typeof target[parent] !== "boolean") {
			target[parent] = recoveredParent;
		}
	} else if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		delete (raw[root] as Record<string, unknown>)[parent];
	}
	delete raw[oldParentPath];
	if (isRecord(raw[root]) && Object.keys(raw[root] as Record<string, unknown>).length === 0) {
		delete raw[root];
	}
}

function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		resolved.push(...values);
	}

	return resolved;
}

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	#configFiles: string[] = [];

	#global: RawSettings = {};

	#project: RawSettings = {};

	#projectFileSettings: RawSettings = {};

	#quarantinedYamlTargets = new Map<string, string>();

	#configIssues: ConfigIssue[] = [];

	#reportedQuarantineBackups = new Set<string>();

	#configOverlay: RawSettings = {};

	#projectShellPathSource: string | undefined;

	#overlayShellPathSource: string | undefined;

	#overrides: RawSettings = {};

	#merged: RawSettings = {};

	#resolvedCache = new Map<SettingPath, unknown>();

	#modified = new Set<string>();

	#modifiedProjectModelRoles = new Set<string>();

	#modifiedGlobalModelRoles = new Set<string>();

	#modifiedPathMutations = new Map<string, PendingYamlMutation>();

	#projectSettingsWarningsSeen = new Set<string>();

	#modifiedGlobalModelRoleMutations = new Map<string, PendingYamlMutation>();

	#persistedMutationGeneration = 0;

	#savedRuntimeModelRoleOverrides = new Map<string, string | undefined>();

	#legacyLastChangelogVersion?: string;

	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;
	#projectSaveTimer?: NodeJS.Timeout;
	#projectSavePromise?: Promise<void>;

	#reloadFromDiskPromise?: Promise<void>;

	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
		if (options.configFiles) configFiles.push(...options.configFiles);
		this.#configFiles = configFiles.map(file => path.resolve(this.#cwd, expandTilde(file)));
		this.#persist = !options.inMemory && options.readOnly !== true;
		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, key.split("."), value);
			}

			this.#overrides = this.#migrateRawSettings(this.#overrides);
		}
	}

	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				clearBoundSettingsMethods();
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				globalInstancePromise = null;
				clearBoundSettingsMethods();
				throw error;
			},
		);
	}

	/** The initialized or in-flight global settings, without starting a writable load. */
	static get current(): Promise<Settings> | null {
		return globalInstancePromise;
	}

	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	static isolated(
		overrides: Partial<Record<SettingPath, unknown>> = {},
		options: { storage?: AgentStorage | null } = {},
	): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#storage = options.storage ?? null;
		instance.#rebuildMerged();
		return instance;
	}

	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	get<P extends SettingPath>(path: P): SettingValue<P> {
		if (this.#resolvedCache.has(path)) {
			return this.#resolvedCache.get(path) as SettingValue<P>;
		}

		const value = getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]);
		const resolved =
			value !== undefined ? (resolvePathScopedStringArray(path, value, this.#cwd) ?? value) : getDefault(path);
		this.#resolvedCache.set(path, resolved);
		return resolved as SettingValue<P>;
	}

	isConfigured(path: SettingPath): boolean {
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path]) !== undefined;
	}

	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const unknownSegments = unknownStatusLineSegments(path, value);
		if (unknownSegments.length > 0) throw new Error(`${path}: ${formatUnknownStatusLineSegments(unknownSegments)}`);
		const prev = this.get(path);
		const segments = path.split(".");
		if (!this.#globalWriteIsNoop(segments, value)) {
			this.#captureGlobalMutation(path, this.#modifiedPathMutations, getByPath(this.#global, segments));
			setByPath(this.#global, segments, value);
			this.#persistedMutationGeneration++;
			this.#modified.add(path);
			this.#rebuildMerged();
			this.#queueSave();
		}
		const next = this.get(path);

		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	/**
	 * Writes one entry of a record setting to config.yml (undefined deletes it). Built from the global layer alone so
	 * entries supplied by the project file, a --config overlay, or runtime overrides are not copied into config.yml.
	 */
	setRecordEntry<P extends SettingPath>(path: P, key: string, value: unknown): void {
		const current = getByPath(this.#global, SETTING_PATH_SEGMENTS[path]);
		const next: Record<string, unknown> = isRecord(current) ? { ...current } : {};
		if (value === undefined) delete next[key];
		else next[key] = value;
		this.set(path, next as SettingValue<P>);
	}

	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		if (path === "modelRoles") {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	clearOverride(path: SettingPath): void {
		if (path === "modelRoles") {
			this.#savedRuntimeModelRoleOverrides.clear();
		}
		const prev = this.get(path);
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown): void {
		if (Object.is(value, prev)) return;
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	#savesCancelled = false;

	cancelPendingSaves(): void {
		this.#savesCancelled = true;
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = undefined;
	}

	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#projectSaveTimer) {
			clearTimeout(this.#projectSaveTimer);
			this.#projectSaveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#projectSavePromise) {
			await this.#projectSavePromise;
		}
		if (this.#modified.size > 0 || this.#modifiedGlobalModelRoles.size > 0) {
			await this.#saveNow();
		}
		if (this.#modifiedProjectModelRoles.size > 0) {
			await this.#saveProjectNow();
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#configPath = this.#configPath;
		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		if (!this.#persist) cloned.#projectShellPathSource = this.#projectShellPathSource;
		cloned.#configFiles = [...this.#configFiles];
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overlayShellPathSource = this.#overlayShellPathSource;
		cloned.#overrides = this.#buildOriginalOverrides();
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
		return cloned;
	}

	async reloadFromDisk(): Promise<void> {
		if (!this.#persist) return;
		if (this.#reloadFromDiskPromise) return this.#reloadFromDiskPromise;

		const reload = this.#reloadPersistedLayers();
		this.#reloadFromDiskPromise = reload;
		try {
			await reload;
		} finally {
			if (this.#reloadFromDiskPromise === reload) {
				this.#reloadFromDiskPromise = undefined;
			}
		}
	}

	async #reloadPersistedLayers(): Promise<void> {
		for (;;) {
			await this.flush();
			const mutationGeneration = this.#persistedMutationGeneration;
			const previousSignaledValues = {
				modelRoles: this.get("modelRoles"),
			};
			const previousHookValues = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
				previousHookValues.set(key, this.get(key));
			}

			this.#configIssues = [];
			this.#reportedQuarantineBackups.clear();
			const [globalResult, projectResult, overlayResult] = await Promise.allSettled([
				this.#readExistingMainYaml(false),
				this.#readProjectSettings(false),
				this.#readConfigOverlays(false),
			]);
			if (mutationGeneration !== this.#persistedMutationGeneration) continue;
			if (globalResult.status === "rejected") throw globalResult.reason;
			if (projectResult.status === "rejected") throw projectResult.reason;
			if (overlayResult.status === "rejected") throw overlayResult.reason;

			this.#configPath = globalResult.value.configPath;
			this.#global = globalResult.value.settings ?? {};
			this.#project = projectResult.value.settings;
			this.#projectFileSettings = projectResult.value.fileSettings;
			this.#projectShellPathSource = projectResult.value.shellPathSource;
			this.#configOverlay = overlayResult.value.settings;
			this.#overlayShellPathSource = overlayResult.value.shellPathSource;
			this.#rebuildMerged();

			const nextModelRoles = this.get("modelRoles");
			if (!Bun.deepEquals(nextModelRoles, previousSignaledValues.modelRoles)) {
				this.#fireEffectiveSettingChanged("modelRoles", nextModelRoles, previousSignaledValues.modelRoles);
			}
			for (const [key, previous] of previousHookValues) {
				const next = this.get(key);
				if (!Bun.deepEquals(next, previous)) {
					SETTING_HOOKS[key]?.(next, previous);
				}
			}
			return;
		}
	}

	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		await this.flush();
		this.#restoreRuntimeModelRoleOverrides();
		const prevModelRoles = this.get("modelRoles");
		this.#cwd = normalized;
		if (this.#persist) {
			this.#project = await this.#loadProjectSettings();
		}
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prevModelRoles);
		this.#fireAllHooks();
	}

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getConfigIssues(): readonly ConfigIssue[] {
		return this.#configIssues;
	}

	#recordConfigIssues(issues: readonly ConfigIssue[]): void {
		for (const issue of issues) {
			const duplicate = this.#configIssues.some(
				existing => existing.kind === issue.kind && existing.source === issue.source && existing.key === issue.key,
			);
			if (!duplicate) this.#configIssues.push(issue);
		}
	}

	#normalizeLayer(raw: RawSettings, source: string, reportUnknown: boolean): RawSettings {
		const { settings, issues } = normalizeSettingsLayer(raw, { source, reportUnknown });
		if (reportUnknown) this.#recordConfigIssues(issues);
		return settings;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	getShellConfig() {
		const shell = this.get("shellPath");
		let configSource = this.#configPath ?? path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		if (Object.hasOwn(this.#project, "shellPath")) {
			configSource = this.#projectShellPathSource ?? "the active project configuration";
		}
		if (Object.hasOwn(this.#configOverlay, "shellPath")) {
			configSource = this.#overlayShellPathSource ?? "the active config overlay";
		}
		if (Object.hasOwn(this.#overrides, "shellPath")) {
			configSource = "the runtime settings override";
		}
		return procmgr.getShellConfig(shell, { configSource });
	}

	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRolesFromLayer(layer: RawSettings): Record<string, string> {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return {};

		const roles: Record<string, string> = {};
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) {
				roles[role] = modelId;
			}
		}
		return roles;
	}

	#modelRoleLayerOwns(layer: RawSettings, role: ModelRole | string): boolean {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return false;
		return Object.hasOwn(value, role);
	}

	#setRuntimeModelRoleOverrides(next: Record<string, string>): void {
		const prev = this.get("modelRoles");
		setByPath(this.#overrides, ["modelRoles"], next);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
	}

	#updateRuntimeModelRoleOverride(role: ModelRole | string, modelId: string | undefined): void {
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;

		const nextRuntimeOverride = this.#modelRolesFromLayer(this.#overrides);
		if (modelId === undefined) {
			delete nextRuntimeOverride[role];
		} else {
			nextRuntimeOverride[role] = modelId;
		}
		this.#setRuntimeModelRoleOverrides(nextRuntimeOverride);
	}

	#captureRuntimeModelRoleOverride(role: ModelRole | string): void {
		if (this.#savedRuntimeModelRoleOverrides.has(role)) return;
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeOverrides) || !Object.hasOwn(runtimeOverrides, role)) return;
		this.#savedRuntimeModelRoleOverrides.set(role, this.#modelRolesFromLayer(this.#overrides)[role]);
	}

	#restoreRuntimeModelRoleOverrides(): void {
		if (this.#savedRuntimeModelRoleOverrides.size === 0) return;
		const runtimeRoles = getByPath(this.#overrides, ["modelRoles"]);
		if (!isRecord(runtimeRoles)) {
			this.#savedRuntimeModelRoleOverrides.clear();
			return;
		}
		for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
			if (originalValue === undefined) {
				delete runtimeRoles[role];
			} else {
				runtimeRoles[role] = originalValue;
			}
		}
		this.#savedRuntimeModelRoleOverrides.clear();
	}

	#buildOriginalOverrides(): RawSettings {
		if (this.#savedRuntimeModelRoleOverrides.size === 0) {
			return structuredClone(this.#overrides);
		}
		const overrides = structuredClone(this.#overrides);
		const runtimeRoles = getByPath(overrides, ["modelRoles"]);
		if (!isRecord(runtimeRoles)) return overrides;
		for (const [role, originalValue] of this.#savedRuntimeModelRoleOverrides) {
			if (originalValue === undefined) {
				delete runtimeRoles[role];
			} else {
				runtimeRoles[role] = originalValue;
			}
		}
		return overrides;
	}

	#setProjectModelRoleValue(role: ModelRole | string, modelId: string | null): void {
		const prev = this.get("modelRoles");
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		const current: Record<string, unknown> = isRecord(projectRoles) ? { ...projectRoles } : {};
		current[role] = modelId;
		setByPath(this.#project, ["modelRoles"], current);
		this.#modifiedProjectModelRoles.add(role);
		this.#persistedMutationGeneration++;
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
		this.#queueProjectSave();
	}

	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const prev = this.get("modelRoles");
		if (!this.#globalWriteIsNoop(["modelRoles", role], modelId)) {
			const current = this.#modelRolesFromLayer(this.#global);
			this.#captureGlobalMutation(role, this.#modifiedGlobalModelRoleMutations, current[role]);
			if (modelId === undefined) {
				delete current[role];
			} else {
				current[role] = modelId;
			}

			setByPath(this.#global, ["modelRoles"], current);
			this.#modifiedGlobalModelRoles.add(role);
			this.#persistedMutationGeneration++;
			this.#rebuildMerged();
			this.#queueSave();
		}
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prev);
		if (this.isProjectModelRoleRuntimeOverrideActive(role)) {
			return;
		}
		this.#savedRuntimeModelRoleOverrides.delete(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}

	isProjectModelRoleRuntimeOverrideActive(role: ModelRole | string): boolean {
		if (this.get("modelRoleStorage") !== "project") return false;
		if (!this.#savedRuntimeModelRoleOverrides.has(role)) return false;
		return !!this.getProjectModelRole(role);
	}

	setProjectModelRole(role: ModelRole | string, modelId: string): void {
		this.#setProjectModelRoleValue(role, modelId);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, modelId);
	}

	clearProjectModelRole(role: ModelRole | string): void {
		this.#setProjectModelRoleValue(role, null);
		this.#captureRuntimeModelRoleOverride(role);
		this.#updateRuntimeModelRoleOverride(role, undefined);
	}

	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}

	getModelRoleBank(role: ModelRole | string): string[] | undefined {
		const banks: unknown = this.get("modelRoleBank");
		if (!isRecord(banks)) return undefined;
		const value = banks[role];
		if (!Array.isArray(value)) return undefined;
		const entries = value
			.filter((entry): entry is string => typeof entry === "string")
			.map(entry => entry.trim())
			.filter(Boolean);
		return entries.length > 0 ? entries : undefined;
	}

	getGlobalModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#global)[role];
		return modelId || undefined;
	}

	getProjectModelRole(role: ModelRole | string): string | undefined {
		const modelId = this.#modelRolesFromLayer(this.#project)[role];
		return modelId || undefined;
	}

	getModelRoleProvenance(role: ModelRole | string): "runtime" | "overlay" | "project" | "global" | "default" {
		if (this.#modelRoleLayerOwns(this.#overrides, role)) return "runtime";
		if (this.#modelRoleLayerOwns(this.#configOverlay, role)) return "overlay";
		if (this.#modelRoleLayerOwns(this.#projectSettingsForMerge(), role)) return "project";
		if (this.#modelRoleLayerOwns(this.#global, role)) return "global";
		return "default";
	}

	getModelRoleSource(role: ModelRole | string): "project" | "global" | "default" {
		if (this.getProjectModelRole(role)) return "project";
		if (this.getGlobalModelRole(role)) return "global";
		return "default";
	}

	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return {};

		const normalized: Record<string, string> = {};
		for (const role in roles) {
			if (!Object.hasOwn(roles, role)) continue;
			const modelId = modelRoleValueFromUnknown(roles[role]);
			if (modelId !== undefined) {
				normalized[role] = modelId;
			}
		}
		return normalized;
	}

	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
				this.#savedRuntimeModelRoleOverrides.delete(role);
			}
		}
		this.#setRuntimeModelRoleOverrides(next);
	}

	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	async #load(): Promise<Settings> {
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#persist ? this.#loadGlobalSettings() : Promise.resolve(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();

		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}
	async #loadGlobalSettings(): Promise<void> {
		this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		} else {
			await this.#migrateFromLegacy();
			this.#global = await this.#loadYaml(this.#configPath!);
		}
		await this.#seedLastChangelogVersionMarker();
	}

	async #loadReadOnly(): Promise<Settings> {
		const [globalResult, projectResult] = await Promise.allSettled([
			this.#loadExistingMainYaml(),
			this.#loadProjectSettings(),
		]);
		if (globalResult.status === "rejected") throw globalResult.reason;
		if (projectResult.status === "rejected") throw projectResult.reason;
		if (globalResult.value) {
			this.#global = globalResult.value;
		}

		this.#project = projectResult.value;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#rebuildMerged();
		return this;
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresentForStartup(filePath);
		return loaded ?? {};
	}

	async #loadYamlIfPresent(filePath: string, captureLegacyChangelogVersion = true): Promise<YamlLoadResult> {
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return { kind: "missing" };
			return { kind: "unreadable", error };
		}

		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			return { kind: "invalid", error, source: content };
		}
		if (parsed === null || parsed === undefined) {
			return { kind: "loaded", settings: {}, source: content };
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				kind: "invalid",
				error: new Error("Settings YAML must contain a mapping at the document root"),
				source: content,
			};
		}
		return {
			kind: "loaded",
			settings: this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion),
			source: content,
		};
	}

	async #resolveYamlWritePath(filePath: string): Promise<string> {
		const quarantinedTarget = this.#quarantinedYamlTargets.get(filePath);
		if (quarantinedTarget) return quarantinedTarget;
		try {
			return await fs.promises.realpath(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		try {
			if ((await fs.promises.lstat(filePath)).isSymbolicLink()) return await resolveDanglingSymlinkTarget(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return path.resolve(filePath);
	}

	async #withYamlWriteLock<T>(filePath: string, fn: (writePath: string) => Promise<T>): Promise<T> {
		const writePath = await this.#resolveYamlWritePath(filePath);
		return await withFileLock(writePath, async () => fn(writePath));
	}

	async #loadYamlIfPresentForStartup(filePath: string): Promise<RawSettings | null> {
		const result = await this.#loadYamlIfPresent(filePath);
		if (result.kind !== "invalid") {
			return this.#unwrapYamlLoadResult(filePath, result);
		}
		if (!this.#persist) {
			this.#reportInvalidConfig(filePath, result);
			return null;
		}
		return await this.#withYamlWriteLock(filePath, async writePath => {
			const locked = await this.#loadYamlIfPresent(writePath);
			if (locked.kind === "missing") {
				this.#reportInvalidConfig(filePath, result);
				return null;
			}
			if (locked.kind !== "invalid") {
				return this.#unwrapYamlLoadResult(filePath, locked);
			}
			const quarantined = await this.#quarantineInvalidYamlLocked(writePath, locked);
			this.#quarantinedYamlTargets.set(filePath, writePath);
			this.#reportInvalidConfig(filePath, quarantined);
			return null;
		});
	}

	#reportInvalidConfig(filePath: string, result: Extract<YamlLoadResult, { kind: "invalid" }>): void {
		const backupPath = result.backupPath;
		if (backupPath) this.#reportedQuarantineBackups.add(backupPath);
		const movedAside = backupPath
			? ` It was moved aside to ${backupPath}; merge anything you still need from it and delete it.`
			: "";
		this.#recordConfigIssues([
			{
				kind: "quarantined-config",
				source: filePath,
				message: `${filePath} is not valid YAML (${String(result.error)}); its settings are not in effect and defaults are being used.${movedAside}`,
			},
		]);
	}

	async #reportQuarantinedLeftovers(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!QUARANTINED_CONFIG_PATTERN.test(entry)) continue;
			const backupPath = path.join(dir, entry);
			if (this.#reportedQuarantineBackups.has(backupPath)) continue;
			this.#recordConfigIssues([
				{
					kind: "quarantined-config",
					source: backupPath,
					message: `${backupPath} holds a config an earlier run could not parse and moved aside; those settings are not in effect — merge what you need back into the config and delete the backup.`,
				},
			]);
		}
	}

	async #loadYamlIfPresentForWriteLocked(
		filePath: string,
		writePath: string,
	): Promise<{ settings: RawSettings | null; snapshot: YamlSnapshot }> {
		let result = await this.#loadYamlIfPresent(writePath);
		const snapshot = yamlSnapshotFromLoadResult(result);
		if (result.kind === "invalid") {
			result = await this.#quarantineInvalidYamlLocked(writePath, result);
			this.#quarantinedYamlTargets.set(filePath, writePath);
		}
		return { settings: this.#unwrapYamlLoadResult(filePath, result), snapshot };
	}

	#readYamlSnapshot(filePath: string): YamlSnapshot {
		try {
			return { kind: "content", source: fs.readFileSync(filePath, "utf8") };
		} catch (error) {
			return isEnoent(error) ? { kind: "missing" } : { kind: "unreadable" };
		}
	}

	#captureGlobalMutation(key: string, mutations: Map<string, PendingYamlMutation>, baseValue: unknown): void {
		if (!this.#persist || !this.#configPath) return;
		mutations.set(key, { snapshot: this.#readYamlSnapshot(this.#configPath), baseValue: structuredClone(baseValue) });
	}

	/** Whether writing `value` at `segments` would leave config.yml as is: both the global layer and the file hold it. */
	#globalWriteIsNoop(segments: readonly string[], value: unknown): boolean {
		if (!Bun.deepEquals(getByPath(this.#global, segments), value)) return false;
		if (!this.#persist || !this.#configPath) return true;
		const snapshot = this.#readYamlSnapshot(this.#configPath);
		if (snapshot.kind !== "content") return snapshot.kind === "missing" && value === undefined;
		let onDisk: unknown;
		try {
			onDisk = YAML.parse(snapshot.source);
		} catch {
			return false;
		}
		return Bun.deepEquals(isRecord(onDisk) ? getByPath(onDisk, segments) : undefined, value);
	}

	async #quarantineInvalidYamlLocked(
		filePath: string,
		result: Extract<YamlLoadResult, { kind: "invalid" }>,
	): Promise<Extract<YamlLoadResult, { kind: "invalid" }>> {
		const backupPath = `${filePath}.broken-${Date.now()}-${process.pid}-${randomUUID()}`;
		try {
			await fs.promises.rename(filePath, backupPath);
		} catch (error) {
			throw new Error(
				`Settings config is invalid and could not be moved aside: ${filePath}; refusing to overwrite it: ${String(error)}`,
			);
		}
		logger.warn("Settings: moved invalid config aside", {
			path: filePath,
			backupPath,
			error: String(result.error),
		});
		return { ...result, backupPath };
	}

	#unwrapYamlLoadResult(filePath: string, result: YamlLoadResult): RawSettings | null {
		switch (result.kind) {
			case "missing":
				return null;
			case "loaded":
				return result.settings;
			case "invalid":
				throw new Error(
					`Settings config is invalid: ${filePath}${result.backupPath ? ` (moved to ${result.backupPath})` : ""}: ${String(result.error)}`,
				);
			case "unreadable":
				throw new Error(`Failed to read settings config ${filePath}: ${String(result.error)}`);
		}
	}

	async #readExistingMainYaml(quarantineInvalid: boolean): Promise<MainYamlReadResult> {
		if (!this.#configPath) return { settings: null, configPath: null };
		await this.#reportQuarantinedLeftovers(this.#agentDir);
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const loaded = quarantineInvalid
				? await this.#loadYamlIfPresentForStartup(configPath)
				: this.#unwrapYamlLoadResult(configPath, await this.#loadYamlIfPresent(configPath, false));
			if (loaded) return { settings: this.#normalizeLayer(loaded, configPath, true), configPath };
		}
		return {
			settings: null,
			configPath: path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]),
		};
	}

	async #loadExistingMainYaml(): Promise<RawSettings | null> {
		const result = await this.#readExistingMainYaml(true);
		this.#configPath = result.configPath;
		return result.settings;
	}

	async #readProjectSettings(quarantineInvalid: boolean): Promise<ProjectSettingsReadResult> {
		const projectConfigPath = path.join(this.#cwd, ".proto", "config.yml");
		// Discovery caches file and directory reads process-wide; a reload must see project config edits.
		invalidateCapabilityFsCache(projectConfigPath);
		invalidateCapabilityFsCache(path.join(this.#cwd, ".proto", "settings.json"));
		const discoveryCwd = path.resolve(this.#cwd);
		invalidateCapabilityFsCache(path.join(discoveryCwd, ".claude", "settings.json"));
		let shellPathSource: string | undefined;
		let merged: RawSettings = {};
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: discoveryCwd });
			// Warnings span every level but embed their file's absolute path: surface only project ones (under the
			// cwd), once per distinct warning so reloads stay quiet.
			const cwdRoot = discoveryCwd.endsWith(path.sep) ? discoveryCwd : discoveryCwd + path.sep;
			const projectWarnings = result.warnings.filter(warning => warning.includes(cwdRoot));
			for (const warning of projectWarnings) {
				if (!this.#projectSettingsWarningsSeen.has(warning)) logger.warn(`Settings: ${warning}`);
			}
			this.#projectSettingsWarningsSeen = new Set(projectWarnings);
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
					if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
				}
			}
		} catch {
			shellPathSource = undefined;
		}
		const nativeProject = quarantineInvalid
			? await this.#loadYaml(projectConfigPath)
			: (this.#unwrapYamlLoadResult(projectConfigPath, await this.#loadYamlIfPresent(projectConfigPath, false)) ??
				{});
		const nativeModelRoles = getByPath(nativeProject, ["modelRoles"]);
		if (nativeModelRoles !== undefined) {
			merged = this.#deepMerge(merged, { modelRoles: nativeModelRoles });
		}
		await this.#reportQuarantinedLeftovers(path.dirname(projectConfigPath));
		this.#normalizeLayer(nativeProject, projectConfigPath, true);
		return {
			settings: this.#normalizeLayer(this.#migrateRawSettings(merged, quarantineInvalid), projectConfigPath, false),
			fileSettings: structuredClone(nativeProject),
			shellPathSource,
		};
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		const result = await this.#readProjectSettings(true);
		this.#projectFileSettings = result.fileSettings;
		this.#projectShellPathSource = result.shellPathSource;
		return result.settings;
	}

	async #readConfigOverlays(captureLegacyChangelogVersion = true): Promise<ConfigOverlayReadResult> {
		let shellPathSource: string | undefined;
		let settings: RawSettings = {};
		for (const filePath of this.#configFiles) {
			const overlay = await this.#loadOverlayYaml(filePath, captureLegacyChangelogVersion);
			settings = this.#deepMerge(settings, overlay);
			if (Object.hasOwn(overlay, "shellPath")) shellPathSource = filePath;
		}
		return { settings, shellPathSource };
	}

	async #loadConfigOverlays(): Promise<RawSettings> {
		const result = await this.#readConfigOverlays();
		this.#overlayShellPathSource = result.shellPathSource;
		return result.settings;
	}

	async #loadOverlayYaml(filePath: string, captureLegacyChangelogVersion = true): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			throw new CliUsageError(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${String(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new CliUsageError(`Failed to parse config overlay ${filePath}: ${String(error)}`);
		}
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new CliUsageError(`Config overlay must be a YAML mapping: ${filePath}`);
		}
		return this.#normalizeLayer(
			this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion),
			filePath,
			true,
		);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;
		let migratedSettingsJson = false;

		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		let legacyContent: string | undefined;
		try {
			legacyContent = await Bun.file(settingsJsonPath).text();
		} catch (error) {
			if (!isEnoent(error)) {
				this.#recordConfigIssues([
					{
						kind: "unmigrated-legacy",
						source: settingsJsonPath,
						message: `${settingsJsonPath} could not be read (${String(error)}); its settings were not migrated to config.yml and are not in effect.`,
					},
				]);
			}
		}
		if (legacyContent !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSONC.parse(legacyContent);
			} catch (error) {
				this.#recordConfigIssues([
					{
						kind: "unmigrated-legacy",
						source: settingsJsonPath,
						message: `${settingsJsonPath} is not valid JSON (${String(error)}); its settings were not migrated to config.yml and are not in effect.`,
					},
				]);
			}
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(
					settings,
					this.#normalizeLayer(this.#migrateRawSettings(parsed as RawSettings), settingsJsonPath, true),
				);
				migrated = true;
				migratedSettingsJson = true;
			} else if (parsed !== undefined) {
				this.#recordConfigIssues([
					{
						kind: "unmigrated-legacy",
						source: settingsJsonPath,
						message: `${settingsJsonPath} does not contain a JSON object; its settings were not migrated to config.yml and are not in effect.`,
					},
				]);
			}
		}

		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch (error) {
			logger.warn("Settings: failed to read legacy agent.db settings", { error: String(error) });
		}

		if (!migrated || Object.keys(settings).length === 0) return;
		try {
			await this.#writeYamlAtomically(this.#configPath, stringifyYamlConfig(settings));
			logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
		} catch (error) {
			logger.warn("Settings: failed to write migrated config.yml", { path: this.#configPath, error: String(error) });
			return;
		}
		// The rows were only a migration source: left behind, they would resurrect if config.yml is later deleted.
		try {
			this.#storage?.clearMigratedSettings();
		} catch (error) {
			logger.warn("Settings: failed to clear migrated agent.db settings", { error: String(error) });
		}
		// Archive the legacy file only once its settings are durable in config.yml.
		if (!migratedSettingsJson) return;
		try {
			await fs.promises.rename(settingsJsonPath, `${settingsJsonPath}.bak`);
		} catch (error) {
			logger.warn("Settings: failed to archive settings.json after migration", {
				path: settingsJsonPath,
				error: String(error),
			});
		}
	}

	#migrateRawSettings(raw: RawSettings, captureLegacyChangelogVersion = true): RawSettings {
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		if (captureLegacyChangelogVersion && typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;

		const startupObj = isRecord(raw.startup) ? (raw.startup as Record<string, unknown>) : undefined;
		const legacyCollapseChangelog = typeof raw.collapseChangelog === "boolean" ? raw.collapseChangelog : undefined;
		const flatChangelogMode = raw["startup.changelogMode"];
		const normalizedFlatChangelogMode =
			flatChangelogMode === "summary" || flatChangelogMode === "expanded" || flatChangelogMode === "hidden"
				? flatChangelogMode
				: undefined;
		if (legacyCollapseChangelog !== undefined || normalizedFlatChangelogMode !== undefined) {
			if (!startupObj) {
				raw.startup = {};
			}
			const target = raw.startup as Record<string, unknown>;
			if (target.changelogMode === undefined) {
				target.changelogMode =
					normalizedFlatChangelogMode ??
					(legacyCollapseChangelog !== undefined ? (legacyCollapseChangelog ? "summary" : "expanded") : undefined);
			}
		}
		delete raw.collapseChangelog;
		delete raw["startup.changelogMode"];

		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				delete raw.theme;
			} else {
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// features.unexpectedStopDetection: boolean -> none|mechanical|smart. `true` was the classified behavior
		// ("smart"); `false` drops the key so the "none" default applies.
		const featuresObj = isRecord(raw.features) ? (raw.features as Record<string, unknown>) : undefined;
		const legacyUnexpectedStop =
			typeof featuresObj?.unexpectedStopDetection === "boolean"
				? featuresObj.unexpectedStopDetection
				: typeof raw["features.unexpectedStopDetection"] === "boolean"
					? (raw["features.unexpectedStopDetection"] as boolean)
					: undefined;
		if (legacyUnexpectedStop !== undefined) {
			if (!featuresObj) {
				raw.features = {};
			}
			const target = raw.features as Record<string, unknown>;
			const current = target.unexpectedStopDetection;
			if (!legacyUnexpectedStop) {
				delete target.unexpectedStopDetection;
			} else if (!(typeof current === "string" && ["none", "mechanical", "smart"].includes(current))) {
				// A quoted-dotted legacy `true` must not clobber an enum already written under `features`.
				target.unexpectedStopDetection = "smart";
			}
			delete raw["features.unexpectedStopDetection"];
		}

		// Legacy "todo" settings section renamed to "checklist".
		const legacyTodoObj = isRecord(raw.todo) ? (raw.todo as Record<string, unknown>) : undefined;
		const legacyTodoFlatKeys = Object.keys(raw).filter(key => key.startsWith("todo."));
		if (legacyTodoObj || legacyTodoFlatKeys.length > 0) {
			if (!isRecord(raw.checklist)) {
				raw.checklist = {};
			}
			const target = raw.checklist as Record<string, unknown>;
			if (legacyTodoObj) {
				for (const [key, value] of Object.entries(legacyTodoObj)) {
					if (target[key] === undefined) {
						target[key] = value;
					}
				}
			}
			for (const key of legacyTodoFlatKeys) {
				const leaf = key.slice("todo.".length);
				if (target[leaf] === undefined) {
					target[leaf] = raw[key];
				}
				delete raw[key];
			}
			delete raw.todo;
		}

		const checklistObj = raw.checklist as Record<string, unknown> | undefined;
		if (checklistObj && typeof checklistObj.eager === "boolean") {
			checklistObj.eager = checklistObj.eager ? "always" : "default";
		}

		const compactionObj = isRecord(raw.compaction) ? raw.compaction : undefined;
		const configuredMethodOrder = compactionObj?.methodOrder ?? raw["compaction.methodOrder"];
		const legacyStrategy = compactionObj?.strategy ?? raw["compaction.strategy"];
		const legacyRemoteEnabled = compactionObj?.remoteEnabled ?? raw["compaction.remoteEnabled"];
		if (!Array.isArray(configuredMethodOrder)) {
			const remoteEnabled = legacyRemoteEnabled !== false;
			const strategy = legacyStrategy;
			let methodOrder: CompactionMethod[] | undefined;
			switch (strategy) {
				case "context-full":
				case "shake-summary":
				case "shake":
					methodOrder = remoteEnabled ? ["remote"] : [];
					break;
				case "off":
					methodOrder = [];
					break;
				default:
					if (legacyRemoteEnabled === false) {
						methodOrder = [];
					}
			}
			if (methodOrder) {
				const root = compactionObj ?? {};
				root.methodOrder = methodOrder;
				raw.compaction = root;
			}
		} else if (!compactionObj || compactionObj.methodOrder === undefined) {
			const root = compactionObj ?? {};
			root.methodOrder = configuredMethodOrder;
			raw.compaction = root;
		}
		if (compactionObj) {
			delete compactionObj.strategy;
			delete compactionObj.remoteEnabled;
		}
		delete raw["compaction.strategy"];
		delete raw["compaction.remoteEnabled"];
		delete raw["compaction.methodOrder"];

		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}

		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
			for (const key of ["leftSegments", "rightSegments"] as const) {
				const segments = statusLineObj[key];
				if (Array.isArray(segments)) {
					statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
				}
			}
			const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
			if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
				segmentOptions.mode = segmentOptions.plan_mode;
				delete segmentOptions.plan_mode;
			}
		}

		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];

		// Saved-reset autoRedeem booleans -> tri-state enums. Existing explicit
		// false keeps "do not run"; missing config falls through to "unset",
		// which asks before the first eligible provider-specific spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}
		if (typeof raw["codexResets.autoRedeem"] === "boolean") {
			raw["codexResets.autoRedeem"] = raw["codexResets.autoRedeem"] ? "yes" : "no";
		}

		if (
			!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {})) &&
			raw["power.sleepPrevention"] === undefined
		) {
			const powerObj = raw.power as Record<string, unknown> | undefined;
			const getFlag = (key: string): boolean | undefined => {
				const nested = powerObj?.[key];
				const flat = raw[`power.${key}`];
				const value = nested ?? flat;
				return typeof value === "boolean" ? value : undefined;
			};
			const idle = getFlag("preventIdleSleep");
			const system = getFlag("preventSystemSleep");
			const user = getFlag("declareUserActive");
			const display = getFlag("preventDisplaySleep");
			const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
			if (anySet) {
				const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
				const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
				powerRoot.sleepPrevention = mode;
				raw.power = powerRoot;
			}

			if (powerObj) {
				delete powerObj.preventIdleSleep;
				delete powerObj.preventSystemSleep;
				delete powerObj.declareUserActive;
				delete powerObj.preventDisplaySleep;
			}
			delete raw["power.preventIdleSleep"];
			delete raw["power.preventSystemSleep"];
			delete raw["power.declareUserActive"];
			delete raw["power.preventDisplaySleep"];
		}

		const tierObj = isRecord(raw.tier) ? raw.tier : {};
		let tierTouched = false;
		const setTier = (family: string, value: unknown): void => {
			if (value !== undefined && !(family in tierObj)) {
				tierObj[family] = value;
				tierTouched = true;
			}
		};
		if (typeof raw.serviceTier === "string") {
			switch (raw.serviceTier) {
				case "priority":
					setTier("openai", "priority");
					setTier("anthropic", "priority");
					setTier("google", "priority");
					break;
				case "openai-only":
					setTier("openai", "priority");
					break;
				case "claude-only":
					setTier("anthropic", "priority");
					break;
				case "auto":
				case "default":
				case "flex":
				case "scale":
					setTier("openai", raw.serviceTier);
					break;
			}
			delete raw.serviceTier;
		}
		const mapInheritTier = (value: unknown): unknown =>
			value === "openai-only" || value === "claude-only" ? "priority" : value;
		if ("serviceTierSubagent" in raw) {
			setTier("subagent", mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;
		migrateNestedLeafRename(
			raw,
			"dev",
			"autoqa",
			"consent",
			"autoqaConsent",
			value => value === "unset" || value === "granted" || value === "denied",
		);
		migrateNestedLeafRename(
			raw,
			"checklist",
			"reminders",
			"max",
			"remindersMax",
			value => typeof value === "number" && Number.isFinite(value),
		);

		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj) {
			delete toolsObj.discoveryMode;
			delete toolsObj.essentialOverride;
		}
		delete raw["tools.discoveryMode"];
		delete raw["tools.essentialOverride"];
		const mcpObj = raw.mcp as Record<string, unknown> | undefined;
		if (mcpObj) {
			delete mcpObj.discoveryMode;
			delete mcpObj.discoveryDefaultServers;
		}
		delete raw["mcp.discoveryMode"];
		delete raw["mcp.discoveryDefaultServers"];

		const providerPrefsObj = raw.providers as Record<string, unknown> | undefined;
		const migrateProviderPreference = (
			legacyKey: string,
			orderKey: string,
			expand: (value: string) => string[] | undefined,
		): void => {
			const flatLegacyKey = `providers.${legacyKey}`;
			const legacy = providerPrefsObj?.[legacyKey] ?? raw[flatLegacyKey];
			if (legacy === undefined) return;
			const existingOrder = providerPrefsObj?.[orderKey] ?? raw[`providers.${orderKey}`];
			const orderAlreadySet = Array.isArray(existingOrder) && existingOrder.length > 0;
			if (!orderAlreadySet && typeof legacy === "string") {
				const expanded = expand(legacy);
				if (expanded) {
					const root = providerPrefsObj ?? {};
					root[orderKey] = expanded;
					raw.providers = root;
				}
			}
			if (providerPrefsObj) delete providerPrefsObj[legacyKey];
			delete raw[flatLegacyKey];
		};
		migrateProviderPreference("webSearch", "webSearchOrder", value =>
			value !== "auto" && isSearchProviderId(value)
				? [value, ...SEARCH_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);
		migrateProviderPreference("image", "imageOrder", value =>
			value !== "auto" && isImageProviderId(value)
				? [value, ...AUTO_IMAGE_PROVIDER_ORDER.filter(id => id !== value)]
				: undefined,
		);

		const exaObj = isRecord(raw.exa) ? raw.exa : undefined;
		const exaEnabledValues = [
			exaObj?.enabled,
			raw["exa.enabled"],
			exaObj?.enableSearch,
			raw["exa.enableSearch"],
		].filter((value): value is boolean => typeof value === "boolean");
		const hasFlatExaSetting =
			"exa.enabled" in raw ||
			"exa.enableSearch" in raw ||
			"exa.enableResearcher" in raw ||
			"exa.enableWebsets" in raw;
		if (exaObj || hasFlatExaSetting) {
			const exaRoot = exaObj ?? {};
			if (exaEnabledValues.length > 0) {
				exaRoot.enabled = exaEnabledValues.every(Boolean);
			}
			delete exaRoot.enableSearch;
			delete exaRoot.enableResearcher;
			delete exaRoot.enableWebsets;
			if (Object.keys(exaRoot).length > 0) {
				raw.exa = exaRoot;
			} else {
				delete raw.exa;
			}
			delete raw["exa.enabled"];
			delete raw["exa.enableSearch"];
			delete raw["exa.enableResearcher"];
			delete raw["exa.enableWebsets"];
		}

		const computerObj = isRecord(raw.computer) ? raw.computer : undefined;
		if (computerObj && "backend" in computerObj) {
			delete computerObj.backend;
			if (Object.keys(computerObj).length === 0) {
				delete raw.computer;
			}
		}
		delete raw["computer.backend"];

		return raw;
	}

	async #seedLastChangelogVersionMarker(): Promise<void> {
		const legacy = this.#legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(this.#agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}

	async #writeYamlAtomically(filePath: string, content: string): Promise<void> {
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		let removeTemp = false;
		try {
			const handle = await fs.promises.open(tempPath, "wx", 0o600);
			removeTemp = true;
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			try {
				await fs.promises.rename(tempPath, filePath);
			} catch (error) {
				if (!hasFsCode(error, "EPERM")) throw error;
				await this.#replaceYamlAfterEperm(tempPath, filePath, error);
			}
			removeTemp = false;
		} finally {
			if (removeTemp) {
				await fs.promises.rm(tempPath, { force: true }).catch(() => {});
			}
		}
	}
	async #replaceYamlAfterEperm(tempPath: string, filePath: string, renameError: unknown): Promise<void> {
		const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
		try {
			await fs.promises.rename(filePath, backupPath);
		} catch (error) {
			if (isEnoent(error)) {
				await fs.promises.rename(tempPath, filePath);
				return;
			}
			throw renameError;
		}

		try {
			await fs.promises.rename(tempPath, filePath);
		} catch (replaceError) {
			try {
				await fs.promises.rename(backupPath, filePath);
			} catch (rollbackError) {
				throw new Error(
					`Failed to replace settings file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${toError(rollbackError).message})`,
					{ cause: toError(renameError) },
				);
			}
			throw replaceError;
		}

		try {
			await fs.promises.rm(backupPath);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Settings: failed to remove atomic-write backup", {
					path: filePath,
					backupPath,
					error: toError(error).message,
				});
			}
		}
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			const previousSave = this.#savePromise;
			const savePromise = previousSave ? previousSave.then(() => this.#saveNow()) : this.#saveNow();
			this.#savePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#savePromise === savePromise) {
						this.#savePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || !this.#configPath) return;
		if (this.#modified.size === 0 && this.#modifiedGlobalModelRoles.size === 0) return;

		const configPath = this.#configPath;
		const modifiedPaths = [...this.#modified];
		const modifiedModelRoles = [...this.#modifiedGlobalModelRoles];
		const modifiedPathMutations = new Map(this.#modifiedPathMutations);
		const modifiedModelRoleMutations = new Map(this.#modifiedGlobalModelRoleMutations);
		const globalRolesAtStart = this.#modelRolesFromLayer(this.#global);
		const previousModelRoles = this.get("modelRoles");
		const previousHookValues = new Map<SettingPath, unknown>();
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			previousHookValues.set(key, this.get(key));
		}
		this.#modified.clear();
		this.#modifiedGlobalModelRoles.clear();
		this.#modifiedPathMutations.clear();
		this.#modifiedGlobalModelRoleMutations.clear();

		try {
			await this.#withYamlWriteLock(configPath, async writePath => {
				const loaded = await this.#loadYamlIfPresentForWriteLocked(configPath, writePath);
				const current =
					loaded.settings ?? (this.#quarantinedYamlTargets.has(configPath) ? structuredClone(this.#global) : {});
				// Compare against the file as the runtime reads it, so a hand-written spelling of the captured value
				// (e.g. `on` for true) does not read as an external edit.
				const currentNormalized = this.#normalizeLayer(current, configPath, false);
				let shouldWrite = false;

				// A pending change loses to a later external edit of the same setting; disjoint edits still merge.
				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const onDiskValue = getByPath(currentNormalized, segments);
					if (!pendingChangeApplies(modifiedPathMutations.get(modPath), loaded.snapshot, onDiskValue)) {
						logger.warn("Settings: skipped stale change after external config edit", {
							path: configPath,
							setting: modPath,
						});
						continue;
					}
					setByPath(current, segments, getByPath(this.#global, segments));
					shouldWrite = true;
				}

				const latestGlobalRoles = this.#modelRolesFromLayer(this.#global);
				const rolesToPreserve = new Set(this.#modifiedGlobalModelRoles);
				for (const role in globalRolesAtStart) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				for (const role in latestGlobalRoles) {
					if (globalRolesAtStart[role] !== latestGlobalRoles[role]) {
						rolesToPreserve.add(role);
					}
				}
				const currentRoles = getByPath(current, ["modelRoles"]);
				const currentRoleValues: Record<string, unknown> = isRecord(currentRoles) ? currentRoles : {};
				const rolesToApply = modifiedModelRoles.filter(role => {
					const onDiskValue = getByPath(currentNormalized, ["modelRoles", role]);
					if (pendingChangeApplies(modifiedModelRoleMutations.get(role), loaded.snapshot, onDiskValue))
						return true;
					logger.warn("Settings: skipped stale change after external config edit", {
						path: configPath,
						setting: `modelRoles.${role}`,
					});
					return false;
				});
				if (rolesToApply.length > 0 || rolesToPreserve.size > 0) {
					const mergedRoles: Record<string, unknown> = { ...currentRoleValues };
					for (const role of rolesToApply) {
						if (Object.hasOwn(globalRolesAtStart, role)) {
							mergedRoles[role] = globalRolesAtStart[role];
						} else {
							delete mergedRoles[role];
						}
					}
					for (const role of rolesToPreserve) {
						if (Object.hasOwn(latestGlobalRoles, role)) {
							mergedRoles[role] = latestGlobalRoles[role];
						} else {
							delete mergedRoles[role];
						}
					}
					setByPath(current, ["modelRoles"], mergedRoles);
					shouldWrite = true;
				}

				if (shouldWrite) {
					// The merge can reproduce the file exactly (a change reverted before the debounce fired, or an
					// external edit that already holds the value): leave it untouched.
					const content = stringifyYamlConfig(current);
					if (loaded.snapshot.kind !== "content" || loaded.snapshot.source !== content) {
						await this.#writeYamlAtomically(writePath, content);
					}
				}
				// Paths changed while this save was in flight keep their live value until their own save.
				for (const modPath of this.#modified) {
					const segments = modPath.split(".");
					setByPath(current, segments, getByPath(this.#global, segments));
				}
				this.#global = this.#normalizeLayer(current, configPath, false);
				this.#quarantinedYamlTargets.delete(configPath);

				const globalRolesAfterWrite = this.#modelRolesFromLayer(this.#global);
				for (const role of rolesToPreserve) {
					if (latestGlobalRoles[role] === globalRolesAfterWrite[role]) {
						this.#modifiedGlobalModelRoles.delete(role);
						this.#modifiedGlobalModelRoleMutations.delete(role);
					}
				}
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			// A config this save moved aside is missing by our own action, not superseded: retry against that state.
			const retrySnapshot = this.#quarantinedYamlTargets.has(configPath)
				? this.#readYamlSnapshot(configPath)
				: undefined;
			const requeue = (
				key: string,
				pending: Map<string, PendingYamlMutation>,
				failed: PendingYamlMutation | undefined,
			) => {
				if (pending.has(key)) return;
				const mutation = failed ?? { snapshot: { kind: "unreadable" }, baseValue: undefined };
				pending.set(key, retrySnapshot ? { ...mutation, snapshot: retrySnapshot } : mutation);
			};
			for (const p of modifiedPaths) {
				this.#modified.add(p);
				requeue(p, this.#modifiedPathMutations, modifiedPathMutations.get(p));
			}
			for (const role of modifiedModelRoles) {
				this.#modifiedGlobalModelRoles.add(role);
				requeue(role, this.#modifiedGlobalModelRoleMutations, modifiedModelRoleMutations.get(role));
			}
			this.#rebuildMerged();
			throw error;
		}

		this.#rebuildMerged();
		// A skipped stale change leaves the external value in effect: notify whatever applied the local one.
		const nextModelRoles = this.get("modelRoles");
		if (!Bun.deepEquals(nextModelRoles, previousModelRoles)) {
			this.#fireEffectiveSettingChanged("modelRoles", nextModelRoles, previousModelRoles);
		}
		for (const [key, previous] of previousHookValues) {
			const next = this.get(key);
			if (!Bun.deepEquals(next, previous)) {
				SETTING_HOOKS[key]?.(next, previous);
			}
		}
	}
	#queueProjectSave(): void {
		if (!this.#persist) return;

		clearTimeout(this.#projectSaveTimer);
		this.#projectSaveTimer = setTimeout(() => {
			this.#projectSaveTimer = undefined;
			const savePromise = this.#saveProjectNow();
			this.#projectSavePromise = savePromise;
			savePromise
				.catch(err => {
					logger.warn("Settings: background project save failed", { error: String(err) });
				})
				.finally(() => {
					if (this.#projectSavePromise === savePromise) {
						this.#projectSavePromise = undefined;
					}
				});
		}, 100);
	}

	async #saveProjectNow(): Promise<void> {
		if (this.#savesCancelled || !this.#persist || this.#modifiedProjectModelRoles.size === 0) return;

		const projectConfigPath = path.join(this.#cwd, ".proto", "config.yml");
		const modifiedModelRoles = [...this.#modifiedProjectModelRoles];
		this.#modifiedProjectModelRoles.clear();

		try {
			await fs.promises.mkdir(path.dirname(projectConfigPath), { recursive: true });
			await this.#withYamlWriteLock(projectConfigPath, async writePath => {
				const loaded = await this.#loadYamlIfPresentForWriteLocked(projectConfigPath, writePath);
				const projectSettings =
					loaded.settings ??
					(this.#quarantinedYamlTargets.has(projectConfigPath) ? structuredClone(this.#projectFileSettings) : {});

				const projectRoles = getByPath(this.#project, ["modelRoles"]);
				for (const role of modifiedModelRoles) {
					const value = isRecord(projectRoles) ? projectRoles[role] : undefined;
					setByPath(projectSettings, ["modelRoles", role], value);
				}

				await this.#writeYamlAtomically(writePath, stringifyYamlConfig(projectSettings));
				this.#projectFileSettings = structuredClone(projectSettings);
				this.#quarantinedYamlTargets.delete(projectConfigPath);
			});
			invalidateCapabilityFsCache(projectConfigPath);
		} catch (error) {
			for (const role of modifiedModelRoles) {
				this.#modifiedProjectModelRoles.add(role);
			}
			throw error;
		}

		this.#rebuildMerged();
	}

	#projectSettingsForMerge(): RawSettings {
		const projectRoles = getByPath(this.#project, ["modelRoles"]);
		if (!isRecord(projectRoles)) return this.#project;

		let filteredRoles: Record<string, unknown> | undefined;
		for (const role in projectRoles) {
			if (!Object.hasOwn(projectRoles, role) || modelRoleValueFromUnknown(projectRoles[role]) !== undefined)
				continue;
			filteredRoles ??= { ...projectRoles };
			delete filteredRoles[role];
		}
		return filteredRoles ? { ...this.#project, modelRoles: filteredRoles } : this.#project;
	}

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#projectSettingsForMerge());
		this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {}

	on(cb: (...args: A) => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	fire(...args: A): void {
		for (const cb of [...this.#listeners]) {
			try {
				cb(...args);
			} catch (err) {
				logger.warn(`Settings: ${this.label} hook failed`, { error: String(err) });
			}
		}
	}
}

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			appendOnlyModeSignal.fire(value);
		}
	},
	"providers.maxInFlightRequests": value => {
		configureProviderMaxInFlightRequests(validateProviderMaxInFlightRequests(value));
	},
	"secrets.enabled": value => {
		configureCredentialRedaction(value === true);
	},
	// Push the resolved policy into TERMINAL.hyperlinks so renderers gating on the
	// raw flag (Markdown `[text](url)`/bare-URL links, status-line PR links) honor
	// `off`/`always` like the path/resource links that consult the setting.
	"tui.hyperlinks": value => setTerminalHyperlinks(resolveHyperlinkPolicy(value)),
	extendedContext: () => extendedContextSignal.fire(),
	"worktree.base": value => {
		const dir = typeof value === "string" && value.trim() ? value : undefined;

		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};

const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

const modelRolesSignal = new SettingSignal("modelRoles");

export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

const extendedContextSignal = new SettingSignal("extendedContext");

export const onExtendedContextChanged = (cb: () => void) => extendedContextSignal.on(cb);

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		if (boundSettingsInstance !== globalInstance) {
			clearBoundSettingsMethods();
			boundSettingsInstance = globalInstance;
		}
		const value = (globalInstance as unknown as Record<PropertyKey, unknown>)[prop];
		if (typeof value === "function") {
			const cached = boundSettingsMethods.get(prop);
			if (cached) return cached;
			const bound = value.bind(globalInstance);
			boundSettingsMethods.set(prop, bound);
			return bound;
		}
		return value;
	},
});
