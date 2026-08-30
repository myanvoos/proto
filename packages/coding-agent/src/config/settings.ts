import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { configureProviderMaxInFlightRequests } from "@oh-my-pi/pi-ai/stream";
import {
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	hasFsCode,
	isEnoent,
	logger,
	MAIN_CONFIG_FILENAMES,
	procmgr,
	setWorktreesDir,
	toError,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { JSONC, YAML } from "bun";
import { invalidate as invalidateCapabilityFsCache } from "../capability/fs";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-methods";
import { AUTO_IMAGE_PROVIDER_ORDER, isImageProviderId } from "../tools/image-providers";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { INSPECT_MEDIA_MODES } from "../utils/inspect-media-mode";
import { isSearchProviderId, SEARCH_PROVIDER_ORDER } from "../web/search/types";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

export type * from "./settings-schema";
export * from "./settings-schema";

export interface RawSettings {
	[key: string]: unknown;
}

type YamlLoadResult =
	| { kind: "missing" }
	| { kind: "loaded"; settings: RawSettings }
	| { kind: "invalid"; error: unknown; backupPath?: string }
	| { kind: "unreadable"; error: unknown };

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
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
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

type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

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

	#configOverlay: RawSettings = {};

	#projectShellPathSource: string | undefined;

	#overlayShellPathSource: string | undefined;

	#overrides: RawSettings = {};

	#merged: RawSettings = {};

	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	#modified = new Set<string>();

	#modifiedProjectModelRoles = new Set<string>();

	#modifiedGlobalModelRoles = new Set<string>();

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
		liveSettingsInstances.add(new WeakRef(this));

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
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#persistedMutationGeneration++;
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
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

	#codeModeSignalSnapshot(): unknown[] {
		return CODE_MODE_SIGNAL_PATHS.map(path => this.get(path));
	}

	#fireCodeModeChangeIfNeeded(previous: unknown[]): void {
		if (Bun.deepEquals(this.#codeModeSignalSnapshot(), previous)) return;
		codeModeSignal.fire();
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown): void {
		if (Object.is(value, prev)) return;
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
		if (CODE_MODE_SIGNAL_PATHS.includes(path)) {
			codeModeSignal.fire();
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
			const previousCodeModeValues = this.#codeModeSignalSnapshot();
			const previousHookValues = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
				previousHookValues.set(key, this.get(key));
			}

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
			this.#fireCodeModeChangeIfNeeded(previousCodeModeValues);
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
		const prevCodeModeValues = this.#codeModeSignalSnapshot();
		this.#cwd = normalized;
		if (this.#persist) {
			this.#project = await this.#loadProjectSettings();
		}
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prevModelRoles);
		this.#fireCodeModeChangeIfNeeded(prevCodeModeValues);
		this.#fireAllHooks();
	}

	getStorage(): AgentStorage | null {
		return this.#storage;
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

	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#getEditVariantEntries();
		if (variants.length === 0) return null;

		const modelLower = model.toLowerCase();

		for (let i = 0; i < variants.length; i++) {
			const variant = variants[i];
			if (modelLower.includes(variant.patternLower)) {
				return variant.mode;
			}
		}
		return null;
	}

	#getEditVariantEntries(): readonly EditVariantEntry[] {
		if (this.#editVariantCache !== undefined) return this.#editVariantCache;

		const value = getByPath(this.#merged, ["edit", "modelVariants"]);
		if (!isRecord(value)) {
			this.#editVariantCache = [];
			return this.#editVariantCache;
		}

		const variants: EditVariantEntry[] = [];
		for (const pattern in value) {
			if (!Object.hasOwn(value, pattern)) continue;
			const rawMode = value[pattern];
			if (typeof rawMode !== "string") continue;
			const mode = normalizeEditMode(rawMode);
			if (mode) {
				variants.push({ patternLower: pattern.toLowerCase(), mode });
			}
		}

		this.#editVariantCache = variants;
		return variants;
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
		const current = this.#modelRolesFromLayer(this.#global);
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
			return { kind: "invalid", error };
		}
		if (parsed === null || parsed === undefined) {
			return { kind: "loaded", settings: {} };
		}
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				kind: "invalid",
				error: new Error("Settings YAML must contain a mapping at the document root"),
			};
		}
		return {
			kind: "loaded",
			settings: this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion),
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
			const stat = await fs.promises.lstat(filePath);
			if (stat.isSymbolicLink()) {
				const target = await fs.promises.readlink(filePath);
				return path.resolve(path.dirname(filePath), target);
			}
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
		if (result.kind !== "invalid" || !this.#persist) {
			return this.#unwrapYamlLoadResult(filePath, result);
		}
		return await this.#withYamlWriteLock(filePath, async writePath =>
			this.#loadYamlIfPresentForWriteLocked(filePath, writePath, true),
		);
	}

	async #loadYamlIfPresentForWriteLocked(
		filePath: string,
		writePath: string,
		rejectMissing = false,
	): Promise<RawSettings | null> {
		let result = await this.#loadYamlIfPresent(writePath);
		if (result.kind === "missing" && rejectMissing) {
			throw new Error(
				`Settings config was invalid before locking and is now missing: ${filePath}; another process may have moved it aside`,
			);
		}
		if (result.kind === "invalid") {
			result = await this.#quarantineInvalidYamlLocked(writePath, result);
			this.#quarantinedYamlTargets.set(filePath, writePath);
		}
		return this.#unwrapYamlLoadResult(filePath, result);
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
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const loaded = quarantineInvalid
				? await this.#loadYamlIfPresentForStartup(configPath)
				: this.#unwrapYamlLoadResult(configPath, await this.#loadYamlIfPresent(configPath, false));
			if (loaded) return { settings: loaded, configPath };
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
		let shellPathSource: string | undefined;
		let merged: RawSettings = {};
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
					if (Object.hasOwn(item.data, "shellPath")) shellPathSource = item.path;
				}
			}
		} catch {
			shellPathSource = undefined;
		}
		const projectConfigPath = path.join(this.#cwd, ".proto", "config.yml");
		const nativeProject = quarantineInvalid
			? await this.#loadYaml(projectConfigPath)
			: (this.#unwrapYamlLoadResult(projectConfigPath, await this.#loadYamlIfPresent(projectConfigPath, false)) ??
				{});
		const nativeModelRoles = getByPath(nativeProject, ["modelRoles"]);
		if (nativeModelRoles !== undefined) {
			merged = this.#deepMerge(merged, { modelRoles: nativeModelRoles });
		}
		return {
			settings: this.#migrateRawSettings(merged, quarantineInvalid),
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
			throw new Error(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${String(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new Error(`Failed to parse config overlay ${filePath}: ${String(error)}`);
		}
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Config overlay must be a YAML mapping: ${filePath}`);
		}
		return this.#migrateRawSettings(parsed as RawSettings, captureLegacyChangelogVersion);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;

		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch {}
			}
		} catch {}

		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch {}

		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeYamlAtomically(this.#configPath, settings);
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch {}
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

		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				delete raw.theme;
			} else {
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		const legacyInspectImageObj = isRecord(raw.inspect_image)
			? (raw.inspect_image as Record<string, unknown>)
			: undefined;
		const legacyInspectImageEnabled =
			typeof legacyInspectImageObj?.enabled === "boolean"
				? legacyInspectImageObj.enabled
				: typeof raw["inspect_image.enabled"] === "boolean"
					? (raw["inspect_image.enabled"] as boolean)
					: undefined;
		const legacyInspectImageFlatMode =
			typeof raw["inspect_image.mode"] === "string" &&
			(INSPECT_MEDIA_MODES as readonly string[]).includes(raw["inspect_image.mode"] as string)
				? (raw["inspect_image.mode"] as string)
				: undefined;
		const legacyInspectImageNestedMode =
			typeof legacyInspectImageObj?.mode === "string" &&
			(INSPECT_MEDIA_MODES as readonly string[]).includes(legacyInspectImageObj.mode)
				? legacyInspectImageObj.mode
				: undefined;
		const legacyInspectImageMode = legacyInspectImageFlatMode ?? legacyInspectImageNestedMode;
		if (legacyInspectImageObj || legacyInspectImageEnabled !== undefined || legacyInspectImageMode !== undefined) {
			if (!isRecord(raw.inspect_media)) {
				raw.inspect_media = {};
			}
			const target = raw.inspect_media as Record<string, unknown>;
			if (target.mode === undefined) {
				target.mode =
					legacyInspectImageMode ??
					(legacyInspectImageEnabled !== undefined ? (legacyInspectImageEnabled ? "on" : "off") : "auto");
			}
			delete raw.inspect_image;
			delete raw["inspect_image.enabled"];
			delete raw["inspect_image.mode"];
		}

		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}

		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}

		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		const editObj = raw.edit as Record<string, unknown> | undefined;
		if (editObj) {
			if (editObj.mode === "atom" || editObj.mode === "vim") {
				editObj.mode = "hashline";
			}
			const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
			if (modelVariants && typeof modelVariants === "object" && !Array.isArray(modelVariants)) {
				for (const [pattern, variant] of Object.entries(modelVariants)) {
					if (variant === "atom" || variant === "vim") {
						modelVariants[pattern] = "hashline";
					}
				}
			}
		}
		if (raw["edit.mode"] === "atom" || raw["edit.mode"] === "vim") {
			raw["edit.mode"] = "hashline";
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
				case "handoff":
				case "shake-summary":
				case "shake":
					methodOrder = remoteEnabled ? ["remote", "soft"] : ["soft"];
					break;
				case "off":
					methodOrder = [];
					break;
				default:
					if (legacyRemoteEnabled === false) {
						methodOrder = DEFAULT_COMPACTION_METHOD_ORDER.filter(method => method !== "remote");
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

		delete raw.readHashLines;

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

		{
			const advisorObj = isRecord(raw.advisor) ? raw.advisor : undefined;
			const legacySubagents =
				advisorObj && "subagents" in advisorObj ? advisorObj.subagents : raw["advisor.subagents"];
			if (typeof legacySubagents === "boolean") {
				const taskObj = isRecord(raw.task) ? raw.task : {};
				const agentAdvisor = isRecord(taskObj.agentAdvisor) ? taskObj.agentAdvisor : {};
				if (!("task" in agentAdvisor)) agentAdvisor.task = legacySubagents ? "on" : "off";
				taskObj.agentAdvisor = agentAdvisor;
				raw.task = taskObj;
			}
			if (advisorObj) delete advisorObj.subagents;
			delete raw["advisor.subagents"];
		}

		{
			const taskObj = isRecord(raw.task) ? raw.task : undefined;
			if (taskObj) {
				for (const key of ["agentPrewalk", "agentAdvisor"]) {
					const overrides = isRecord(taskObj[key]) ? taskObj[key] : undefined;
					if (!overrides) continue;
					for (const agentName in overrides) {
						const value = overrides[agentName];
						if (typeof value === "boolean") overrides[agentName] = value ? "on" : "off";
					}
				}
			}
		}

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
			"todo",
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

	async #writeYamlAtomically(filePath: string, settings: RawSettings): Promise<void> {
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		let removeTemp = false;
		try {
			const handle = await fs.promises.open(tempPath, "wx", 0o600);
			removeTemp = true;
			try {
				await handle.writeFile(YAML.stringify(settings, null, 2), "utf8");
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
		const globalRolesAtStart = this.#modelRolesFromLayer(this.#global);
		this.#modified.clear();
		this.#modifiedGlobalModelRoles.clear();

		try {
			await this.#withYamlWriteLock(configPath, async writePath => {
				const loaded = await this.#loadYamlIfPresentForWriteLocked(configPath, writePath);
				const current =
					loaded ?? (this.#quarantinedYamlTargets.has(configPath) ? structuredClone(this.#global) : {});

				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
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
				if (modifiedModelRoles.length > 0 || rolesToPreserve.size > 0) {
					const currentRoles = getByPath(current, ["modelRoles"]);
					const mergedRoles: Record<string, unknown> = isRecord(currentRoles) ? { ...currentRoles } : {};
					for (const role of modifiedModelRoles) {
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
				}

				this.#global = current;
				await this.#writeYamlAtomically(writePath, this.#global);
				this.#quarantinedYamlTargets.delete(configPath);

				const globalRolesAfterWrite = this.#modelRolesFromLayer(this.#global);
				for (const role of rolesToPreserve) {
					if (latestGlobalRoles[role] === globalRolesAfterWrite[role]) {
						this.#modifiedGlobalModelRoles.delete(role);
					}
				}
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });

			for (const p of modifiedPaths) {
				this.#modified.add(p);
			}
			for (const role of modifiedModelRoles) {
				this.#modifiedGlobalModelRoles.add(role);
			}
			this.#rebuildMerged();
			throw error;
		}

		this.#rebuildMerged();
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
					loaded ??
					(this.#quarantinedYamlTargets.has(projectConfigPath) ? structuredClone(this.#projectFileSettings) : {});

				const projectRoles = getByPath(this.#project, ["modelRoles"]);
				for (const role of modifiedModelRoles) {
					const value = isRecord(projectRoles) ? projectRoles[role] : undefined;
					setByPath(projectSettings, ["modelRoles", role], value);
				}

				await this.#writeYamlAtomically(writePath, projectSettings);
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
		this.#editVariantCache = undefined;
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

const codeModeSignal = new SettingSignal("providers.openai-codex.codeMode");

const CODE_MODE_SIGNAL_PATHS: readonly SettingPath[] = [
	"providers.openai-codex.codeMode",
	"providers.openai-codex.codeModeDirectTools",
	"eval.js",
	"edit.mode",
];

export const onCodeModeChanged = (cb: () => void) => codeModeSignal.on(cb);

const extendedContextSignal = new SettingSignal("extendedContext");

export const onExtendedContextChanged = (cb: () => void) => extendedContextSignal.on(cb);

const liveSettingsInstances = new Set<WeakRef<Settings>>();

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

export function resetSettingsForTest(): void {
	for (const ref of liveSettingsInstances) {
		ref.deref()?.cancelPendingSaves();
	}
	liveSettingsInstances.clear();
	globalInstance = null;
	globalInstancePromise = null;
	clearBoundSettingsMethods();
	configureProviderMaxInFlightRequests(undefined);
	configureCredentialRedaction(false);
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
