import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	setKeybindings,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@oh-my-pi/pi-tui";
import { getActiveProfile, getAgentDir, getProfileRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { JSONC, YAML } from "bun";

interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.display.reset": true;
	"app.thinking.cycle": true;
	"app.thinking.toggle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.selectTemporary": true;
	"app.tools.expand": true;
	"app.tools.toggleVisibility": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.retry": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.clipboard.pasteTextRaw": true;
	"app.clipboard.copyLine": true;
	"app.clipboard.copyPrompt": true;
	"app.agents.fleet": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.session.observe": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.history.search": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@oh-my-pi/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

export function getDefaultPasteImageKeys(platform: NodeJS.Platform = process.platform): KeyId[] {
	if (platform === "darwin") return ["ctrl+v", "super+v"];
	return ["ctrl+v"];
}

const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Interrupt current operation",
	},
	"app.clear": {
		defaultKeys: "ctrl+c",
		description: "Clear screen or cancel",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit application",
	},
	"app.suspend": {
		defaultKeys: "ctrl+z",
		description: "Suspend application",
	},
	"app.display.reset": {
		defaultKeys: "alt+l",
		description: "Reset terminal display",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking mode",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": {
		defaultKeys: "alt+m",
		description: "Select model",
	},
	"app.model.selectTemporary": {
		defaultKeys: "alt+p",
		description: "Select temporary model for current session",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand tools",
	},
	"app.tools.toggleVisibility": {
		defaultKeys: "ctrl+shift+o",
		description: "Show or hide tool activity",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.followUp": {
		defaultKeys: "ctrl+enter",
		description: "Send follow-up message",
	},
	"app.retry": {
		defaultKeys: "alt+r",
		description: "Retry last failed assistant turn",
	},
	"app.message.dequeue": {
		defaultKeys: ["alt+up", "shift+up"],
		description: "Dequeue message",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: getDefaultPasteImageKeys(),
		description: "Paste image or text from clipboard",
	},
	"app.clipboard.pasteTextRaw": {
		defaultKeys: ["ctrl+shift+v", "alt+shift+v"],
		description: "Paste text from clipboard as raw text (no collapse)",
	},
	"app.clipboard.copyLine": {
		defaultKeys: "alt+shift+l",
		description: "Copy current line",
	},
	"app.clipboard.copyPrompt": {
		defaultKeys: "alt+shift+c",
		description: "Copy prompt",
	},
	"app.session.new": {
		defaultKeys: [],
		description: "Create new session",
	},
	"app.session.tree": {
		defaultKeys: [],
		description: "Show session tree",
	},
	"app.session.fork": {
		defaultKeys: [],
		description: "Fork session",
	},
	"app.session.resume": {
		defaultKeys: [],
		description: "Resume session",
	},
	"app.agents.fleet": {
		defaultKeys: "alt+a",
		description: "Open the agent fleet",
	},
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Open the agent fleet",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort order",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session (non-invasive)",
	},
	"app.tree.foldOrUp": {
		defaultKeys: ["ctrl+left", "alt+left"],
		description: "Fold or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold or move down",
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search history",
	},
} as const satisfies KeybindingDefinitions;

const KEYBINDING_NAME_MIGRATIONS = {
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	displayReset: "app.display.reset",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	selectModelTemporary: "app.model.selectTemporary",
	historySearch: "app.history.search",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	retry: "app.retry",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	pasteTextRaw: "app.clipboard.pasteTextRaw",
	copyLine: "app.clipboard.copyLine",
	copyPrompt: "app.clipboard.copyPrompt",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	observeSessions: "app.session.observe",

	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",

	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",

	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",

	toggleSessionNamedFilter: "app.session.togglePath",
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (typeof value !== "object" || value === null) {
		return {};
	}

	const config: KeybindingsConfig = {};
	for (const [key, val] of Object.entries(value)) {
		if (val === undefined) {
			config[key] = undefined;
		} else if (typeof val === "string") {
			config[key] = val as KeyId;
		} else if (Array.isArray(val) && val.every(v => typeof v === "string")) {
			config[key] = val as KeyId[];
		}
	}
	return config;
}

function migrateKeybindingNames(rawConfig: unknown): {
	config: KeybindingsConfig;
	migrated: boolean;
} {
	const config = toKeybindingsConfig(rawConfig);
	const migrated: KeybindingsConfig = {};
	let didMigrate = false;

	for (const [key, value] of Object.entries(config)) {
		if (isLegacyKeybindingName(key)) {
			const newKey = KEYBINDING_NAME_MIGRATIONS[key];
			migrated[newKey] = value;
			didMigrate = true;
		} else {
			migrated[key] = value;
		}
	}

	return { config: migrated, migrated: didMigrate };
}

function orderKeybindingsConfig(config: KeybindingsConfig): KeybindingsConfig {
	const ordered: KeybindingsConfig = {};
	for (const key of Object.keys(KEYBINDINGS)) {
		const value = config[key];
		if (value !== undefined) {
			ordered[key] = value;
		}
	}

	for (const key of Object.keys(config)) {
		if (!(key in ordered)) {
			ordered[key] = config[key];
		}
	}
	return ordered;
}

