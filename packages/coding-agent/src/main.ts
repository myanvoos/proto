import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { EventLoopKeepalive, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	$env,
	BINARY_NAME,
	directoryIsMissing,
	getAgentDbPath,
	getLogPath,
	getProjectDir,
	isBunTestRuntime,
	logger,
	normalizePathForComparison,
	postmortem,
	setInteractiveHost,
	setProjectDir,
	VERSION,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { reset as resetCapabilities } from "./capability";
import { type Args, reportUnrecognizedFlags, validateToolNames } from "./cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { selectSession } from "./cli/session-picker";
import { applyStartupCwd } from "./cli/startup-cwd";
import { getLatestRelease } from "./cli/update-cli";
import { findConfigFile } from "./config";
import { ModelRegistry } from "./config/model-registry";
import {
	DEFAULT_PREWALK_TARGET,
	expandRoleAlias,
	formatModelSelectorValue,
	getModelMatchPreferences,
	parseModelString,
	type ResolveCliModelResult,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
	resolveModelScope,
	type ScopedModel,
} from "./config/model-resolver";
import { ModelsConfigFile } from "./config/models-config";
import { resolveConfigValue } from "./config/resolve-config-value";
import { serviceTierSettingToTier } from "./config/service-tier";
import { getDefault, type SettingPath, Settings, type SettingValue, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
	shouldPreloadPluginRoots,
} from "./discovery/helpers";
import { injectOmpExtensionCliRoots } from "./discovery/proto-extension-roots";
import { formatExtensionLoadNotifications, formatExtensionLoadWarnings } from "./extensibility/extensions/load-errors";
import { loadExtensions } from "./extensibility/extensions/loader";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "./extensibility/plugins/marketplace-auto-update";
import { registerDaemonProjectPresence } from "./launch/presence";
import type { MCPManager } from "./mcp";
import { InteractiveMode } from "./modes/interactive-mode";
import type { PrintModeOptions } from "./modes/print-mode";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { CURRENT_SETUP_VERSION } from "./modes/setup-version";
import type * as SetupWizardModule from "./modes/setup-wizard";
import type { SetupScene } from "./modes/setup-wizard";
import {
	applyStartupComposerPreferences,
	type ComposerLease,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "./modes/startup-composer";
import { ensureTheme, initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { createWarpEventBridgeExtension } from "./modes/warp-events";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	loadSessionExtensions,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";
import {
	describeAuthBrokerStartupError,
	loadEffectiveAuthAccountPolicyConfig,
	resolveAuthBrokerConfig,
} from "./session/auth-broker-config";
import { AuthStorage } from "./session/auth-storage";
import { describePendingToolCalls } from "./session/exit-diagnostics";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "./session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./session/foreign-session-store";
import { findMostRecentSession, resolveResumableSession, type SessionInfo } from "./session/session-listing";
import { claimSessionOwnership, liveSessionOwnerPid } from "./session/session-liveness";
import { ForkSourceNotFoundError, SessionManager } from "./session/session-manager";
import { describeDirectoryFailure, SessionDirectoryError } from "./session/session-paths";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "./system-prompt";
import { createPersistedSubagentReviverFactory } from "./task/persisted-revive";
import { createTelemetryExportConfig, initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import { parseThinkingLevel } from "./thinking";
import { getChangelogPath, resolveStartupChangelogForDisplay, type StartupChangelogSelection } from "./utils/changelog";
import { EventBus } from "./utils/event-bus";

type RunAcpMode = (createSession: AcpSessionFactory) => Promise<never>;
type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;
type RunRpcMode = (
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input?: ReadableStream<Uint8Array>,
) => Promise<never>;

export function writeStartupNotice(parsedArgs: Pick<Args, "mode">, text: string): void {
	(parsedArgs.mode === "json" ? process.stderr : process.stdout).write(text);
}

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return;
	}
	try {
		const release = await getLatestRelease({ timeoutMs: 5_000 });
		return Bun.semver.order(release.version, currentVersion) > 0 ? release.version : undefined;
	} catch {
		return undefined;
	}
}

const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"orchestrator.isolation.mode",
	"orchestrator.isolation.apply",
	"orchestrator.isolation.merge",
	"orchestrator.isolation.commits",
	"orchestrator.maxConcurrency",
	"orchestrator.maxRecursionDepth",
	"orchestrator.disabledAgents",
	"orchestrator.agentModelOverrides",
	"orchestrator.agentPrewalk",
	"orchestrator.agentAdvisor",

	"advisor.enabled",
	"advisor.syncBacklog",
	"advisor.immuneTurns",
	"tier.advisor",
];

const RPC_BACKGROUND_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
];

function applyDefaultSettingOverrides(settingPaths: SettingPath[], targetSettings: Settings): void {
	for (const settingPath of settingPaths) {
		if (targetSettings.isConfigured(settingPath)) continue;
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

function applyRpcDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
	applyDefaultSettingOverrides(RPC_BACKGROUND_DEFAULTED_SETTING_PATHS, targetSettings);
}

function applyAcpDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
}

export async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY === true) return undefined;

	const notice = isBunTestRuntime()
		? undefined
		: setTimeout(() => {
				process.stderr.write(
					`${chalk.dim("Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…")}\n`,
				);
			}, 1000);
	notice?.unref?.();
	try {
		const text = await Bun.stdin.text();
		if (text.trim().length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	} finally {
		clearTimeout(notice);
	}
}

const STARTUP_WATCHDOG_INTERVAL_MS = 10_000;
let startupWatchdogTimer: NodeJS.Timeout | undefined;
let startupWatchdogActive = false;
let startupWatchdogStartedAt = 0;

function armStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	if (startupWatchdogTimer) return;
	startupWatchdogTimer = setInterval(() => {
		const elapsed = Math.round((Date.now() - startupWatchdogStartedAt) / 1000);
		const phase = logger.openSpanPath().join(" > ") || "module load / pre-phase work";
		process.stderr.write(
			`${chalk.yellow(`Still starting after ${elapsed}s`)}${chalk.dim(` — phase: ${phase}`)}\n` +
				`${chalk.dim(`  logs: ${getLogPath()} · re-run with PI_DEBUG_STARTUP=1 for streaming phase markers`)}\n`,
		);
	}, STARTUP_WATCHDOG_INTERVAL_MS);
	startupWatchdogTimer.unref?.();
}

function disarmStartupWatchdog(): void {
	if (!startupWatchdogTimer) return;
	clearInterval(startupWatchdogTimer);
	startupWatchdogTimer = undefined;
}

function startStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	startupWatchdogActive = true;
	startupWatchdogStartedAt = Date.now();
	armStartupWatchdog();
}

function stopStartupWatchdog(): void {
	startupWatchdogActive = false;
	disarmStartupWatchdog();
}

function pauseStartupWatchdog(): void {
	disarmStartupWatchdog();
}

function resumeStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	if (startupWatchdogActive) armStartupWatchdog();
}

interface InteractiveModeNotify {
	kind: "warn" | "error" | "info";
	message: string;
}

export function buildModelScopeNotification(
	scopedModelsForDisplay: readonly Pick<ScopedModel, "model" | "thinkingLevel" | "explicitThinkingLevel">[],
	startupQuiet: boolean,
): InteractiveModeNotify | null {
	if (startupQuiet || scopedModelsForDisplay.length === 0) {
		return null;
	}
	const modelList = scopedModelsForDisplay
		.map(scopedModel => {
			const thinkingStr =
				scopedModel.explicitThinkingLevel && scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
			return `${scopedModel.model.id}${thinkingStr}`;
		})
		.join(", ");
	return { kind: "info", message: `Model scope: ${modelList} (Ctrl+P to cycle)` };
}
export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		"markPendingSubmissionStarted" | "finishPendingSubmission" | "showError" | "checkShutdownRequested"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage" | "isStreaming">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		using _keepalive = new EventLoopKeepalive();

		const streamingBehavior = input.streamingBehavior ?? ("followUp" as const);

		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		if (input.customType) {
			const message = {
				customType: input.customType,
				content: input.text,
				display: input.display ?? false,
				attribution: "agent" as const,
			};
			await session.promptCustomMessage(message, { streamingBehavior });
		} else if (input.synthetic) {
			await session.prompt(input.text, {
				synthetic: true,
				expandPromptTemplates: false,
				userInitiated: input.userInitiated,
			});
		} else {
			await session.prompt(input.text, { images: input.images, streamingBehavior });
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}

