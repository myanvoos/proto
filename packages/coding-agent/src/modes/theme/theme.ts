import * as fs from "node:fs";
import * as path from "node:path";
import { detectMacOSAppearance, MacAppearanceObserver } from "@oh-my-pi/pi-natives";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";
import { colorLuma, getCustomThemesDir, logger } from "@oh-my-pi/pi-utils";
import { resolveVarRefs } from "./color";
import { type CreateThemeOptions, getBuiltinThemes, loadTheme, loadThemeSync } from "./loader";
import type { ThemeColor, ThemeJson } from "./schema";
import type { Theme } from "./theme-class";

export { getLanguageFromPath, isMarkdownPath } from "../../utils/lang-from-path";
export { getAvailableThemes, getAvailableThemesWithPaths, getThemeByName, type ThemeInfo } from "./loader";
export { isValidThemeColor, type ThemeBg, type ThemeColor } from "./schema";
export type { SpinnerType, SymbolKey, SymbolPreset } from "./symbols";
export { Theme } from "./theme-class";
export {
	getEditorTheme,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getSymbolTheme,
	highlightCode,
	setMarkdownMermaidRendering,
} from "./tui-adapters";

var terminalReportedAppearance: "dark" | "light" | undefined;

var macOSReportedAppearance: "dark" | "light" | undefined;

function shouldUseMacOSAppearanceFallback(): boolean {
	return process.platform === "darwin" && !!Bun.env.ZELLIJ;
}

function detectTerminalBackground(): "dark" | "light" {
	if (!shouldUseMacOSAppearanceFallback() && terminalReportedAppearance) {
		return terminalReportedAppearance;
	}

	const colorfgbg = Bun.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) return bg < 8 ? "dark" : "light";
		}
	}

	if (shouldUseMacOSAppearanceFallback()) {
		const macAppearance = macOSReportedAppearance ?? detectMacOSAppearance();
		if (macAppearance) return macAppearance;
	}

	return "dark";
}

function getDefaultTheme(): string {
	const bg = detectTerminalBackground();
	return bg === "light" ? autoLightTheme : autoDarkTheme;
}

export var theme: Theme;
var currentThemeName: string | undefined;

export function getCurrentThemeName(): string | undefined {
	return currentThemeName;
}

export function fgOrPlain(color: ThemeColor, text: string, styledText: string = text): string {
	return typeof theme === "undefined" ? text : theme.fg(color, styledText);
}
interface ThemeChangeEvent {
	ephemeral?: boolean;
}

var currentColorBlindMode: boolean = false;
var themeWatcher: fs.FSWatcher | undefined;
var themeReloadTimer: NodeJS.Timeout | undefined;
var sigwinchHandler: (() => void) | undefined;
var autoDetectedTheme: boolean = false;
var autoDarkTheme: string = "dark";
var autoLightTheme: string = "light";
var onThemeChangeCallback: ((event: ThemeChangeEvent) => void) | undefined;
var themeLoadRequestId: number = 0;
let themeEpoch = 0;

function getCurrentThemeOptions(): CreateThemeOptions {
	return {
		colorBlindMode: currentColorBlindMode,
	};
}
function configureTheme(colorBlindMode?: boolean, darkTheme?: string, lightTheme?: string): string {
	autoDetectedTheme = true;
	autoDarkTheme = darkTheme ?? "dark";
	autoLightTheme = lightTheme ?? "light";
	currentColorBlindMode = colorBlindMode ?? false;
	const name = getDefaultTheme();
	currentThemeName = name;
	return name;
}

export function initThemeSync(colorBlindMode?: boolean, darkTheme?: string, lightTheme?: string): void {
	const name = configureTheme(colorBlindMode, darkTheme, lightTheme);
	const options: CreateThemeOptions = {
		colorBlindMode: currentColorBlindMode,
	};
	try {
		theme = loadThemeSync(name, options);
	} catch (error) {
		logger.debug("Theme loading failed, falling back to dark theme", { error: String(error) });
		currentThemeName = "dark";
		theme = loadThemeSync("dark", options);
	}
}

