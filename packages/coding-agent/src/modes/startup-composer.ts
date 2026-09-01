import type { Terminal } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { getRecentSessions } from "../session/session-listing";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import type { RecentSession } from "./components/welcome";
import { COMPOSER_DEFAULTS, Composer, type ComposerPreferences, type ComposerWelcomeUpdate } from "./composer";
import {
	type ComposerThemePreferences,
	readComposerStartupCache,
	writeComposerRecentSessionsCache,
	writeComposerUiCache,
} from "./composer-cache";
import { initThemeSync } from "./theme/theme";

interface PrepaintComposerOptions {
	readonly terminal?: Terminal;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
	readonly version?: string;
	readonly cwd?: string;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly theme?: ComposerThemePreferences;
	readonly recentSessions?: () => Promise<RecentSession[]>;
	readonly cache?: boolean;
}

interface PrepaintComposerPreferences extends ComposerPreferences {
	readonly theme: ComposerThemePreferences;
}

interface PendingComposer {
	readonly composer: Composer;
	readonly cwd: string;
	readonly cache: boolean;
}

let pendingComposer: PendingComposer | undefined;

export class ComposerLease {
	readonly composer: Composer;
	#adopted = false;

	constructor(composer: Composer) {
		this.composer = composer;
	}

	adopt(): void {
		if (this.#adopted) return;

		this.composer.enableInput();
		this.composer.transfer();
		this.#adopted = true;
	}

	dispose(): void {
		if (!this.#adopted) this.composer.stop();
	}
}

export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	if (pendingComposer) throw new Error("A prepaint composer is already active");
	const cwd = options.cwd ?? process.cwd();
	const useCache = options.cache !== false;
	const cached = useCache
		? readComposerStartupCache(cwd)
		: {
				preferences: undefined,
				theme: undefined,
				welcome: undefined,
				recentSessions: [],
			};
	const theme = { ...cached.theme, ...options.theme };
	initThemeSync(theme.colorBlindMode, theme.darkTheme, theme.lightTheme);
	const preferences = { ...COMPOSER_DEFAULTS, ...cached.preferences, ...options.preferences };
	const welcome: ComposerWelcomeUpdate = {
		version: options.version ?? "",
		modelName: cached.welcome?.modelName,
		providerName: cached.welcome?.providerName,
		recentSessions: cached.recentSessions,
	};
	const composer = new Composer({
		terminal: options.terminal,
		exit: options.exit,
		now: options.now,
		preferences,
		welcome,
	});
	try {
		composer.start({ clearScrollback: true, deferInput: true });
	} catch (error) {
		try {
			composer.stop();
		} catch {}
		throw error;
	}
	const pending = { composer, cwd, cache: useCache };
	pendingComposer = pending;
	void refreshRecentSessions(pending, options.recentSessions);
}

export function takeStartupComposerLease(): ComposerLease | undefined {
	const pending = pendingComposer;
	pendingComposer = undefined;
	return pending ? new ComposerLease(pending.composer) : undefined;
}

export function stopPendingStartupComposer(): void {
	pendingComposer?.composer.stop();
	pendingComposer = undefined;
}

export function applyStartupComposerPreferences(update: PrepaintComposerPreferences): void {
	const pending = pendingComposer;
	if (!pending) return;
	const preferences: ComposerPreferences = {
		quiet: update.quiet,
		showHardwareCursor: update.showHardwareCursor,
		maxInlineImages: update.maxInlineImages,
		scrollbackRebuild: update.scrollbackRebuild,
		resizeScrollback: update.resizeScrollback,
		imeSafeCursor: update.imeSafeCursor,
		autocompleteMaxVisible: update.autocompleteMaxVisible,
		spellingTypoDetection: update.spellingTypoDetection,
		spellingAutocomplete: update.spellingAutocomplete,
		spellingAutocorrect: update.spellingAutocorrect,
	};
	pending.composer.setPreferences(preferences);

	pending.composer.enableInput();
	if (pending.cache) {
		void writeComposerUiCache(pending.cwd, preferences, update.theme).catch(error => {
			logger.debug("composer UI cache write failed", { error });
		});
	}
}

async function refreshRecentSessions(
	pending: PendingComposer,
	loadOverride: (() => Promise<RecentSession[]>) | undefined,
): Promise<void> {
	try {
		const sessions = loadOverride ? await loadOverride() : await loadRecentSessions(pending.cwd);
		if (pending.cache) {
			void writeComposerRecentSessionsCache(pending.cwd, sessions).catch(error => {
				logger.debug("composer recent sessions cache write failed", { error });
			});
		}
		if (pendingComposer !== pending) return;
		pending.composer.updateWelcome({ recentSessions: sessions });
	} catch (error) {
		logger.debug("composer recent sessions load failed", { error });
	}
}

async function loadRecentSessions(cwd: string): Promise<RecentSession[]> {
	const storage = new FileSessionStorage();
	const dir = computeDefaultSessionDir(cwd, storage);
	const list = await getRecentSessions(dir, 4, storage);
	return list.map(session => ({ name: session.name, timeAgo: session.timeAgo }));
}