interface AcpSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

type AcpSessionFactory = (cwd: string, options?: { interactivePrompts?: boolean }) => Promise<AcpSessionHandle>;

interface AcpSessionFactoryOptions {
	baseOptions: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "apiKey" | "trustedExtensions" | "tools">;
	rawArgs: string[];
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

async function loadTrustedSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "additionalExtensionPaths">,
	cwd: string,
	eventBus: EventBus,
) {
	const paths = options.additionalExtensionPaths ?? [];
	for (const trustedPath of paths) {
		let stat: fsSync.Stats;
		try {
			stat = fsSync.statSync(trustedPath);
		} catch {
			throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
		}
		if (!stat.isFile()) {
			throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
		}
	}
	return loadExtensions(paths, cwd, eventBus);
}

export function createAcpSessionFactory(args: AcpSessionFactoryOptions): AcpSessionFactory {
	return async (cwd, factoryOptions) => {
		const nextSettings = await args.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, args.sessionDir);
		const agentId = `acp:${nextSessionManager.getSessionId()}`;

		const titleSystemPromptSource = discoverTitleSystemPromptFile(cwd);
		const titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		const eventBus = new EventBus();
		const trustedExtensions =
			args.parsedArgs.trustedExtensions && args.parsedArgs.trustedExtensions.length > 0
				? await loadTrustedSessionExtensions(args.baseOptions, cwd, eventBus)
				: undefined;
		if (trustedExtensions && trustedExtensions.errors.length > 0) {
			throw new Error(
				`Trusted extension failed to load: ${trustedExtensions.errors.map(item => item.error).join("; ")}`,
			);
		}
		const { session: nextSession, setToolUIContext } = await args.createSession({
			...args.baseOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage: args.authStorage,
			modelRegistry: args.modelRegistry,
			agentId,

			interactivePrompts: factoryOptions?.interactivePrompts,
			deferUsageReserveConfirmation: true,
			enableMCP: false,
			titleSystemPrompt,
			eventBus,
			preloadedExtensions: trustedExtensions,
		});
		if (args.parsedArgs.apiKey && !args.baseOptions.model && nextSession.model) {
			args.authStorage.setRuntimeApiKey(nextSession.model.provider, args.parsedArgs.apiKey);
		}
		const runner = nextSession.extensionRunner;
		const reparsedArgs = applyExtensionFlags(
			runner
				? {
						getFlags: () => runner.getFlags(),
						setFlagValue: (name, value) => {
							runner.setFlagValue(name, value);
						},
					}
				: undefined,
			args.rawArgs,
		);
		const requestedTools = reparsedArgs?.tools ?? args.parsedArgs.tools;
		if (requestedTools) {
			try {
				validateToolNames(requestedTools, nextSession.getAllToolNames());
			} catch (error) {
				await nextSession.dispose();
				throw error;
			}
		}
		return { session: nextSession, setToolUIContext };
	};
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	startupChangelog: StartupChangelogSelection | undefined,
	notifs: (InteractiveModeNotify | null)[],
	versionCheckPromise: Promise<string | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	mcpManager: MCPManager | undefined,
	resuming: boolean,
	forceSetupWizard: boolean,
	eventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
	startupLease?: ComposerLease,
): Promise<void> {
	let mode: InteractiveMode;
	try {
		mode = new InteractiveMode(
			session,
			version,
			startupChangelog,
			setExtensionUIContext,
			mcpManager,
			eventBus,
			startupLease?.composer,
		);
		startupLease?.adopt();
	} catch (error) {
		startupLease?.dispose();
		throw error;
	}

	let setupWizard: typeof SetupWizardModule | undefined;
	let setupScenes: SetupScene[] = [];
	try {
		const storedSetupVersion = settings.get("setupVersion");
		setupWizard =
			forceSetupWizard || storedSetupVersion < CURRENT_SETUP_VERSION
				? await import("./modes/setup-wizard")
				: undefined;
		setupScenes = setupWizard
			? await setupWizard.selectSetupScenes(storedSetupVersion, setupWizard.ALL_SCENES, mode, {
					resuming,
					isTTY: process.stdin.isTTY && process.stdout.isTTY,
					setupWizardEnabled: settings.get("startup.setupWizard"),
					force: forceSetupWizard,
				})
			: [];

		await mode.init();
	} catch (error) {
		mode.stop();
		throw error;
	}

	let setupCancelledNotice: string | undefined;
	if (setupWizard && setupScenes.length > 0) {
		const outcome = await setupWizard.runSetupWizard(mode, setupScenes);
		if (outcome === "cancelled") setupCancelledNotice = setupWizard.SETUP_CANCELLED_NOTICE;
	}

	const checkedVersionPromise = versionCheckPromise.catch(() => undefined);

	await mode.renderInitialMessages({
		preserveExistingChat: true,
		clearTerminalHistory: settings.get("startup.clearScrollback"),
	});

	// Surfaced after the initial render so the notice is not wiped by the scrollback clear.
	if (setupCancelledNotice) mode.showWarning(setupCancelledNotice);
	const advisorConfigWarnings = session.getAdvisorConfigWarnings();
	if (advisorConfigWarnings.length > 0) mode.showWarning(`WATCHDOG.yml: ${advisorConfigWarnings.join("; ")}`);

	checkedVersionPromise.then(newVersion => {
		if (!settings.get("startup.checkUpdate")) {
			return;
		}
		if (newVersion) {
			mode.showNewVersionNotification(newVersion);
		}
	});

	for (const notify of notifs) {
		if (!notify) {
			continue;
		}
		if (notify.kind === "warn") {
			mode.showWarning(notify.message);
		} else if (notify.kind === "error") {
			mode.showError(notify.message);
		} else if (notify.kind === "info") {
			mode.showStatus(notify.message);
		}
	}

	if (initialMessage !== undefined) {
		session.maybeStartTitleGeneration(initialMessage);
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		session.maybeStartTitleGeneration(message);
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(message);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	while (true) {
		const input = await mode.getUserInput();
		await submitInteractiveInput(mode, session, input);
	}
}

type SessionPromptResult = "accepted" | "declined" | "unavailable";

type SessionPrompt = (session: SessionInfo) => Promise<SessionPromptResult>;

async function promptMoveSession(session: SessionInfo): Promise<SessionPromptResult> {
	if (!process.stdin.isTTY) {
		return "unavailable";
	}
	const message = `Session's directory no longer exists (${session.cwd}). Move (re-root) it into the current directory? [Y/n] `;
	pauseStartupWatchdog();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes" ? "accepted" : "declined";
	} finally {
		rl.close();
		resumeStartupWatchdog();
	}
}

export class SessionResolutionError extends Error {
	readonly hint?: string;
	constructor(message: string, hint?: string) {
		super(message);
		this.name = "SessionResolutionError";
		this.hint = hint;
	}
}

function resolveForeignSessionSource(
	parsed: Pick<Args, "continue" | "fork" | "fromClaude" | "fromCodex" | "noSession" | "resume">,
): ForeignSessionSource | undefined {
	if (parsed.fromClaude && parsed.fromCodex) {
		throw new SessionResolutionError("--from-claude and --from-codex cannot be used together");
	}
	const source = parsed.fromClaude ? "claude" : parsed.fromCodex ? "codex" : undefined;
	if (!source) return undefined;
	if (parsed.noSession) {
		throw new SessionResolutionError(`--from-${source} requires session persistence`);
	}
	if (parsed.continue || parsed.resume || parsed.fork) {
		throw new SessionResolutionError(`--from-${source} cannot be combined with --continue, --resume, or --fork`);
	}
	return source;
}

function isForeignSessionImport(parsed: Pick<Args, "fromClaude" | "fromCodex">): boolean {
	return parsed.fromClaude === true || parsed.fromCodex === true;
}