export async function ensureTheme(): Promise<void> {
	if (typeof theme !== "undefined") return;
	await initTheme();
}

export async function initTheme(
	enableWatcher: boolean = false,
	colorBlindMode?: boolean,
	darkTheme?: string,
	lightTheme?: string,
): Promise<void> {
	const name = configureTheme(colorBlindMode, darkTheme, lightTheme);
	try {
		theme = await loadTheme(name, getCurrentThemeOptions());
		if (enableWatcher) {
			await startThemeWatcher();
			startSigwinchListener();
		}
	} catch (err) {
		logger.debug("Theme loading failed, falling back to dark theme", { error: String(err) });
		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());
	}
}

export async function setTheme(
	name: string,
	enableWatcher: boolean = false,
): Promise<{ success: boolean; error?: string }> {
	autoDetectedTheme = false;
	currentThemeName = name;
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}
		theme = loadedTheme;
		if (enableWatcher) {
			await startThemeWatcher();
		}
		notifyThemeChange();
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}

		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());

		notifyThemeChange();

		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function previewTheme(
	name: string,
	event: ThemeChangeEvent = { ephemeral: true },
): Promise<{ success: boolean; error?: string }> {
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		theme = loadedTheme;
		notifyThemeChange(event);
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function enableAutoTheme(event: ThemeChangeEvent = {}): void {
	autoDetectedTheme = true;
	reevaluateAutoTheme("enableAutoTheme", event);
}

export function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void {
	if (mode === "dark") autoDarkTheme = themeName;
	else autoLightTheme = themeName;
	reevaluateAutoTheme("setAutoThemeMapping");
}

export function onTerminalAppearanceChange(
	mode: "dark" | "light",
	event: ThemeChangeEvent = { ephemeral: true },
): void {
	if (terminalReportedAppearance === mode) return;
	terminalReportedAppearance = mode;
	reevaluateAutoTheme("terminal appearance", event);
}

export function setThemeInstance(themeInstance: Theme): void {
	autoDetectedTheme = false;
	theme = themeInstance;
	currentThemeName = "<in-memory>";
	stopThemeWatcher();
	notifyThemeChange({ ephemeral: true });
}

export async function setColorBlindMode(enabled: boolean): Promise<void> {
	currentColorBlindMode = enabled;
	if (!currentThemeName) return;

	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(currentThemeName, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
		theme = loadedTheme;
	} catch {
		if (requestId !== themeLoadRequestId) return;

		theme = await loadTheme("dark", getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) return;
	}
	notifyThemeChange({ ephemeral: true });
}

export function onThemeChange(callback: (event: ThemeChangeEvent) => void): () => void {
	onThemeChangeCallback = callback;
	return () => {
		if (onThemeChangeCallback === callback) {
			onThemeChangeCallback = undefined;
		}
	};
}

export function getThemeEpoch(): number {
	return themeEpoch;
}

function notifyThemeChange(event: ThemeChangeEvent = {}): void {
	themeEpoch++;
	onThemeChangeCallback?.(event);
}

async function startThemeWatcher(): Promise<void> {
	stopThemeWatcher();

	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			if (currentThemeName !== watchedThemeName) {
				return;
			}

			if (!fs.existsSync(themeFile)) {
				return;
			}

			loadTheme(watchedThemeName, getCurrentThemeOptions())
				.then(loadedTheme => {
					theme = loadedTheme;
					notifyThemeChange({ ephemeral: true });
				})
				.catch(() => {});
		}, 100);
	};

	try {
		themeWatcher = fs.watch(customThemesDir, (_eventType, filename) => {
			if (currentThemeName !== watchedThemeName) {
				return;
			}
			if (!filename) {
				scheduleReload();
				return;
			}
			const changedFile = String(filename);
			if (changedFile !== watchedFileName) {
				return;
			}
			scheduleReload();
		});
	} catch {}
}