const KEYBINDINGS_YML = "keybindings.yml";
const KEYBINDINGS_YAML = "keybindings.yaml";
const LEGACY_KEYBINDINGS_JSON = "keybindings.json";

interface KeybindingsConfigPaths {
	readPath: string;
	writeBackPath: string;
}

interface KeybindingsCreateOptions {
	inheritedAgentDir?: string;
}

function loadRawConfig(filePath: string): unknown {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		if (filePath.endsWith(".json")) {
			return JSONC.parse(content);
		}
		if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
			return YAML.parse(content);
		}
		throw new Error(`Unsupported keybindings config extension: ${filePath}`);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		logger.warn("Failed to parse keybindings config", { path: filePath, error: String(error) });
		return null;
	}
}

function writeKeybindingsConfig(filePath: string, config: KeybindingsConfig): boolean {
	try {
		fs.writeFileSync(filePath, YAML.stringify(config, null, 2), "utf-8");
		logger.debug("Migrated keybindings config", { path: filePath });
		return true;
	} catch (error) {
		logger.warn("Failed to write migrated keybindings config", { path: filePath, error: String(error) });
		return false;
	}
}

function resolveKeybindingsConfigPaths(agentDir: string): KeybindingsConfigPaths {
	const ymlPath = path.join(agentDir, KEYBINDINGS_YML);
	if (fs.existsSync(ymlPath)) {
		return { readPath: ymlPath, writeBackPath: ymlPath };
	}

	const yamlPath = path.join(agentDir, KEYBINDINGS_YAML);
	if (fs.existsSync(yamlPath)) {
		return { readPath: yamlPath, writeBackPath: yamlPath };
	}

	const jsonPath = path.join(agentDir, LEGACY_KEYBINDINGS_JSON);
	if (fs.existsSync(jsonPath)) {
		return { readPath: jsonPath, writeBackPath: ymlPath };
	}

	return { readPath: ymlPath, writeBackPath: ymlPath };
}

function mergeKeybindingsConfig(
	inheritedConfig: KeybindingsConfig,
	profileConfig: KeybindingsConfig,
): KeybindingsConfig {
	return { ...inheritedConfig, ...profileConfig };
}

function resolveInheritedAgentDir(agentDir: string, options: KeybindingsCreateOptions): string | undefined {
	const inheritedAgentDir =
		options.inheritedAgentDir ?? (getActiveProfile() ? path.join(getProfileRootDir(undefined), "agent") : undefined);
	if (!inheritedAgentDir) return undefined;
	if (path.resolve(inheritedAgentDir) === path.resolve(agentDir)) return undefined;
	return inheritedAgentDir;
}

function loadMergedKeybindingsConfig(
	agentDir: string,
	options: KeybindingsCreateOptions,
): {
	config: KeybindingsConfig;
	profilePath: string;
	inheritedPath: string | undefined;
} {
	const profilePaths = resolveKeybindingsConfigPaths(agentDir);
	const profile = loadKeybindingsConfig(profilePaths.readPath, profilePaths.writeBackPath);
	const inheritedAgentDir = resolveInheritedAgentDir(agentDir, options);
	if (!inheritedAgentDir) {
		return { config: profile.config, profilePath: profile.persistedPath, inheritedPath: undefined };
	}

	const inheritedPaths = resolveKeybindingsConfigPaths(inheritedAgentDir);

	const inherited = loadKeybindingsConfig(inheritedPaths.readPath, undefined);
	return {
		config: mergeKeybindingsConfig(inherited.config, profile.config),
		profilePath: profile.persistedPath,
		inheritedPath: inherited.persistedPath,
	};
}

function loadKeybindingsConfig(
	filePath: string,
	writeBackPath: string | undefined,
): {
	config: KeybindingsConfig;
	persistedPath: string;
} {
	const rawConfig = loadRawConfig(filePath);

	if (rawConfig === null) {
		return { config: {}, persistedPath: filePath };
	}

	const { config: migratedConfig, migrated } = migrateKeybindingNames(rawConfig);
	const shouldWriteBack = writeBackPath !== undefined && (migrated || writeBackPath !== filePath);
	if (shouldWriteBack) {
		const ordered = orderKeybindingsConfig(migratedConfig);
		const persistedPath = writeKeybindingsConfig(writeBackPath, ordered) ? writeBackPath : filePath;
		return { config: migratedConfig, persistedPath };
	}

	return { config: migratedConfig, persistedPath: filePath };
}