type MissingCwdMoveResult =
	| { status: "not-needed" }
	| { status: "declined" }
	| { status: "moved"; manager: SessionManager };

async function moveMissingCwdSessionIfNeeded(
	sessionArg: string,
	session: SessionInfo,
	cwd: string,
	sessionDir: string | undefined,
	askToMoveSession: SessionPrompt,
): Promise<MissingCwdMoveResult> {
	const sourceCwd = session.cwd;
	if (!sourceCwd || fsSync.existsSync(sourceCwd)) {
		return { status: "not-needed" };
	}

	const movePromptResult = await askToMoveSession(session);
	if (movePromptResult === "unavailable") {
		throw new SessionResolutionError(
			`Session "${sessionArg}" belongs to a directory that no longer exists (${sourceCwd}); run interactively to move it into the current project.`,
		);
	}
	if (movePromptResult === "declined") {
		return { status: "declined" };
	}

	const manager = await SessionManager.open(session.path, sessionDir, undefined, { initialCwd: sourceCwd });
	await manager.moveTo(cwd, sessionDir);
	return { status: "moved", manager };
}

/** `unenterable` names the resumed project when startup stayed in the launch directory instead. */
type ResumedProject = { cwd: string; unenterable?: string };

/**
 * Move startup into a resumed session's project. A project that exists but cannot be entered (macOS TCC denial), or
 * whose settings/plugins fail to load, leaves startup in the launch directory with the session tracking it
 * runtime-only; a deleted project is skipped silently, as before.
 */
async function switchToResumedProject(
	resumedCwd: string | undefined,
	activeSettings: Settings,
	pluginPreloadPromise: Promise<unknown>,
	preloadPluginRootsEnabled: boolean,
	sessionManager: SessionManager | undefined,
): Promise<ResumedProject> {
	const launchCwd = getProjectDir();
	if (
		!resumedCwd ||
		normalizePathForComparison(resumedCwd) === normalizePathForComparison(launchCwd) ||
		(await directoryIsMissing(resumedCwd))
	) {
		return { cwd: launchCwd };
	}

	await pluginPreloadPromise.catch(() => {});
	try {
		setProjectDir(resumedCwd);
	} catch (error) {
		logger.warn("Could not switch to resumed project directory", { cwd: resumedCwd, error: String(error) });
		sessionManager?.setCwdWithoutRelocation(launchCwd);
		return { cwd: launchCwd, unenterable: resumedCwd };
	}
	const rescope = async (cwd: string): Promise<void> => {
		clearPluginRootsAndCaches();
		resetCapabilities();
		if (preloadPluginRootsEnabled) await preloadPluginRoots(os.homedir(), cwd);
		await activeSettings.reloadForCwd(cwd);
	};
	const cwd = getProjectDir();
	try {
		await rescope(cwd);
	} catch (error) {
		// The process already sits in the target: undo the whole transition rather than build the session with
		// target-scoped cwd and launch-scoped settings.
		logger.warn("Could not rescope to resumed project directory", { cwd, error: String(error) });
		try {
			setProjectDir(launchCwd);
			sessionManager?.setCwdWithoutRelocation(launchCwd);
			await rescope(launchCwd);
		} catch (rollbackError) {
			throw new SessionResolutionError(
				`Could not switch to resumed project ${resumedCwd} (${error instanceof Error ? error.message : String(error)}); failed to restore launch directory ${launchCwd}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		return { cwd: launchCwd, unenterable: resumedCwd };
	}
	// The session may have fallen back before the chdir proved the project enterable.
	if (sessionManager && normalizePathForComparison(sessionManager.getCwd()) !== normalizePathForComparison(cwd)) {
		sessionManager.adoptRecordedCwd();
	}
	return { cwd };
}

function notifyResumedProjectFallback(parsedArgs: Args, resumed: ResumedProject): void {
	if (!resumed.unenterable) return;
	writeStartupNotice(
		parsedArgs,
		`${chalk.yellow(`Could not switch to resumed project ${resumed.unenterable}; staying in ${resumed.cwd}.`)}\n`,
	);
}

export async function resolveScopedModels(
	parsed: Args,
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "getDiscoverableProviders" | "refresh">,
	activeSettings: Settings,
	/** Only the startup resolution reports; later re-resolutions would repeat the same warnings. */
	options?: { reportUnmatched?: boolean; write?: (text: string) => void },
): Promise<ScopedModel[]> {
	const modelPatterns = parsed.models ?? activeSettings.get("enabledModels");
	if (!modelPatterns || modelPatterns.length === 0) {
		return [];
	}
	const preferences = getModelMatchPreferences(activeSettings);
	// A pattern the user typed on the command line deserves an answer; patterns from settings stay
	// quiet because they would warn on every single start.
	const report = options?.reportUnmatched === true && parsed.models !== undefined;
	const write = options?.write ?? ((text: string) => process.stderr.write(text));
	const unmatched = new Set<string>();
	const collect = report ? { onUnmatchedPattern: (pattern: string) => unmatched.add(pattern) } : undefined;
	const warnUnmatched = (): void => {
		for (const pattern of unmatched) {
			write(`${chalk.yellow(`Warning: --models pattern "${pattern}" matched no available model; ignoring it.`)}\n`);
		}
	};
	const scopedModels = await resolveModelScope(modelPatterns, modelRegistry, preferences, activeSettings, collect);
	if (scopedModels.length > 0 || modelRegistry.getDiscoverableProviders().length === 0) {
		warnUnmatched();
		return scopedModels;
	}
	unmatched.clear();
	await modelRegistry.refresh("online-if-uncached");
	const afterRefresh = await resolveModelScope(modelPatterns, modelRegistry, preferences, activeSettings, collect);
	warnUnmatched();
	return afterRefresh;
}

/**
 * `--smol` and `--slow` only set role patterns, so a typo used to disappear: the role quietly fell
 * back and the run continued on a different model than the one that was asked for.
 */
export function warnUnresolvableModelRoleFlags(
	parsed: Args,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
	write: (text: string) => void = text => process.stderr.write(text),
): void {
	const preferences = getModelMatchPreferences(activeSettings);
	for (const [flag, value] of [
		["--smol", parsed.smol],
		["--slow", parsed.slow],
	] as const) {
		if (!value) continue;
		const resolved = resolveCliModel({ cliModel: value, modelRegistry, settings: activeSettings, preferences });
		if (resolved.model && !resolved.error) continue;
		const role = flag === "--smol" ? "smol" : "slow";
		write(
			`${chalk.yellow(`Warning: ${flag} model "${value}" not found; the ${role} role falls back to its default.`)}\n`,
		);
	}
}

export function toSessionScopedModels(
	scopedModels: readonly ScopedModel[],
	activeSettings: Settings,
): Array<{ model: Model; thinkingLevel?: ThinkingLevel }> {
	if (scopedModels.length === 0) return [];
	const defaultThinkingLevel = parseThinkingLevel(activeSettings.get("defaultThinkingLevel"));
	return scopedModels.map(scopedModel => ({
		model: scopedModel.model,
		thinkingLevel: scopedModel.explicitThinkingLevel
			? (scopedModel.thinkingLevel ?? defaultThinkingLevel)
			: defaultThinkingLevel,
	}));
}

function sameScopedModelSet(a: ReadonlyArray<{ model: Model }>, b: ReadonlyArray<{ model: Model }>): boolean {
	if (a.length !== b.length) return false;
	const keys = new Set(a.map(entry => `${entry.model.provider}/${entry.model.id}`));
	return b.every(entry => keys.has(`${entry.model.provider}/${entry.model.id}`));
}

export interface ScopedModelSink {
	readonly isDisposed: boolean;
	readonly scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void;
}

export async function rebuildScopedModelsAfterDiscovery(
	session: ScopedModelSink,
	parsed: Args,
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "awaitBackgroundRefresh">,
	activeSettings: Settings,
): Promise<void> {
	const patterns = parsed.models ?? activeSettings.get("enabledModels");
	if (!patterns || patterns.length === 0) return;
	await modelRegistry.awaitBackgroundRefresh();
	if (session.isDisposed) return;
	const rebuilt = await resolveModelScope(
		patterns,
		modelRegistry,
		getModelMatchPreferences(activeSettings),
		activeSettings,
	);
	const mapped = toSessionScopedModels(rebuilt, activeSettings);
	if (mapped.length === 0 || sameScopedModelSet(session.scopedModels, mapped)) return;
	session.setScopedModels(mapped);
}

async function getChangelogForDisplay(
	parsed: Args,
	mode: SettingValue<"startup.changelogMode">,
): Promise<StartupChangelogSelection | undefined> {
	if (parsed.continue || parsed.resume || isForeignSessionImport(parsed)) {
		return undefined;
	}

	return resolveStartupChangelogForDisplay({
		mode,
		currentVersion: VERSION,
		changelogPath: getChangelogPath(),
	});
}

const SESSION_ID_ARG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeContinueSessionArgs(parsed: Args, rawArgs?: readonly string[]): void {
	if (!parsed.continue || parsed.resume || parsed.fork) return;

	let message: string | undefined;
	if (parsed.unrecognizedFlags.length === 0 && parsed.messages.length === 1) {
		message = parsed.messages[0]?.trim();
	} else if (rawArgs) {
		const continueIndex = rawArgs.findIndex(arg => arg === "--continue" || arg === "-c");
		message = rawArgs[continueIndex + 1]?.trim();
	}
	if (!message || !SESSION_ID_ARG_RE.test(message)) return;

	const messageIndex = parsed.messages.indexOf(message);
	if (messageIndex === -1) return;
	parsed.resume = message;
	parsed.continue = false;
	parsed.messages.splice(messageIndex, 1);
}

const FORK_NOT_FOUND_HINT =
	"Run `proto --resume` without an argument to pick from recent sessions, or `proto` to start a new one.";

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
	askToMoveSession: SessionPrompt = promptMoveSession,
): Promise<SessionManager | undefined> {
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new SessionResolutionError("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		const isPath = forkSource.includes("/") || forkSource.includes("\\") || forkSource.endsWith(".jsonl");
		const match = isPath ? undefined : await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!isPath && !match)
			throw new SessionResolutionError(`Session "${forkSource}" not found.`, FORK_NOT_FOUND_HINT);
		try {
			return await SessionManager.forkFrom(match?.session.path ?? forkSource, cwd, parsed.sessionDir);
		} catch (err) {
			// A listed session can vanish between resolution and fork.
			if (err instanceof ForkSourceNotFoundError) {
				throw new SessionResolutionError(`Session "${forkSource}" not found.`, FORK_NOT_FOUND_HINT);
			}
			throw err;
		}
	}

	normalizeContinueSessionArgs(parsed);
	if (parsed.noSession && typeof parsed.resume !== "string" && !parsed.continue) {
		return SessionManager.inMemory(cwd);
	}
	const openSession = async (sessionPath: string): Promise<SessionManager> => {
		if (!parsed.noSession) {
			// A session file is owned by one live process: resuming it here would
			// silently persist nothing. The claim is taken before the file is read so
			// that two processes starting at the same moment cannot both proceed.
			if (!claimSessionOwnership(sessionPath)) {
				const ownerPid = liveSessionOwnerPid(sessionPath);
				const owner = ownerPid === undefined ? "Another proto process" : `Another proto process (pid ${ownerPid})`;
				throw new SessionResolutionError(
					`${owner} is currently using this session — release it there before resuming here.`,
					`Run \`proto --fork ${sessionPath}\` to continue in a copy, or close the other process first.`,
				);
			}
			return SessionManager.open(sessionPath, parsed.sessionDir);
		}
		const manager = SessionManager.inMemory(cwd);
		await manager.setSessionFile(sessionPath);
		return manager;
	};

	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			return await openSession(sessionArg);
		}
		const match = await resolveResumableSession(sessionArg, cwd, parsed.sessionDir);
		if (!match) {
			throw new SessionResolutionError(
				`Session "${sessionArg}" not found.`,
				"Run `proto --resume` without an argument to pick from recent sessions, or `proto` to start a new one.",
			);
		}
		if (!parsed.noSession && match.scope === "local") {
			const moveResult = await moveMissingCwdSessionIfNeeded(
				sessionArg,
				match.session,
				cwd,
				parsed.sessionDir,
				askToMoveSession,
			);
			if (moveResult.status === "moved") {
				return moveResult.manager;
			}
			if (moveResult.status === "declined") {
				return undefined;
			}
		}
		if (!parsed.noSession && match.scope === "global") {
			const moveResult = await moveMissingCwdSessionIfNeeded(
				sessionArg,
				match.session,
				cwd,
				parsed.sessionDir,
				askToMoveSession,
			);
			if (moveResult.status === "moved") {
				return moveResult.manager;
			}
			if (moveResult.status === "declined") {
				return undefined;
			}
		}
		return await openSession(match.session.path);
	}
	if (parsed.continue) {
		if (parsed.noSession) {
			const sessionDir = parsed.sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
			const recent = await findMostRecentSession(sessionDir);
			return recent ? openSession(recent) : SessionManager.inMemory(cwd);
		}
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}

	if (parsed.sessionDir) {
		const manager = SessionManager.create(cwd, parsed.sessionDir);
		claimSessionOwnership(manager.getSessionFile());
		return manager;
	}

	if (activeSettings.get("autoResume")) {
		// autoResume is our default, not an explicit request: an unwritable session directory
		// degrades to an unpersisted run instead of refusing to start.
		let manager: SessionManager;
		try {
			manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
		} catch (error) {
			if (!(error instanceof SessionDirectoryError)) throw error;
			const unpersisted = SessionManager.inMemory(cwd);
			unpersisted.markPersistenceUnavailable(error);
			return unpersisted;
		}
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}

	return undefined;
}