function applyResolvedAutoTheme(resolved: string, debugLabel: string, event: ThemeChangeEvent): void {
	if (resolved === currentThemeName) return;
	currentThemeName = resolved;
	const requestId = ++themeLoadRequestId;
	loadTheme(resolved, getCurrentThemeOptions())
		.then(loadedTheme => {
			if (requestId !== themeLoadRequestId) return;
			theme = loadedTheme;
			notifyThemeChange(event);
		})
		.catch(err => {
			if (requestId !== themeLoadRequestId) return;
			logger.debug(`Theme switch on ${debugLabel} failed`, { error: String(err) });
		});
}

function reevaluateAutoTheme(debugLabel: string, event: ThemeChangeEvent = {}, appearance?: "dark" | "light"): void {
	if (!autoDetectedTheme) return;
	const resolved =
		appearance === undefined ? getDefaultTheme() : appearance === "dark" ? autoDarkTheme : autoLightTheme;
	applyResolvedAutoTheme(resolved, debugLabel, event);
}

function reevaluateAutoThemeForAppearance(debugLabel: string, appearance?: "dark" | "light"): void {
	reevaluateAutoTheme(debugLabel, { ephemeral: true }, appearance);
}

type MacOSAppearanceReprobeTerminal = Pick<
	Terminal,
	"appearance" | "onAppearanceChange" | "onAppearanceReport" | "onPrivateModeReport" | "refreshAppearance"
>;

const MACOS_APPEARANCE_REPROBE_DELAYS_MS = [25, 50, 100, 250, 500, 1000] as const;
const MACOS_APPEARANCE_RECONCILE_DELAY_MS = 1100;

export function startMacOSAppearanceReprobeFallback(terminal: MacOSAppearanceReprobeTerminal): () => void {
	let disposed = false;
	let observerStartAttempted = false;
	let observer: MacAppearanceObserver | undefined;
	let probeGeneration = 0;
	let probeSequenceActive = false;
	let probeBaseline: TerminalAppearance | undefined;
	let probeResponseConfirmed = false;
	const probeTimers = new Set<Timer>();
	let reconciliationTimer: Timer | undefined;

	const cancelProbeSequence = (): void => {
		probeGeneration++;
		probeSequenceActive = false;
		probeBaseline = undefined;
		probeResponseConfirmed = false;
		if (reconciliationTimer) {
			clearTimeout(reconciliationTimer);
			reconciliationTimer = undefined;
		}
		for (const timer of probeTimers) {
			clearTimeout(timer);
		}
		probeTimers.clear();
	};

	const scheduleProbeSequence = (): void => {
		cancelProbeSequence();
		if (disposed || !autoDetectedTheme) return;

		probeSequenceActive = true;
		probeBaseline = terminal.appearance;
		probeResponseConfirmed = false;
		const generation = probeGeneration;
		terminal.refreshAppearance?.();
		if (disposed || generation !== probeGeneration || !autoDetectedTheme) return;
		for (const delay of MACOS_APPEARANCE_REPROBE_DELAYS_MS) {
			const timer = setTimeout(() => {
				probeTimers.delete(timer);
				if (disposed || generation !== probeGeneration) return;
				if (!autoDetectedTheme) {
					cancelProbeSequence();
					return;
				}
				terminal.refreshAppearance?.();
			}, delay);
			timer.unref?.();
			probeTimers.add(timer);
		}
		reconciliationTimer = setTimeout(() => {
			reconciliationTimer = undefined;
			if (disposed || generation !== probeGeneration) return;
			const appearance = probeResponseConfirmed ? terminal.appearance : undefined;
			cancelProbeSequence();
			if (!autoDetectedTheme || !appearance) return;
			reevaluateAutoThemeForAppearance("macOS appearance reconciliation", appearance);
		}, MACOS_APPEARANCE_RECONCILE_DELAY_MS);
		reconciliationTimer.unref?.();
	};

	const unsubscribeAppearanceReport = terminal.onAppearanceReport?.(() => {
		if (disposed || !probeSequenceActive) return;
		probeResponseConfirmed = true;
	});

	terminal.onAppearanceChange(appearance => {
		if (disposed || !probeSequenceActive || appearance === probeBaseline) return;
		cancelProbeSequence();
	});

	terminal.onPrivateModeReport?.((mode, supported, confirmed) => {
		if (disposed || observerStartAttempted || mode !== 2031 || supported || confirmed !== true) {
			return;
		}

		observerStartAttempted = true;
		try {
			observer = MacAppearanceObserver.start((err, appearance) => {
				if (disposed) return;
				if (err) {
					cancelProbeSequence();
					return;
				}
				if (appearance === "dark" || appearance === "light") {
					reevaluateAutoThemeForAppearance("macOS provisional appearance", appearance);
				}
				scheduleProbeSequence();
			});
		} catch (err) {
			logger.warn("Failed to start macOS appearance reprobe observer", { err });
		}
	});

	return () => {
		if (disposed) return;
		disposed = true;
		cancelProbeSequence();
		if (unsubscribeAppearanceReport) unsubscribeAppearanceReport();
		const activeObserver = observer;
		observer = undefined;
		if (!activeObserver) return;
		try {
			activeObserver.stop();
		} catch (err) {
			logger.debug("Failed to stop macOS appearance reprobe observer", { err });
		}
	};
}