const FOLLOW_UP_KEYBINDING: AppKeybinding = "app.message.followUp";
const DEQUEUE_KEYBINDING: AppKeybinding = "app.message.dequeue";
const MACOS_DEQUEUE_FALLBACK_KEY: KeyId = "shift+up";
function getFallbackKey(keybinding: Keybinding): KeyId | undefined {
	if (keybinding === DEQUEUE_KEYBINDING) return MACOS_DEQUEUE_FALLBACK_KEY;
	return undefined;
}
function keyListIncludes(keys: KeyId | KeyId[] | undefined, target: KeyId): boolean {
	if (keys === undefined) return false;
	const keyList = Array.isArray(keys) ? keys : [keys];
	for (const key of keyList) {
		if (key.toLowerCase() === target) return true;
	}
	return false;
}

function userBindingClaimsKey(config: KeybindingsConfig, target: KeyId, except: Keybinding): boolean {
	for (const [keybinding, keys] of Object.entries(config)) {
		if (!(keybinding in KEYBINDINGS)) continue;
		if (keybinding === except) continue;
		if (keyListIncludes(keys, target)) return true;
	}
	return false;
}

function removeKey(keys: KeyId[], target: KeyId): KeyId[] {
	return keys.filter(key => key !== target);
}

function keyConfigValue(keys: KeyId[]): KeyId | KeyId[] {
	if (keys.length === 1) {
		const key = keys[0];
		if (key !== undefined) return key;
	}
	return [...keys];
}

export class KeybindingsManager extends TuiKeybindingsManager {
	#configPath: string | undefined;
	#inheritedConfigPath: string | undefined;
	#userBindings: KeybindingsConfig;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string, inheritedConfigPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.#configPath = configPath;
		this.#inheritedConfigPath = inheritedConfigPath;
		this.#userBindings = userBindings;
	}

	static create(agentDir: string = getAgentDir(), options: KeybindingsCreateOptions = {}): KeybindingsManager {
		const { config: userBindings, profilePath, inheritedPath } = loadMergedKeybindingsConfig(agentDir, options);
		const manager = new KeybindingsManager(userBindings, profilePath, inheritedPath);

		setKeybindings(manager);
		return manager;
	}

	static inMemory(userBindings: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(userBindings);
	}

	reload(): void {
		if (!this.#configPath) return;
		const { config: inheritedConfig } = this.#inheritedConfigPath
			? KeybindingsManager.#loadFromFile(this.#inheritedConfigPath)
			: { config: {} };
		const { config: profileConfig } = KeybindingsManager.#loadFromFile(this.#configPath);
		this.setUserBindings(mergeKeybindingsConfig(inheritedConfig, profileConfig));
	}

	override setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		super.setUserBindings(userBindings);
	}

	override getKeys(keybinding: Keybinding): KeyId[] {
		const keys = super.getKeys(keybinding);
		const fallbackKey = getFallbackKey(keybinding);
		if (fallbackKey === undefined || this.#userBindings[keybinding] !== undefined) return keys;
		if (!userBindingClaimsKey(this.#userBindings, fallbackKey, keybinding)) return keys;
		return removeKey(keys, fallbackKey);
	}

	override getResolvedBindings(): KeybindingsConfig {
		const resolved = super.getResolvedBindings();
		resolved[FOLLOW_UP_KEYBINDING] = keyConfigValue(this.getKeys(FOLLOW_UP_KEYBINDING));
		return resolved;
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	getDisplayString(keybinding: Keybinding): string {
		const keys = this.getKeys(keybinding);
		return formatKeyHints(keys.length === 0 ? [] : keys);
	}

	static #loadFromFile(
		filePath: string,
		writeBackPath?: string,
	): { config: KeybindingsConfig; persistedPath: string } {
		return loadKeybindingsConfig(filePath, writeBackPath);
	}
}

let keyHintPlatformOverride: NodeJS.Platform | undefined;

export function setKeyHintPlatform(platform: NodeJS.Platform | undefined): void {
	keyHintPlatformOverride = platform;
}

export function keyHintPlatform(): NodeJS.Platform {
	return keyHintPlatformOverride ?? process.platform;
}

type Modifier = "ctrl" | "shift" | "alt" | "super";

function isModifier(part: string): part is Modifier {
	return part === "ctrl" || part === "shift" || part === "alt" || part === "super";
}

export function modifierLabel(mod: Modifier, platform: NodeJS.Platform = keyHintPlatform()): string {
	switch (mod) {
		case "ctrl":
			return "Ctrl";
		case "shift":
			return "Shift";
		case "alt":
			return platform === "darwin" ? "Option" : "Alt";
		case "super":
			return platform === "darwin" ? "Cmd" : "Super";
	}
}

const KEY_LABELS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

function formatKeyPart(part: string, platform: NodeJS.Platform): string {
	const lower = part.toLowerCase();
	if (isModifier(lower)) return modifierLabel(lower, platform);
	const label = KEY_LABELS[lower];
	if (label) return label;
	if (part.length === 1) return part.toUpperCase();
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

function formatKeyHint(key: KeyId): string {
	const platform = keyHintPlatform();
	return key
		.split("+")
		.map(part => formatKeyPart(part, platform))
		.join("+");
}

export function formatKeyHints(keys: KeyId | KeyId[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKeyHint).join("/");
}

export type { Keybinding, KeybindingsConfig, KeyId };