function discoverSystemPromptFile(): string | undefined {
	const projectPath = findConfigFile("SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}

	const globalPath = findConfigFile("SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

function discoverAppendSystemPromptFile(): string | undefined {
	const projectPath = findConfigFile("APPEND_SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("APPEND_SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

export function applyResolvedSystemPromptInputs(
	options: CreateAgentSessionOptions,
	resolvedSystemPrompt: string | undefined,
	resolvedAppendPrompt: string | undefined,
): void {
	if (resolvedSystemPrompt) {
		options.customSystemPrompt = resolvedSystemPrompt;
	}
	if (resolvedAppendPrompt) {
		options.appendSystemPrompt = resolvedAppendPrompt;
	}
}

export async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): Promise<CreateAgentSessionOptions> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
	};
	const restoringSession = Boolean(parsed.continue || parsed.resume || isForeignSessionImport(parsed));
	if (parsed.serviceTier !== undefined) {
		options.openAIServiceTier = serviceTierSettingToTier(parsed.serviceTier) ?? null;
	}
	const cliDirs = parsed.addDir ?? [];
	const settingsDirs = activeSettings.get("workspace.additionalDirectories");
	if (cliDirs.length > 0 || settingsDirs.length > 0) {
		options.additionalDirectories = [...new Set([...cliDirs, ...settingsDirs])];
	}
	if (parsed.maxTime !== undefined) {
		options.deadline = Date.now() + parsed.maxTime * 1000;
	}

	const systemPromptSource = parsed.systemPrompt ?? discoverSystemPromptFile();
	const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();
	const titleSystemPromptSource = discoverTitleSystemPromptFile();
	const [resolvedSystemPrompt, resolvedAppendPrompt, titleSystemPrompt] = await Promise.all([
		resolvePromptInput(systemPromptSource, "system prompt"),
		resolvePromptInput(appendPromptSource, "append system prompt"),
		resolvePromptInput(titleSystemPromptSource, "title system prompt"),
	]);

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}
	if (parsed.providerPromptCacheKey) {
		options.providerPromptCacheKey = parsed.providerPromptCacheKey;
		options.providerPromptCacheKeySource = "explicit";
	} else {
		const header = sessionManager?.getHeader();
		const scopedModelOverride = scopedModels.length > 0 && !restoringSession;
		const forkCacheShapeChanged =
			scopedModelOverride ||
			parsed.model !== undefined ||
			parsed.thinking !== undefined ||
			parsed.systemPrompt !== undefined ||
			parsed.appendSystemPrompt !== undefined ||
			parsed.tools !== undefined ||
			parsed.noTools === true;
		if (!forkCacheShapeChanged && header?.providerPromptCacheKey) {
			options.providerPromptCacheKey = header.providerPromptCacheKey;
			options.providerPromptCacheKeySource = "fork";
		}
	}

	const modelMatchPreferences = getModelMatchPreferences(activeSettings);
	// `--model` rewrites the session `default` role below; explicit prewalk role targets resolve against the
	// value configured when the CLI was invoked.
	const preModelOverrideDefaultRole = activeSettings.getModelRole("default");

	let deferredDefaultRole = false;
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			availableModels: modelRegistry.getAvailable(),
			settings: activeSettings,
			preferences: modelMatchPreferences,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		const matchedAfterMissingRolePattern = (resolved.configuredPatternIndex ?? 0) > 0;
		if (matchedAfterMissingRolePattern) {
			options.modelPattern = parsed.model;
		} else if (resolved.error) {
			if (!parsed.provider && ((resolved.configuredPatterns?.length ?? 0) > 0 || !parsed.model.includes(":"))) {
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(1);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			options.rebindModelAfterDiscovery = true;
			// The recorded role must carry the effort the session starts at, or the first cycle back into
			// `default` drops it.
			activeSettings.overrideModelRoles({
				default: formatModelSelectorValue(
					resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
					parsed.thinking ?? resolved.thinkingLevel,
				),
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	} else if (scopedModels.length > 0 && !restoringSession) {
		const remembered = activeSettings.getModelRole("default");
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings: activeSettings,
					matchPreferences: modelMatchPreferences,
				},
			);
			const rememberedResolvedModel = rememberedSpec.model;
			const rememberedModel = rememberedResolvedModel
				? scopedModels.find(
						scopedModel =>
							scopedModel.model.provider === rememberedResolvedModel.provider &&
							scopedModel.model.id === rememberedResolvedModel.id,
					)
				: scopedModels.find(scopedModel => scopedModel.model.id.toLowerCase() === remembered.toLowerCase());
			if (rememberedModel) {
				options.model = rememberedModel.model;
				options.rebindModelAfterDiscovery = true;

				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
				}
			}
		}

		deferredDefaultRole = !options.model && Boolean(remembered) && !((parsed.models?.length ?? 0) > 0);
		if (!options.model && !deferredDefaultRole) {
			options.model = scopedModels[0].model;
			options.rebindModelAfterDiscovery = true;
		}
	} else if ((parsed.models?.length ?? 0) > 0 && !restoringSession) {
		options.modelPattern = parsed.models;
	}

	if (parsed.noPrewalk && (parsed.prewalk || parsed.prewalkInto !== undefined)) {
		throw new Error("--no-prewalk cannot be combined with --prewalk or --prewalk-into");
	}
	const explicitPrewalk = parsed.prewalk === true || parsed.prewalkInto !== undefined;
	const prewalkEnabled = parsed.noPrewalk
		? false
		: explicitPrewalk
			? true
			: !restoringSession && activeSettings.get("prewalk.enabled");
	if (prewalkEnabled) {
		const target = parsed.prewalkInto ?? DEFAULT_PREWALK_TARGET;
		let targetPatterns: string[];
		if (parsed.prewalkInto === undefined) {
			targetPatterns = [expandRoleAlias(DEFAULT_PREWALK_TARGET, activeSettings)];
		} else {
			// Only the `default` role is mutated by `--model`; every other role lookup stays live.
			const preModelOverrideRoleLookup = {
				getModelRole: (role: string) =>
					role === "default" ? preModelOverrideDefaultRole : activeSettings.getModelRole(role),
			};
			const targetSelector =
				target.trim() === "default" ? expandRoleAlias(target, preModelOverrideRoleLookup) : target;
			const configuredPatterns = resolveConfiguredModelPatterns(targetSelector, preModelOverrideRoleLookup);
			targetPatterns = configuredPatterns.length > 0 ? configuredPatterns : [targetSelector];
		}

		const resolveCandidate = (pattern: string): ResolveCliModelResult =>
			resolveCliModel({ cliModel: pattern, modelRegistry, preferences: modelMatchPreferences });
		const discoverableProviders = new Map(
			modelRegistry.getDiscoverableProviders().map(provider => [provider.toLowerCase(), provider]),
		);
		const refreshedProviders = new Set<string>();
		let authenticatedResolution: ResolveCliModelResult | undefined;
		let firstUnauthenticatedResolution: ResolveCliModelResult | undefined;
		let lastResolution: ResolveCliModelResult | undefined;
		// A target served by a configured discovery provider is absent from the cold startup catalog. Each
		// candidate, in priority order, gets one discovery pass scoped to the provider it names, so a typo or
		// extension-only target degrades without awaiting unrelated providers.
		for (const pattern of targetPatterns) {
			let candidate = resolveCandidate(pattern);
			lastResolution = candidate;
			if (candidate.model && modelRegistry.hasConfiguredAuth(candidate.model)) {
				authenticatedResolution = candidate;
				break;
			}
			if (candidate.model) {
				firstUnauthenticatedResolution ??= candidate;
				continue;
			}

			const requestedProvider = parseModelString(pattern)?.provider.toLowerCase();
			if (!requestedProvider || refreshedProviders.has(requestedProvider)) continue;
			const discoverableProvider = discoverableProviders.get(requestedProvider);
			if (!discoverableProvider) continue;
			refreshedProviders.add(requestedProvider);
			await modelRegistry.refreshDiscoverableProviders([discoverableProvider], "online-if-uncached");

			candidate = resolveCandidate(pattern);
			lastResolution = candidate;
			if (candidate.model && modelRegistry.hasConfiguredAuth(candidate.model)) {
				authenticatedResolution = candidate;
				break;
			}
			if (candidate.model) firstUnauthenticatedResolution ??= candidate;
		}
		const resolved =
			authenticatedResolution ??
			firstUnauthenticatedResolution ??
			lastResolution ??
			resolveCandidate(targetPatterns[0] ?? target);
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}

		if (resolved.error || !resolved.model) {
			process.stderr.write(
				`${chalk.yellow(`Warning: prewalk disabled — ${resolved.error ?? `model "${target}" not found`}`)}\n`,
			);
		} else if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			process.stderr.write(
				`${chalk.yellow(`Warning: prewalk disabled — no API key for ${resolved.model.provider}/${resolved.model.id}`)}\n`,
			);
		} else {
			options.prewalk = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}

	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		!deferredDefaultRole &&
		!restoringSession
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	if (scopedModels.length > 0) {
		options.scopedModels = toSessionScopedModels(scopedModels, activeSettings);
	}

	applyResolvedSystemPromptInputs(options, resolvedSystemPrompt, resolvedAppendPrompt);

	if (titleSystemPrompt) {
		options.titleSystemPrompt = titleSystemPrompt;
	}

	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
		options.enableMCP = false;
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.skills && parsed.skills.length > 0) {
		activeSettings.override("skills.includeSkills", parsed.skills as string[]);
	}

	if (parsed.noRules) {
		options.rules = [];
	}

	if (parsed.trustedExtensions && parsed.trustedExtensions.length > 0) {
		const trustedPaths = parsed.trustedExtensions.map(trustedPath => {
			let resolvedPath: string;
			let stat: fsSync.Stats;
			try {
				resolvedPath = fsSync.realpathSync.native(trustedPath);
				stat = fsSync.statSync(resolvedPath);
			} catch {
				throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
			}
			if (!stat.isFile()) {
				throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
			}
			return resolvedPath;
		});
		options.disableExtensionDiscovery = true;
		options.additionalExtensionPaths = trustedPaths;
	} else {
		const cliExtensionPaths = [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
		if (cliExtensionPaths.length > 0) {
			options.additionalExtensionPaths = cliExtensionPaths;
		}

		if (parsed.noExtensions) {
			options.disableExtensionDiscovery = true;
		}
	}

	return options;
}

interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	selectSession?: typeof selectSession;
	runAcpMode?: RunAcpMode;
	createForeignSessionStore?: (source: ForeignSessionSource) => ForeignSessionStore;
	settings?: Settings;
	forceSetupWizard?: boolean;
}
async function reuseLocalAuthStorage(settingsInstance: Settings): Promise<AuthStorage | undefined> {
	const storage = settingsInstance.getStorage();
	if (!storage || (await resolveAuthBrokerConfig())) return undefined;

	const { accountPolicies, defaultReservePct } = await loadEffectiveAuthAccountPolicyConfig({
		settings: settingsInstance,
	});
	const authStorage = new AuthStorage(storage.authStore, {
		configValueResolver: resolveConfigValue,
		sourceLabel: `local ${getAgentDbPath(settingsInstance.getAgentDir())}`,
		accountPolicies,
		defaultReservePct,
	});
	await authStorage.reload();
	return authStorage;
}

const DEFAULT_RUN_ROOT_DEPENDENCIES: RunRootCommandDependencies = {};

/**
 * `--session-dir` is created lazily deep inside session storage; check it up front so a bad path is
 * a usage error naming the flag instead of a raw mkdir failure much later.
 */
async function assertSessionDirUsable(dir: string): Promise<void> {
	const resolved = path.resolve(getProjectDir(), dir);
	let current = resolved;
	for (;;) {
		try {
			const stat = await fsPromises.stat(current);
			if (!stat.isDirectory()) {
				throw new CliUsageError(
					`Invalid --session-dir value: ${JSON.stringify(dir)}. ${current} is not a directory.`,
				);
			}
			await fsPromises.access(current, fsSync.constants.W_OK);
			return;
		} catch (error) {
			if (error instanceof CliUsageError) throw error;
			const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
			if (code === "ENOENT") {
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
				continue;
			}
			const { detail, remedy } = describeDirectoryFailure(current, error);
			throw new CliUsageError(
				`Invalid --session-dir value: ${JSON.stringify(dir)}. Cannot use ${current}: ${detail}. ${remedy}`,
			);
		}
	}
	throw new CliUsageError(`Invalid --session-dir value: ${JSON.stringify(dir)}. No existing parent directory.`);
}