var macObserver: { stop(): void } | undefined;

function startMacAppearanceObserver(): void {
	stopMacAppearanceObserver();
	if (!shouldUseMacOSAppearanceFallback()) return;
	try {
		macOSReportedAppearance = detectMacOSAppearance() ?? undefined;
		macObserver = MacAppearanceObserver.start((err, appearance) => {
			if (!err && (appearance === "dark" || appearance === "light")) {
				macOSReportedAppearance = appearance;
				reevaluateAutoThemeForAppearance("macOS fallback");
			}
		});
	} catch (err) {
		logger.warn("Failed to start macOS appearance observer", { err });
	}
}

function stopMacAppearanceObserver(): void {
	if (macObserver) {
		macObserver.stop();
		macObserver = undefined;
	}
	macOSReportedAppearance = undefined;
}

function startSigwinchListener(): void {
	stopSigwinchListener();
	sigwinchHandler = () => {
		reevaluateAutoThemeForAppearance("SIGWINCH");
	};
	process.on("SIGWINCH", sigwinchHandler);
	startMacAppearanceObserver();
}

function stopSigwinchListener(): void {
	if (sigwinchHandler) {
		process.removeListener("SIGWINCH", sigwinchHandler);
		sigwinchHandler = undefined;
	}
	stopMacAppearanceObserver();
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
	stopSigwinchListener();
	terminalReportedAppearance = undefined;
}

function isLightThemeJson(themeJson: ThemeJson): boolean {
	try {
		const resolved = resolveVarRefs(themeJson.colors.statusLineBg, themeJson.vars ?? {});
		const luminance = colorLuma(resolved);
		return luminance !== undefined && luminance > 0.5;
	} catch {
		return false;
	}
}

export function isLightTheme(themeName?: string): boolean {
	const name = themeName ?? "dark";
	const builtinThemes = getBuiltinThemes();
	let themeJson: ThemeJson | undefined;
	if (name in builtinThemes) {
		themeJson = builtinThemes[name];
	} else {
		try {
			const customPath = path.join(getCustomThemesDir(), `${name}.json`);
			const content = fs.readFileSync(customPath, "utf-8");
			themeJson = JSON.parse(content) as ThemeJson;
		} catch {
			return false;
		}
	}
	return isLightThemeJson(themeJson);
}