/** Streams the TUI needs as a terminal, named for the error message. */
function missingInteractiveStreams(): string[] {
	const missing: string[] = [];
	if (process.stdin.isTTY !== true) missing.push("stdin");
	if (process.stdout.isTTY !== true) missing.push("stdout");
	return missing;
}

function interactiveTerminalRequiredMessage(missing: readonly string[]): string {
	const subject =
		missing.length === 1 ? `${missing[0]} is not a terminal` : `${missing.join(" and ")} are not terminals`;
	return (
		`${BINARY_NAME} requires an interactive TTY to start its interface (${subject}).\n` +
		`Run a one-shot prompt instead: ${BINARY_NAME} -p "your prompt"\n` +
		`Pipe a prompt in: echo "your prompt" | ${BINARY_NAME} -p\n` +
		`Machine-readable output: ${BINARY_NAME} --mode json -p "your prompt"\n`
	);
}

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = DEFAULT_RUN_ROOT_DEPENDENCIES,
): Promise<void> {
	if (parsed.version) {
		writeStartupNotice(parsed, `${VERSION}\n`);
		process.exit(0);
	}

	logger.startTiming();
	startStartupWatchdog();
	try {
		await logger.time("initTheme:initial", ensureTheme);

		const parsedArgs = parsed;
		await logger.time("applyStartupCwd", applyStartupCwd, parsedArgs);
		if (parsedArgs.sessionDir) await assertSessionDirUsable(parsedArgs.sessionDir);

		const notifs: (InteractiveModeNotify | null)[] = [];

		if ((parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") && parsedArgs.fileArgs.length > 0) {
			process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
			process.exit(1);
		}
		const mode = parsedArgs.mode || "text";

		const rpcInput = mode === "rpc" || mode === "rpc-ui" ? claimRpcInput() : undefined;

		const home = os.homedir();
		const preloadPluginRootsEnabled = shouldPreloadPluginRoots(parsedArgs);
		const pluginPreloadPromise =
			parsedArgs.pluginDirs && parsedArgs.pluginDirs.length > 0
				? logger.time("injectPluginDirRoots", injectPluginDirRoots, home, parsedArgs.pluginDirs, getProjectDir())
				: preloadPluginRootsEnabled
					? logger.time("preloadPluginRoots", preloadPluginRoots, home, getProjectDir())
					: Promise.resolve();

		pluginPreloadPromise.catch(() => {});

		if (!parsedArgs.trustedExtensions?.length) {
			const cliExtensions = [...(parsedArgs.extensions ?? []), ...(parsedArgs.hooks ?? [])];
			injectOmpExtensionCliRoots(cliExtensions, home, getProjectDir(), {
				mode: parsedArgs.noExtensions ? "explicit-only" : "merge",
				replace: true,
			});
		}

		let cwd = getProjectDir();

		const isProtocolMode = mode === "rpc" || mode === "rpc-ui" || mode === "acp";

		const pipedInput = isProtocolMode ? undefined : await logger.time("readPipedInput", readPipedInput);
		const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
		const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;

		setInteractiveHost(isInteractive);
		if (!isInteractive) {
			stopPendingStartupComposer();
		}

		// The TUI owns the terminal: without one it either dies on the first terminal query or waits
		// forever for a reply that a pipe can never send. Say so before any startup work happens.
		if (isInteractive) {
			const missing = missingInteractiveStreams();
			if (missing.length > 0) {
				stopPendingStartupComposer();
				stopStartupWatchdog();
				process.stderr.write(interactiveTerminalRequiredMessage(missing));
				process.exit(1);
			}
		}

		const settingsInstance =
			deps.settings ?? (await logger.time("settings:init", Settings.init, { cwd, configFiles: parsedArgs.config }));

		let authStorage: AuthStorage;
		try {
			authStorage = deps.discoverAuthStorage
				? await logger.time("discoverAuthStorage", deps.discoverAuthStorage, undefined, {
						settings: settingsInstance,
					})
				: ((await logger.time("reuseSettingsAuthStorage", () => reuseLocalAuthStorage(settingsInstance))) ??
					(await logger.time("discoverAuthStorage", discoverAuthStorage, undefined, {
						settings: settingsInstance,
					})));
		} catch (error) {
			const message = await describeAuthBrokerStartupError(error);
			if (message === null) throw error;
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}
		if (parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") {
			applyRpcDefaultSettingOverrides(settingsInstance);
		} else if (parsedArgs.mode === "acp") {
			applyAcpDefaultSettingOverrides(settingsInstance);
		}

		const modelRegistry = logger.time(
			"modelRegistry:init",
			() => new ModelRegistry(authStorage, undefined, { settings: settingsInstance }),
		);
		if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
			Bun.env.PI_NO_PTY = "1";
		}
		if (
			parsedArgs.noTitle ||
			parsedArgs.mode === "rpc" ||
			parsedArgs.mode === "rpc-ui" ||
			parsedArgs.mode === "acp"
		) {
			Bun.env.PI_NO_TITLE = "1";
		}

		logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

		const smolModel = parsedArgs.smol ?? $env.PI_SMOL_MODEL;
		const slowModel = parsedArgs.slow ?? $env.PI_SLOW_MODEL;
		if (smolModel || slowModel) {
			settingsInstance.overrideModelRoles({
				smol: smolModel,
				slow: slowModel,
			});
		}

		if (parsedArgs.printThoughts && !isProtocolMode && !isInteractive) {
			settingsInstance.override("omitThinking", false);
		}

		if (parsedArgs.hideThinking) {
			settingsInstance.override("hideThinkingBlock", true);
		}

		if (parsedArgs.advisor) {
			settingsInstance.override("advisor.enabled", true);
		}

		if (parsedArgs.externalThinking) {
			settingsInstance.override("externalThinking", true);
		}

		await logger.time(
			"initTheme:final",
			initTheme,
			isInteractive,
			settingsInstance.get("colorBlindMode"),
			settingsInstance.get("theme.dark"),
			settingsInstance.get("theme.light"),
		);

		applyStartupComposerPreferences({
			quiet: settingsInstance.get("startup.quiet"),
			showHardwareCursor: settingsInstance.get("showHardwareCursor"),
			maxInlineImages: settingsInstance.get("tui.maxInlineImages"),
			imeSafeCursor: settingsInstance.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settingsInstance.get("autocompleteMaxVisible"),
			spellingTypoDetection: settingsInstance.get("spelling.typoDetection"),
			spellingAutocomplete: settingsInstance.get("spelling.autocomplete"),
			spellingAutocorrect: settingsInstance.get("spelling.autocorrect"),
			theme: {
				colorBlindMode: settingsInstance.get("colorBlindMode"),
				darkTheme: settingsInstance.get("theme.dark"),
				lightTheme: settingsInstance.get("theme.light"),
			},
		});

		let scopedModels = await logger.time("resolveModelScope", () =>
			resolveScopedModels(parsedArgs, modelRegistry, settingsInstance, { reportUnmatched: true }),
		);
		warnUnresolvableModelRoleFlags(parsedArgs, modelRegistry, settingsInstance);

		normalizeContinueSessionArgs(parsedArgs, rawArgs);

		let sessionManager: SessionManager | undefined;
		let foreignSource: ForeignSessionSource | undefined;
		try {
			foreignSource = resolveForeignSessionSource(parsedArgs);
			if (foreignSource) {
				if (isProtocolMode) {
					throw new SessionResolutionError(`--from-${foreignSource} is not supported in ${mode} mode`);
				}
				const sourceName = foreignSessionSourceName(foreignSource);
				const store = (deps.createForeignSessionStore ?? createForeignSessionStore)(foreignSource);
				let foreignSessions: ForeignSessionInfo[];
				try {
					foreignSessions = await logger.time(`list${sourceName}Sessions`, () => store.list());
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new SessionResolutionError(`Failed to list ${sourceName} sessions: ${message}`);
				}
				if (foreignSessions.length === 0) {
					writeStartupNotice(parsedArgs, `${chalk.dim(`No ${sourceName} sessions found`)}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
				const choices = foreignSessions.map(foreignSessionInfoToSessionInfo);
				pauseStartupWatchdog();
				let selected: SessionInfo | null;
				try {
					selected = await logger.time(
						`select${sourceName}Session`,
						deps.selectSession ?? selectSession,
						choices,
						{
							title: `Import ${sourceName} Session`,
							scopeLabel: false,
							showCwd: true,
							allowDelete: false,
							allowGlobalScope: false,
							historySearch: false,
						},
					);
				} finally {
					resumeStartupWatchdog();
				}
				if (!selected) {
					writeStartupNotice(parsedArgs, `${chalk.dim(`No ${sourceName} session selected`)}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
				const foreignSession = foreignSessions.find(
					session => session.id === selected.id && session.path === selected.path,
				);
				if (!foreignSession) {
					throw new SessionResolutionError(`Selected ${sourceName} session is no longer available`);
				}
				try {
					sessionManager = await logger.time(
						`import${sourceName}Session`,
						persistForeignSession,
						store,
						foreignSession,
						{ fallbackCwd: cwd, sessionDir: parsedArgs.sessionDir },
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new SessionResolutionError(`Failed to import ${sourceName} session: ${message}`);
				}
			} else {
				sessionManager = await logger.time(
					"createSessionManager",
					createSessionManager,
					parsedArgs,
					cwd,
					settingsInstance,
				);
			}
		} catch (error: unknown) {
			if (error instanceof SessionDirectoryError) {
				process.stderr.write(`${chalk.red(`Error: ${error.message}`)}\n`);
				process.stderr.write(`${chalk.dim(error.hint)}\n`);
				process.exit(1);
			}
			if (error instanceof SessionResolutionError) {
				process.stderr.write(`${chalk.red(`Error: ${error.message}`)}\n`);
				if (error.hint) {
					process.stderr.write(`${chalk.dim(error.hint)}\n`);
				}
				process.exit(1);
			}
			throw error;
		}

		if ((typeof parsedArgs.resume === "string" || foreignSource) && sessionManager) {
			const previousCwd = cwd;
			const resumed = await switchToResumedProject(
				sessionManager.getRecordedCwd() ?? sessionManager.getCwd(),
				settingsInstance,
				pluginPreloadPromise,
				preloadPluginRootsEnabled,
				sessionManager,
			);
			cwd = resumed.cwd;
			notifyResumedProjectFallback(parsedArgs, resumed);
			if (cwd !== previousCwd) {
				parsedArgs.cwd = cwd;

				scopedModels = await resolveScopedModels(parsedArgs, modelRegistry, settingsInstance);
			}
		}

		if (typeof parsedArgs.resume === "string" && !sessionManager) {
			writeStartupNotice(parsedArgs, `${chalk.dim("Resume cancelled: session was not moved.")}\n`);
			stopStartupWatchdog();
			process.exit(0);
		}

		if (parsedArgs.resume === true && !parsedArgs.fork) {
			const folderSessions = await logger.time(
				"SessionManager.listForPicker",
				SessionManager.listForPicker,
				cwd,
				parsedArgs.sessionDir,
			);
			let preloadedAllSessions: SessionInfo[] | undefined;
			if (folderSessions.length === 0) {
				preloadedAllSessions = await logger.time(
					"SessionManager.listAllForPicker",
					SessionManager.listAllForPicker,
				);
				if (preloadedAllSessions.length === 0) {
					writeStartupNotice(parsedArgs, `${chalk.dim("No sessions found")}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
			}
			pauseStartupWatchdog();
			const selected = await logger.time("selectSession", deps.selectSession ?? selectSession, folderSessions, {
				allSessions: preloadedAllSessions,
			});
			resumeStartupWatchdog();
			if (!selected) {
				writeStartupNotice(parsedArgs, `${chalk.dim("No session selected")}\n`);

				stopStartupWatchdog();
				process.exit(0);
			}

			// Open first so a project that cannot be entered leaves the session tracking the launch directory.
			if (parsedArgs.noSession) {
				sessionManager ??= SessionManager.inMemory(cwd);
				await sessionManager.setSessionFile(selected.path);
			} else {
				if (!claimSessionOwnership(selected.path)) {
					const ownerPid = liveSessionOwnerPid(selected.path);
					const owner =
						ownerPid === undefined ? "another proto process" : `another proto process (pid ${ownerPid})`;
					process.stderr.write(
						`${chalk.red(`Error: That session is currently open in ${owner} — release it there before resuming here.`)}\n`,
					);
					process.stderr.write(`${chalk.dim(`Run \`proto --fork ${selected.path}\` to continue in a copy.`)}\n`);
					stopStartupWatchdog();
					process.exit(1);
				}
				sessionManager = await SessionManager.open(selected.path);
			}
			const previousCwd = cwd;
			const resumed = await switchToResumedProject(
				selected.cwd || sessionManager.getRecordedCwd() || sessionManager.getCwd(),
				settingsInstance,
				pluginPreloadPromise,
				preloadPluginRootsEnabled,
				sessionManager,
			);
			cwd = resumed.cwd;
			notifyResumedProjectFallback(parsedArgs, resumed);
			if (cwd !== previousCwd) {
				parsedArgs.cwd = cwd;
				scopedModels = await resolveScopedModels(parsedArgs, modelRegistry, settingsInstance);
			}
		}

		if (sessionManager && (parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || foreignSource)) {
			const pendingToolWarning = describePendingToolCalls(sessionManager.getBranch());
			if (pendingToolWarning) {
				logger.warn("Resumed session has pending tool calls", {
					sessionId: sessionManager.getSessionId(),
					sessionFile: sessionManager.getSessionFile(),
				});
				if (isInteractive) {
					notifs.push({ kind: "warn", message: pendingToolWarning });
				} else {
					process.stderr.write(`${chalk.yellow(`${pendingToolWarning}\n`)}`);
				}
			}
		}

		await pluginPreloadPromise;
		if (deps === DEFAULT_RUN_ROOT_DEPENDENCIES) {
			await logger.time("registerDaemonProjectPresence", registerDaemonProjectPresence, cwd);
		}

		scheduleMarketplaceAutoUpdate({
			autoUpdate: settingsInstance.get("marketplace.autoUpdate"),
			resolveActiveProjectRegistryPath,
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const sessionOptions = await logger.time(
			"buildSessionOptions",
			buildSessionOptions,
			parsedArgs,
			scopedModels,
			sessionManager,
			modelRegistry,
			settingsInstance,
		);
		sessionOptions.authStorage = authStorage;
		sessionOptions.modelRegistry = modelRegistry;
		sessionOptions.hasUI = isInteractive || mode === "rpc-ui";
		sessionOptions.settings = settingsInstance;

		await logger.time("initTelemetryExport", initTelemetryExport);
		if (isTelemetryExportEnabled()) {
			sessionOptions.telemetry = createTelemetryExportConfig(sessionOptions.telemetry);
		}

		if (parsedArgs.apiKey) {
			if (!sessionOptions.model && !sessionOptions.modelPattern) {
				process.stderr.write(
					`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
				);
				process.exit(1);
			}
			if (sessionOptions.model) {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsedArgs.apiKey);
			}
		}

		const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
		const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
			const result = await logger.time("createAgentSession", createAgentSessionImpl, options);

			modelRegistry.refreshInBackground();
			return result;
		};

		if (mode === "acp") {
			const createAcpSession = createAcpSessionFactory({
				baseOptions: sessionOptions,
				settings: settingsInstance,
				sessionDir: parsedArgs.sessionDir,
				authStorage,
				modelRegistry,
				parsedArgs,
				rawArgs,
				createSession,
			});

			const runAcpMode = deps.runAcpMode ?? (await import("./modes/acp/acp-mode")).runAcpMode;
			stopStartupWatchdog();
			await runAcpMode(createAcpSession);
		} else {
			if (isInteractive && !parsedArgs.trustedExtensions?.length) {
				sessionOptions.extensions = [...(sessionOptions.extensions ?? []), createWarpEventBridgeExtension()];
			}

			const eventBus = new EventBus();
			const extensionsResult = parsedArgs.trustedExtensions?.length
				? await loadTrustedSessionExtensions(sessionOptions, cwd, eventBus)
				: await loadSessionExtensions(sessionOptions, cwd, settingsInstance, eventBus);
			const extensionFlagSink: ExtensionFlagSink = {
				getFlags: () => ExtensionRunner.aggregateFlags(extensionsResult.extensions),
				setFlagValue: (name, value) => {
					extensionsResult.runtime.flagValues.set(name, value);
				},
			};
			const initialArgs = applyExtensionFlags(extensionFlagSink, rawArgs) ?? parsedArgs;
			normalizeContinueSessionArgs(initialArgs, rawArgs);
			if ((parsedArgs.trustedExtensions?.length ?? 0) > 0 && extensionsResult.errors.length > 0) {
				throw new Error(
					`Trusted extension failed to load: ${extensionsResult.errors.map(item => item.error).join("; ")}`,
				);
			}
			for (const message of [
				...formatExtensionLoadNotifications(extensionsResult.errors, { truncate: isInteractive }),
				...formatExtensionLoadWarnings(extensionsResult.warnings, { truncate: isInteractive }),
			]) {
				if (isInteractive) {
					notifs.push({ kind: "warn", message });
				} else {
					process.stderr.write(`${chalk.yellow(`${message}\n`)}`);
				}
			}

			if (reportUnrecognizedFlags(initialArgs)) {
				process.exit(1);
			}
			const processedFiles =
				initialArgs.fileArgs.length > 0
					? await logger.time("processFileArguments", () =>
							processFileArguments(initialArgs.fileArgs, {
								autoResizeImages: settingsInstance.get("images.autoResize"),
							}),
						)
					: undefined;
			const { initialMessage, initialImages } = buildInitialMessage({
				parsed: initialArgs,
				fileText: processedFiles?.text,
				fileImages: processedFiles?.images,
				stdinContent: pipedInput,
			});

			const startupChangelogPromise = isInteractive
				? logger.time(
						"main:getChangelogForDisplay",
						getChangelogForDisplay,
						parsedArgs,
						settingsInstance.get("startup.changelogMode"),
					)
				: undefined;

			const { session, setToolUIContext, modelFallbackMessage, mcpManager } = await createSession({
				...sessionOptions,
				eventBus,
				preloadedExtensions: extensionsResult,
			});

			// A session started fresh here (no --resume/--continue) is resolved inside
			// createAgentSession, so this is the first moment its file is known: claim it
			// before any turn runs, or a concurrent `--continue` could adopt it and
			// overwrite this run's turns.
			claimSessionOwnership(session.sessionManager.getSessionFile());

			try {
				validateToolNames(initialArgs.tools, session.getAllToolNames());
			} catch (error) {
				await session.dispose();
				throw error;
			}

			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session,
					authStorage,
					modelRegistry,
					settings: settingsInstance,
					eventBus,
				}),
				Math.trunc(Number(settingsInstance.get("orchestrator.agentIdleTtlMs") ?? 60_000) || 0),
			);
			if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
				authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
			}

			const configuredScope = parsedArgs.models ?? settingsInstance.get("enabledModels");
			if (isInteractive && configuredScope.length > 0) {
				void rebuildScopedModelsAfterDiscovery(session, parsedArgs, modelRegistry, settingsInstance).catch(error =>
					logger.warn("Scoped model rebuild after discovery failed", { error: String(error) }),
				);
			}

			if (modelFallbackMessage) {
				notifs.push({ kind: "warn", message: modelFallbackMessage });
			}

			const modelRegistryError = modelRegistry.getError();
			if (modelRegistryError) {
				notifs.push({ kind: "error", message: modelRegistryError.message });
			}

			if (!isInteractive && !session.model) {
				if (modelRegistryError) {
					process.stderr.write(`${chalk.red(modelRegistryError.message)}\n\n`);
				}
				if (modelFallbackMessage) {
					process.stderr.write(`${chalk.red(modelFallbackMessage)}\n`);
				} else {
					process.stderr.write(`${chalk.red("No models available.")}\n`);
				}
				process.stderr.write(`${chalk.yellow("\nSet an API key environment variable:")}\n`);
				process.stderr.write("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n");
				process.stderr.write(`${chalk.yellow(`\nOr create ${ModelsConfigFile.path()}`)}\n`);
				process.exit(1);
			}

			if (mode === "rpc" || mode === "rpc-ui") {
				const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
				stopStartupWatchdog();
				await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined, eventBus, rpcInput);
			} else if (isInteractive) {
				const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);
				const startupChangelog = await startupChangelogPromise;

				const modelScopeNotification = buildModelScopeNotification(
					scopedModels,
					settingsInstance.get("startup.quiet"),
				);
				if (modelScopeNotification) {
					notifs.push(modelScopeNotification);
				}

				if ($env.PI_TIMING) {
					logger.printTimings();
					if (logger.shouldExitAfterTimings()) {
						process.exit(0);
					}
				}
				const startupLease = takeStartupComposerLease();
				try {
					stopStartupWatchdog();
					logger.endTiming();
					await runInteractiveMode(
						session,
						VERSION,
						startupChangelog,
						notifs,
						versionCheckPromise,
						initialArgs.messages,
						setToolUIContext,
						mcpManager,
						Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || foreignSource),
						deps.forceSetupWizard === true,
						eventBus,
						initialMessage,
						initialImages,
						startupLease,
					);
				} finally {
					startupLease?.dispose();
				}
			} else {
				stopStartupWatchdog();
				const runPrintMode: RunPrintMode = (await import("./modes/print-mode")).runPrintMode;
				await runPrintMode(session, {
					mode,
					messages: initialArgs.messages,
					initialMessage,
					initialImages,
					printThoughts: initialArgs.printThoughts,
				});
				if ($env.PI_TIMING) {
					logger.printTimings();
				}
				await session.dispose();
				stopThemeWatcher();
				await postmortem.quit(0);
			}
		}
	} catch (error) {
		stopPendingStartupComposer();
		stopStartupWatchdog();
		throw error;
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
