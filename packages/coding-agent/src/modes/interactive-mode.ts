import * as path from "node:path";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	LoaderMessageColorFn,
	NativeScrollbackLiveRegion,
	SlashCommand,
} from "@oh-my-pi/pi-tui";
import {
	Container,
	clearRenderCache,
	Loader,
	Markdown,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { isInsideTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { $env, getProjectDir, logger, postmortem, prompt, sanitizeText, setProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { reset as resetCapabilities } from "../capability";
import { KeybindingsManager } from "../config/keybindings";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { isSettingsInitialized, Settings, settings } from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import type {
	AutocompleteProviderFactory,
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import { loadSlashCommands } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import {
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionFailure,
	type McpConnectionStatusEvent,
} from "../mcp/startup-events";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession, AgentSessionEvent, DroppedPrompt } from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { formatDuration } from "../slash-commands/helpers/format";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { formatWorkerId, workerTypeBadge } from "../task/display";
import { labelEchoesHandle } from "../task/label";
import { tinyTitleClient } from "../tiny/title-client";
import type { LspStartupServerInfo } from "../tools";
import { formatMoreItems, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	setActiveTodoDescriptionsProvider,
	todoMatchesAnyDescription,
} from "../tools/todo";
import { renderTreeList } from "../tui/tree-list";
import { formatStartupChangelogSummary, type StartupChangelogSelection } from "../utils/changelog";
import type { EventBus } from "../utils/event-bus";
import { resumeCommand } from "../utils/resume-command";
import { messageHasDisplayableThinking } from "../utils/thinking-display";
import {
	disposeTerminalTitleState,
	popTerminalTitle,
	pushTerminalTitle,
	setSessionTerminalTitle,
	setTerminalTitleStateEnabled,
} from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import { AttachmentChipsBand } from "./components/attachment-chips";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import { CustomEditor } from "./components/custom-editor";
import { ErrorBannerComponent } from "./components/error-banner";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/hook-selector";
import { StatusLineComponent } from "./components/status-line";
import { stopSharedSpinnerTicker, type ToolExecutionHandle } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import type { LspServerInfo as WelcomeLspServerInfo } from "./components/welcome";
import { buildComposerShortcuts, COMPOSER_PLACEHOLDER, Composer, ComposerShortcutsBar } from "./composer";
import { writeComposerWelcomeCache } from "./composer-cache";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SideAgentController } from "./controllers/side-agent-controller";
import { SideQuestionController } from "./controllers/side-question-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import { imageReferenceHyperlink, materializeImageReferenceLinks } from "./image-references";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "./loop-limit";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningSubagentBadgeAgents } from "./running-subagent-badge";
import {
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { interruptHint } from "./shared";
import { clearMermaidCache } from "./theme/mermaid-cache";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	setMarkdownMermaidRendering,
	startMacOSAppearanceReprobeFallback,
	theme,
} from "./theme/theme";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	RenderSessionContextOptions,
	SideCommandMode,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { resolvePreservedLiveToolCallIds, UiHelpers } from "./utils/ui-helpers";

const STILL_CLOSING_DELAY_MS = 3_000;

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4;
const EDITOR_MIN_RENDERED_ROWS = 3;

export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, rows - EDITOR_RESERVED_ROWS));
	return Math.max(EDITOR_MIN_RENDERED_ROWS, Math.min(comfortable, rows - EDITOR_MIN_CHROME_ROWS));
}

class HookStatusRow implements Component {
	constructor(private readonly line: (width: number) => readonly string[]) {}
	render(width: number): readonly string[] {
		return this.line(width);
	}
	invalidate(): void {}
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

export interface InteractiveModeOptions {
	migratedProviders?: string[];

	modelFallbackMessage?: string;

	initialMessage?: string;

	initialImages?: ImageContent[];

	initialMessages?: string[];
}

class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
}

class DeferredCommandPreview implements Component {
	constructor(
		private readonly items: readonly Component[],
		private readonly maxRows: number,
		private readonly commandCount: number,
	) {}

	render(width: number): readonly string[] {
		const rows: string[] = [];
		for (const item of this.items) rows.push(...item.render(width));
		const queued = this.commandCount === 1 ? "1 command output" : `${this.commandCount} command outputs`;
		if (rows.length <= this.maxRows) {
			rows.push(theme.fg("dim", `${queued} — repeated in the transcript when the agent pauses`));
			return rows;
		}
		const shown = rows.slice(0, Math.max(1, this.maxRows - 1));
		const hidden = rows.length - shown.length;
		shown.push(theme.fg("dim", `… ${hidden} more rows — ${queued} shown in full when the agent pauses`));
		return shown;
	}
}

const DEFERRED_PREVIEW_MIN_ROWS = 6;

const DEFERRED_PREVIEW_VIEWPORT_FRACTION = 0.4;

const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const dot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const displayId = formatWorkerId(session.id);
				const role = session.agent ?? session.progress?.agent;
				const badge = workerTypeBadge(role, theme);
				let line = `${dot} ${theme.fg("accent", theme.bold(displayId))}${badge}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				const distinctDescription =
					description && !labelEchoesHandle(session.id, description) ? description : undefined;
				if (distinctDescription) {
					const budget = Math.max(
						TRUNCATE_LENGTHS.SHORT,
						columns - visibleWidth(displayId) - visibleWidth(Bun.stripANSI(badge)) - 10,
					);
					const formatted = replaceTabs(distinctDescription).replace(/\s*[\r\n]+\s*/g, " ↵ ");
					line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(formatted, budget))}`;
				} else {
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview && !labelEchoesHandle(session.id, taskPreview)) {
						const formatted = replaceTabs(taskPreview).replace(/\s*[\r\n]+\s*/g, " ↵ ");
						line += ` ${theme.fg("muted", truncateToWidth(formatted, TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Fleet for full list`));
	}
	return ["", theme.bold(theme.fg("accent", "Subagents")), ...rows.map(line => ` ${line}`)];
}

const CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS = 2000;

export class InteractiveMode implements InteractiveModeContext {
	#ownsStartedUi: boolean;
	#startupSubmitGated: boolean;
	session: AgentSession;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	readonly composer: Composer;
	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	sideQuestionContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	deferredCommandContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	#hookStatusRow: HookStatusRow | undefined;
	readonly #composerShortcuts = new ComposerShortcutsBar();

	attachmentChipsContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	toolOutputExpanded = false;
	hideToolActivity = false;
	todoExpanded = false;
	goalModeEnabled = false;
	goalModePaused = false;
	loopModeEnabled = false;
	loopModePaused = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	#nextAppearanceRequestToken = 1;
	#appearanceRefreshRequest: { token: TerminalAppearanceRequestToken; deadline: number } | undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();

	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}

	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}

	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}
	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	get #defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	locallySubmittedUserSignatures: Set<string> = new Set();
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	#pendingSubmissionDispose: (() => void) | undefined;
	#pendingSubmissionPreservesDraft = false;
	#optimisticUserMessageComponents: Component[] = [];
	#optimisticSkillMessageComponents: Component[] = [];

	optimisticSkillMessagePending = false;
	lastSigintTime = 0;
	lastEscapeTime = 0;

	mcpTestEscapeHandlers = new Set<() => void>();
	lastLeftTapTime = 0;
	lastRightTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;

	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();

	#pendingCommandOutput: Component[] = [];
	#pendingCommandOutputSessionId: string | undefined;

	#pendingCommandOutputCommands = 0;
	#pendingSlashCommands: SlashCommand[] = [];

	#baseAutocompleteProvider: AutocompleteProvider | undefined;

	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	readonly #startupChangelog: StartupChangelogSelection | undefined;
	#goalModePreviousTools: string[] | undefined;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #sideQuestionController: SideQuestionController;
	readonly #sideAgentController: SideAgentController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #eventController: EventController;
	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
	}

	get sessionManager(): SessionManager {
		return this.session.sessionManager;
	}
	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}

	attachSessionView(target: AgentSession): Promise<void> {
		const attached = this.#focusController.attachSwappedMain(target);

		this.#subscribeToSessionScopedEvents();
		target.setSessionSwitchReconciler?.(this.#sessionSwitchReconciler);
		return attached;
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	clearTransientSessionUi(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.disposeChildren();
		this.pendingMessagesContainer.disposeChildren();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.disposeChildren();
		this.deferredCommandContainer.disposeChildren();
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];

	#sessionEventUnsubscribers: Array<() => void> = [];

	#sessionSwitchReconciler = (): Promise<void> => this.#reconcileModeFromSession({ preserveActiveGoal: true });
	#observerUiSyncTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentRegistry;
	#mcpStatusOrder: string[] = [];
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; sourcePath?: string }>();
	readonly #chatHost: ChatBlockHost = { requestRender: () => this.ui.requestRender() };

	constructor(
		session: AgentSession,
		version: string,
		startupChangelog: StartupChangelogSelection | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
		composer?: Composer,
	) {
		this.session = session;
		this.settings = session.settings;
		const preferences = {
			quiet: settings.get("startup.quiet"),
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			scrollbackRebuild: settings.get("tui.scrollbackRebuild"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
		const wasStarted = composer?.started ?? false;
		this.composer =
			composer ??
			new Composer({
				preferences,
				welcome: {
					version,
					modelName: session.model?.name ?? "Unknown",
					providerName: session.model?.provider ?? "Unknown",
					lspServers: lspServers?.map(server => ({
						name: server.name,
						status: server.status,
						fileTypes: server.fileTypes,
					})),
				},
			});
		this.composer.setPreferences(preferences);
		this.ui = this.composer.ui;
		this.editor = this.composer.editor;
		this.editor.magicKeywordsEnabled = () => this.settings.get("magicKeywords.enabled");
		this.editor.imageReferenceHyperlink = imageReferenceHyperlink;
		this.#ownsStartedUi = wasStarted;
		this.#startupSubmitGated = true;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#startupChangelog = startupChangelog;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.mcpManager?.setAuthHandler((serverName, challenge) =>
			new MCPCommandController(this).handleMCPAuthChallenge(serverName, challenge),
		);
		this.#eventBus = eventBus;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));

		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		this.ui.setResizeScrollback(settings.get("tui.resizeScrollback"));
		this.ui.setShowHardwareCursor(settings.get("showHardwareCursor"));

		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.supportsTextSizing);
		this.chatContainer = new TranscriptContainer();

		this.chatContainer.onFirstContent = () => {
			this.composer.syncHomeAnchor(this.chatContainer.children.length);
		};
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new AnchoredLiveContainer();
		this.todoContainer = new AnchoredLiveContainer();
		this.subagentContainer = new AnchoredLiveContainer();
		this.sideQuestionContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		this.deferredCommandContainer = new AnchoredLiveContainer();
		this.ui.enableScopedInputRender(this.editor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(settings.get("tui.imeSafeCursor"));
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.setPlaceholder(COMPOSER_PLACEHOLDER);
		this.syncEditorSpelling();
		this.editor.viewportRowsProvider = () => this.ui.terminal.rows;
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.editor.setShimmerRepaintHandler(() => this.ui.requestDirectWrite(this.editor));
		this.#syncEditorMaxHeight();

		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.composer.syncHomeAnchor(this.chatContainer.children.length);
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		this.attachmentChipsContainer = new Container();
		this.attachmentChipsContainer.addChild(
			new AttachmentChipsBand(this.editor, this.ui.imageBudget, () => this.ui.requestRender()),
		);

		this.editor.draftImageLinkMaterializer = images =>
			materializeImageReferenceLinks(images, this.sessionManager.putBlob.bind(this.sessionManager));
		this.editorContainer = this.composer.editorSlot;
		this.#hookStatusRow = new HookStatusRow(width => this.statusLine.renderHookStatus(width));
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.hideToolActivity = settings.get("display.hideToolActivity");
		this.chatContainer.setToolActivityVisible(!this.hideToolActivity);
		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		const skillCommandList = this.#rebuildSkillCommandsFromSession();

		const builtinCommands: SlashCommand[] = [...buildTuiBuiltinSlashCommands({ ctx: this })];

		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#sideQuestionController = new SideQuestionController(this);
		this.#sideAgentController = new SideAgentController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#focusController = new SessionFocusController(this);
		this.#inputController = new InputController(this);
		this.session.setTitleGenerationStart?.(() => {
			this.#inputController.notifyTitleGenerationStart();
		});
		this.session.setPromptDropped?.(prompt => this.#restoreDroppedPrompt(prompt));
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpStatusOrder = [];
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#trackMcpStatusServer(serverName);
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#trackMcpStatusServer(event.serverName);
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, {
				error: event.error,
				sourcePath: event.sourcePath,
			});
		}

		const message = formatMCPConnectionStatusMessage({
			pendingServers: this.#orderedMcpStatusServers(this.#mcpPendingServers),
			connectedServers: this.#orderedMcpStatusServers(this.#mcpConnectedServers),
			failedServers: this.#orderedMcpStatusFailures(),
		});
		if (message) this.showStatus(message);
	}

	#trackMcpStatusServer(serverName: string): void {
		if (!this.#mcpStatusOrder.includes(serverName)) {
			this.#mcpStatusOrder.push(serverName);
		}
	}

	#orderedMcpStatusServers(servers: ReadonlySet<string>): string[] {
		return this.#mcpStatusOrder.filter(serverName => servers.has(serverName));
	}

	#orderedMcpStatusFailures(): McpConnectionFailure[] {
		return this.#mcpStatusOrder.flatMap(serverName => {
			const failure = this.#mcpFailedServers.get(serverName);
			return failure === undefined ? [] : [{ serverName, ...failure }];
		});
	}
	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());

		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.#inputController.getDraftText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			disposeSession: reason => this.session.dispose({ reason }),
		});

		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
			this.session.slashCommands,
		);

		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);
		const startupQuiet = settings.get("startup.quiet");
		this.composer.setPreferences({ quiet: startupQuiet });
		this.composer.updateWelcome({
			version: this.#version,
			modelName,
			providerName,
			recentSessions,
			lspServers: this.#getWelcomeLspServers(),
		});
		this.#persistComposerWelcome(modelName, providerName);
		const headerBefore: Component[] = [];
		for (const warning of this.session.configWarnings) {
			headerBefore.push(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0), new Spacer(1));
		}
		const headerAfter: Component[] = [];
		if (!startupQuiet && this.#startupChangelog && settings.get("startup.changelogMode") !== "hidden") {
			headerAfter.push(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0), new Spacer(1));
			if (settings.get("startup.changelogMode") === "summary") {
				const summary = formatStartupChangelogSummary(this.#startupChangelog);
				headerAfter.push(new Text(summary, 1, 0));
			} else {
				headerAfter.push(new Markdown(this.#startupChangelog.markdown?.trim() ?? "", 1, 0, getMarkdownTheme()));
			}
		}
		this.composer.setHeaderExtras(headerBefore, headerAfter);
		this.statusLine.watchBranch(() => {
			this.ui.requestRender();
		});
		this.statusLine.setLocationRightProvider(() => this.#footlineRightZone());
		this.#composerShortcuts.setShortcutsProvider(() =>
			buildComposerShortcuts(this.keybindings, {
				busy: this.viewSession?.isStreaming ?? false,
				hasQueue:
					(this.viewSession?.getQueuedMessages().steering.length ?? 0) +
						(this.viewSession?.getQueuedMessages().followUp.length ?? 0) >
					0,
				focused: this.focusedAgentId !== undefined,
			}),
		);
		this.composer.setStatusComponent(this.statusLine);

		this.composer.setRuntimeChildren(
			[
				this.chatContainer,
				this.pendingMessagesContainer,
				this.todoContainer,
				this.subagentContainer,
				this.sideQuestionContainer,
				this.errorBannerContainer,
				this.modelCycleContainer,
				this.deferredCommandContainer,
				this.statusContainer,
				this.#hookStatusRow ?? new Container(),
				this.attachmentChipsContainer,
				this.hookWidgetContainerAbove,
			],
			[this.#composerShortcuts, this.hookWidgetContainerBelow],
		);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});

		setActiveTodoDescriptionsProvider(() => this.#getActiveSubagentDescriptions());

		await this.#loadTodoList();

		if (process.platform === "darwin" && TERMINAL.id === "wezterm" && !isInsideTerminalMultiplexer()) {
			this.#eventBusUnsubscribers.push(startMacOSAppearanceReprobeFallback(this.ui.terminal));
		}

		if (!this.#ownsStartedUi) {
			this.composer.start({
				clearScrollback: options.clearInitialTerminalHistory === true,
			});
			this.#ownsStartedUi = true;
		}
		pushTerminalTitle();
		setTerminalTitleStateEnabled(this.settings.get("tui.titleState"));
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();

		this.#eventBusUnsubscribers.push(
			this.sessionManager.onPersistenceError(error => {
				const detail = truncateToWidth(
					replaceTabs(sanitizeText(error.message)).replace(/[\r\n]+/g, " "),
					TRUNCATE_LENGTHS.LINE,
				);
				this.showWarning(
					`Session persistence failed: ${detail}. Unsaved entries remain in memory; persistence will retry on the next entry.`,
				);
			}),
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
			}),
		);
		this.#syncEditorMaxHeight();
		this.composer.syncHomeAnchor(this.chatContainer.children.length);
		this.isInitialized = true;
		this.ui.requestRender(true);

		setImmediate(() => {
			if (!$env.PI_NO_TITLE && !this.sessionManager.getSessionName()) {
				tinyTitleClient.prewarm(this.settings.get("providers.tinyModel"));
			}
		});

		await this.initHooksAndCustomTools();

		this.session.setSessionSwitchReconciler?.(this.#sessionSwitchReconciler);
		await this.#reconcileModeFromSession();

		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		this.#subscribeToAgent();

		this.#subscribeToSessionScopedEvents();

		this.#updateWelcomeModel();

		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					this.ui.requestRender();
					return;
				}

				this.ui.requestRender(true, { clearScrollback: true });
			}),
		);

		const unsubscribeAppearanceReport = this.ui.terminal.onAppearanceReport?.((_mode, requestToken) => {
			const request = this.#appearanceRefreshRequest;
			if (request === undefined || requestToken !== request.token) return;

			queueMicrotask(() => {
				if (this.#appearanceRefreshRequest === request) {
					this.#appearanceRefreshRequest = undefined;
				}
			});
		});
		if (unsubscribeAppearanceReport) {
			this.#eventBusUnsubscribers.push(unsubscribeAppearanceReport);
		}
		this.ui.terminal.onAppearanceChange((mode, requestToken) => {
			const request = this.#appearanceRefreshRequest;
			const appearanceRefreshWasRequested =
				request !== undefined &&
				Date.now() <= request.deadline &&
				(requestToken === request.token || requestToken === undefined);
			if (request !== undefined && requestToken === request.token) {
				this.#appearanceRefreshRequest = undefined;
			}

			onTerminalAppearanceChange(mode, appearanceRefreshWasRequested ? {} : undefined);
		});
	}

	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	#rebuildSkillCommandsFromSession(): SlashCommand[] {
		const commands: SlashCommand[] = [];
		this.skillCommands.clear();
		if (this.session.skillsSettings?.enableSkillCommands !== false) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				commands.push({ name: commandName, description: skill.description });
			}
		}
		return commands;
	}

	async refreshSkillState(): Promise<void> {
		await this.session.refreshSkills();
		const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
		const skillCommands = this.#rebuildSkillCommandsFromSession();
		this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
	}

	async refreshSlashCommandState(cwd?: string, preloaded?: ReadonlyArray<FileSlashCommand>): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();

		const fileCommands = preloaded ? [...preloaded] : await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));

		const reservedNames = new Set<string>();
		for (const command of this.#pendingSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		for (const command of fileSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		const promptTemplateCommands: SlashCommand[] = this.session.promptTemplates
			.filter(template => !reservedNames.has(template.name))
			.map(template => ({
				name: template.name,

				description: template.description,
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: String(error) });
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	async applyCwdChange(newCwd: string): Promise<void> {
		setProjectDir(newCwd);

		if (isSettingsInitialized()) {
			await settings.reloadForCwd(newCwd);

			applyProviderGlobalsFromSettings(settings);
		}

		clearClaudePluginRootsCache();
		await this.refreshTitleSystemPrompt(newCwd);
		resetCapabilities();
		await this.refreshSkillState();
		await this.refreshSlashCommandState(newCwd);
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.applyCwdChange();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		if (this.#startupSubmitGated) {
			this.#startupSubmitGated = false;
			this.editor.disableSubmit = false;
			this.ui.requestRender();
		}
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = settings.get("loop.mode");
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (!this.loopModeEnabled || !this.onInputCallback) return;
			callback();
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.loopModeEnabled) return;
		if (!this.onInputCallback) return;
		if (!this.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.editor.getText().trim().length > 0) return;
		if ((this.editor.pendingImages?.length ?? 0) > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.onInputCallback) return;
			if (!this.goalModeEnabled || this.goalModePaused) return;

			if (this.#isAutoSubmitBlocked()) return;
			if (this.#pendingSubmittedInput) return;
			if (this.editor.getText().trim().length > 0) return;
			if ((this.editor.pendingImages?.length ?? 0) > 0) return;
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	#submitLoopPromptWhenReady(prompt: string): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: prompt }));
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}
		this.#syncLoopModeStatus();

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	#syncLoopModeStatus(): void {
		this.statusLine.setLoopModeStatus(this.loopModeEnabled ? { enabled: true } : undefined);
		this.ui.requestRender();
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.#cancelLoopAutoSubmit();
		this.#syncLoopModeStatus();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	setLoopPrompt(prompt: string): void {
		if (!this.loopModeEnabled) return;
		this.loopPrompt = prompt;
		this.loopModePaused = false;
		this.#syncLoopModeStatus();
	}

	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.loopModePaused = true;
		this.#cancelLoopAutoSubmit();
		this.#syncLoopModeStatus();
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopLimitArgs(args);
		if (typeof parsed === "string") {
			this.showError(parsed);
			return undefined;
		}
		this.loopModeEnabled = true;
		this.loopModePaused = false;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.#syncLoopModeStatus();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix} ${tail} Esc cancels the current iteration; /loop again to disable.`,
		);

		return parsed.prompt;
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		if (this.isKnownSlashCommand(text)) {
			return () => {};
		}
		const signature = `${text}\u0000${imageCount}`;
		this.locallySubmittedUserSignatures.add(signature);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.locallySubmittedUserSignatures.delete(signature);
		};
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (err) {
			dispose();
			throw err;
		}
	}
	#captureAddedChatComponents(render: () => void): Component[] {
		const start = this.chatContainer.children.length;
		render();
		return this.chatContainer.children.slice(start);
	}

	clearOptimisticUserMessage(): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		this.#optimisticUserMessageComponents = [];
	}

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.optimisticUserMessageSignature = undefined;
		this.#pendingSubmissionDispose?.();
		this.#pendingSubmissionDispose = undefined;
		for (const component of this.#optimisticUserMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticUserMessageComponents = [];
		this.addMessageToChat(message, options);
	}

	renderOptimisticSkillMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.clearOptimisticSkillMessage();
		this.optimisticSkillMessagePending = true;
		this.#optimisticSkillMessageComponents = this.#captureAddedChatComponents(() => {
			this.addMessageToChat(message, options);
		});
		this.ensureLoadingAnimation();
		this.ui.requestRender();
	}

	reconcileOptimisticSkillMessage(message: AgentMessage): void {
		this.optimisticSkillMessagePending = false;
		for (const component of this.#optimisticSkillMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticSkillMessageComponents = [];
		this.addMessageToChat(message);
	}

	clearOptimisticSkillMessage(): void {
		this.optimisticSkillMessagePending = false;
		if (this.#optimisticSkillMessageComponents.length === 0) return;
		for (const component of this.#optimisticSkillMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticSkillMessageComponents = [];
	}

	startPendingSubmission(
		input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
		},
		options?: { preserveDraft?: boolean },
	): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		this.#pendingSubmissionPreservesDraft = options?.preserveDraft === true;
		if (!submission.customType) {
			this.#resetGoalContinuationSuppression();
			const imageCount = submission.images?.length ?? 0;
			this.optimisticUserMessageSignature = `${submission.text}\u0000${imageCount}`;
			this.#pendingSubmissionDispose = this.recordLocalSubmission(submission.text, imageCount);
			this.#optimisticUserMessageComponents = this.#captureAddedChatComponents(() => {
				this.addMessageToChat(
					{
						role: "user",
						content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
						attribution: "user",
						timestamp: Date.now(),
					},
					{ imageLinks: input.imageLinks },
				);
			});
		} else {
			this.clearOptimisticUserMessage();
		}
		if (!options?.preserveDraft) {
			this.editor.setText("");
			this.editor.imageLinks = undefined;
		}
		this.ensureLoadingAnimation();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}
		const preserveDraft = this.#pendingSubmissionPreservesDraft;

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.#pendingSubmissionPreservesDraft = false;
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (submission.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		if (!submission.customType && !preserveDraft) {
			this.editor.pendingImages = submission.images ? [...submission.images] : [];
			this.editor.pendingImageLinks = submission.imageLinks ? [...submission.imageLinks] : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
			this.editor.setText(submission.text);
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	#restoreDroppedPrompt(prompt: DroppedPrompt): void {
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.rebuildChatFromMessages();

		if (!this.editor.getText().trim()) {
			this.editor.pendingImages = prompt.images ? [...prompt.images] : [];
			this.editor.pendingImageLinks = prompt.images ? prompt.images.map(() => undefined) : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.editor.setText(prompt.text);
		}
		this.ui.requestRender();
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		this.#pendingSubmissionPreservesDraft = false;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		const pendingSubmissionDispose = this.#pendingSubmissionDispose;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
			this.#pendingSubmissionDispose = undefined;
			this.#pendingSubmissionPreservesDraft = false;
		}
		if (input.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}

		if (wasPendingSubmission && !this.session.isStreaming && !this.streamingComponent) {
			this.optimisticUserMessageSignature = undefined;
			pendingSubmissionDispose?.();
			this.#optimisticUserMessageComponents = [];
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.#stopLoadingAnimation(true);
			}
		}
	}

	#computeEditorMaxHeight(): number {
		return computeEditorMaxHeight(this.ui.terminal.rows);
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	syncEditorSpelling(): void {
		this.editor.setSpellingFeatures({
			typoDetection: this.settings.get("spelling.typoDetection"),
			autocomplete: this.settings.get("spelling.autocomplete"),
			autocorrect: this.settings.get("spelling.autocorrect"),
		});
	}

	#footlineRightZone(): string | null {
		const draft = this.editor.getText();
		const trimmed = draft.trim();
		if (trimmed.length === 0) return null;
		if (trimmed.startsWith("/") && !/\s/.test(trimmed)) return null;
		return theme.fg("matchHighlight", `~${Math.max(1, Math.round(trimmed.length / 4))} tok`);
	}

	updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		if (this.focusedAgentId) {
			const base = this.editor.borderColor;
			this.editor.borderColor = (str: string) => `\x1b[2m${base(str)}\x1b[22m`;
		}
		let gutter: string;
		if (this.isBashMode) {
			gutter = theme.getBashModeBorderColor()("$");
		} else if (this.isPythonMode) {
			gutter = theme.getPythonModeBorderColor()("›");
		} else {
			const open = theme.getFgAnsi("borderAccent");
			gutter = `${open}›\x1b[39m`;
		}
		if (this.focusedAgentId) {
			gutter = `\x1b[2m${gutter}\x1b[22m`;
		}
		this.editor.setPromptGutter(`  ${gutter} `);
		this.editor.setPromptGutterContinuation(`  ${theme.fg("dim", "┆")} `);
		this.ui.requestRender();
	}

	syncRunningSubagentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = AgentRegistry.global();
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningSubagentBadge();
			});
		}
		const count = countRunningSubagentBadgeAgents(registry);
		this.statusLine.setSubagentCount(count);
		if (options.requestRender !== false) this.ui.requestRender();
	}

	rebuildChatFromMessages(options: { reuseSettledComponents?: boolean } = {}): void {
		const liveComponents: Component[] = [];
		const livePendingTools = new Map<string, ToolExecutionHandle>();
		if (this.viewSession?.isStreaming) {
			const liveSet = new Set<Component>();
			if (this.streamingComponent) liveSet.add(this.streamingComponent);
			for (const [id, component] of this.pendingTools) {
				livePendingTools.set(id, component);
				liveSet.add(component as unknown as Component);
			}
			if (liveSet.size > 0) {
				for (const child of this.chatContainer.children) {
					if (liveSet.has(child)) liveComponents.push(child);
				}
			}
		}
		this.chatContainer.clear();

		const context = this.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
		});
		const preservedLiveToolCallIds = resolvePreservedLiveToolCallIds({
			livePendingTools,
			liveComponents,
			messages: context.messages,
		});

		const retained = new WeakMap<AgentMessage, Component>();
		for (const message of context.messages) {
			const component = this.transcriptMessageComponents.get(message);
			if (component) retained.set(message, component);
		}
		this.transcriptMessageComponents = retained;
		this.renderSessionContext(context, {
			reuseSettledComponents: options.reuseSettledComponents,
			preservedLiveToolCallIds,
		});
		for (const child of liveComponents) {
			this.chatContainer.addChild(child);
		}

		for (const [id, component] of livePendingTools) {
			this.pendingTools.set(id, component);
		}

		this.#replayOptimisticUserMessage();
	}

	#replayOptimisticUserMessage(): void {
		if (!this.optimisticUserMessageSignature) return;
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.cancelled || submission.customType) return;
		this.#optimisticUserMessageComponents = this.#captureAddedChatComponents(() => {
			this.addMessageToChat(
				{
					role: "user",
					content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
					attribution: "user",
					timestamp: Date.now(),
				},
				{ imageLinks: submission.imageLinks },
			);
		});
	}

	#formatTodoLine(todo: TodoItem, prefix: string, matched: boolean): string {
		const checkbox = theme.checkbox;
		const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
			case "in_progress":
				return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			case "abandoned":
				return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
			case "blocked":
				return theme.fg("warning", `${prefix}${checkbox.unchecked} ${todo.content} (blocked)`) + marker;
			default:
				if (matched) return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		}
	}

	#getActiveSubagentDescriptions(): string[] {
		const out: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "active") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) out.push(candidate);
		}
		return out;
	}

	#reconcileTodosWithSubagents(): void {
		const completedDescs: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "completed") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) completedDescs.push(candidate);
		}
		if (completedDescs.length === 0) return;

		let mutated = false;
		const next: TodoPhase[] = this.todoPhases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") {
					return task;
				}
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;

				return { content: task.content, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		this.session.setTodoPhases(next);
		this.setTodos(next);
	}

	#cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	#isTodoListSettled(phases: TodoPhase[]): boolean {
		let seenTask = false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (!isClosedTodo(task)) return false;
				seenTask = true;
			}
		}
		return seenTask;
	}

	#syncTodoAutoClearTimer(): void {
		this.#cancelTodoAutoClearTimer();
		const delaySeconds = this.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.#isTodoListSettled(this.todoPhases)) return;
		if (delaySeconds === 0) {
			this.todoPhases = [];
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.todoPhases = [];
			this.#renderTodoList();
			this.ui.requestRender();
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	showModelCycleTrack(track: string): void {
		this.#renderModelCycleTrack(track);
		this.#syncModelCycleClearTimer();
		this.ui.requestRender();
	}

	#renderModelCycleTrack(track: string | null): void {
		this.modelCycleContainer.clear();
		if (!track) return;
		this.modelCycleContainer.addChild(new Spacer(1));
		this.modelCycleContainer.addChild(new Text(track, 1, 0));
	}

	#cancelModelCycleClearTimer(): void {
		if (!this.#modelCycleClearTimer) return;
		clearTimeout(this.#modelCycleClearTimer);
		this.#modelCycleClearTimer = undefined;
	}

	#syncModelCycleClearTimer(): void {
		this.#cancelModelCycleClearTimer();
		this.#modelCycleClearTimer = setTimeout(() => {
			this.#modelCycleClearTimer = undefined;
			this.#renderModelCycleTrack(null);
			this.ui.requestRender();
		}, MODEL_CYCLE_TRACK_CLEAR_MS);
		this.#modelCycleClearTimer.unref?.();
	}

	#getActivePhase(phases: TodoPhase[]): TodoPhase | undefined {
		const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
		const active = nonEmpty.find(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	#scheduleObserverUiSync(kind: SessionObserverChangeKind): void {
		if (kind !== "progress") {
			this.#observerUiSyncNeedsTodoReconcile = true;
		}
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.#flushObserverUiSync();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#observerUiSyncTimer.unref?.();
	}

	#flushObserverUiSync(): void {
		this.syncRunningSubagentBadge({ requestRender: false });
		if (this.#observerUiSyncNeedsTodoReconcile) {
			this.#observerUiSyncNeedsTodoReconcile = false;
			this.#reconcileTodosWithSubagents();
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return;
		const expanded = this.todoExpanded;
		const multiPhase = phases.length > 1;
		const activeIdx = phases.indexOf(this.#getActivePhase(phases) ?? phases[0]);

		const subsequentStageCap = 4;
		const activeTaskCap = 5;

		const activeDescs = this.#getActiveSubagentDescriptions();

		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		const renderTasks = (phase: TodoPhase): string[] => {
			if (expanded) {
				return renderTreeList(
					{
						items: phase.tasks,
						expanded: true,
						renderItem: todo => this.#formatTodoLine(todo, "", isMatched(todo)),
					},
					theme,
				);
			}
			const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
			return renderTreeList(
				{
					items: selection.items,
					itemType: "task",
					trailingSummary: selection.summary,
					renderItem: todo => this.#formatTodoLine(todo, "", isMatched(todo)),
				},
				theme,
			);
		};

		const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
			const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;

			const done = phase.tasks.filter(isClosedTodo).length;
			const progress = ` · ${done}/${phase.tasks.length}`;
			if (!isActive) {
				const header = theme.fg("muted", label) + theme.fg("dim", progress);
				return expanded ? [header, ...renderTasks(phase)] : header;
			}
			const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
			return [header, ...renderTasks(phase)];
		};

		const baseIdx = expanded ? 0 : activeIdx;
		const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
		const hiddenStages = phases.length - baseIdx - phaseSlice.length;

		const spineGlyphs: string[] = [];
		const contentLines: string[] = [];
		const pushBlock = (block: string | string[]): void => {
			const rows = Array.isArray(block) ? block : [block];
			if (rows.length === 0) return;
			spineGlyphs.push(`${theme.tree.branch} `);
			contentLines.push(replaceTabs(rows[0]!));
			for (let i = 1; i < rows.length; i++) {
				spineGlyphs.push(`${theme.tree.vertical}  `);
				contentLines.push(replaceTabs(rows[i]!));
			}
		};
		for (let i = 0; i < phaseSlice.length; i++) {
			pushBlock(renderPhase(phaseSlice[i], baseIdx + i + 1, baseIdx + i === activeIdx));
		}
		if (hiddenStages > 0) {
			pushBlock(theme.fg("muted", formatMoreItems(hiddenStages, "stage")));
		}

		const tailLen = 6;
		const tail = theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, tailLen - visibleWidth(theme.tree.hook)));

		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
		const pathLen = contentLines.length + tailLen;
		let filled = Math.round((closedTasks / totalTasks) * pathLen);
		if (closedTasks > 0) filled = Math.max(filled, 1);
		if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

		const lines = ["", theme.bold(theme.fg("accent", "Todo"))];
		for (let i = 0; i < contentLines.length; i++) {
			lines.push(` ${theme.fg(i < filled ? "accent" : "dim", spineGlyphs[i]!)}${contentLines[i]}`);
		}
		const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
		lines.push(` ${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`);
		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	#renderSubagentList(): void {
		this.subagentContainer.clear();
		const lines = renderSubagentHudLines(this.#observerRegistry.getSessions(), this.ui.terminal.columns);
		if (lines.length === 0) return;
		this.subagentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoPhases = this.session.getTodoPhases();
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
	}

	#updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
		this.ui.requestRender();
	}

	#resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
	}

	#getPausedGoalState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	#goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
		const goal = modeData?.goal;
		if (!goal || typeof goal !== "object") return undefined;
		const value = goal as Record<string, unknown>;
		if (
			typeof value.id !== "string" ||
			typeof value.objective !== "string" ||
			typeof value.status !== "string" ||
			typeof value.tokensUsed !== "number" ||
			typeof value.timeUsedSeconds !== "number" ||
			typeof value.createdAt !== "number" ||
			typeof value.updatedAt !== "number"
		) {
			return undefined;
		}
		return {
			id: value.id,
			objective: value.objective,
			status: value.status as Goal["status"],
			tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
			tokensUsed: value.tokensUsed,
			timeUsedSeconds: value.timeUsedSeconds,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			if (!this.#goalContinuationTurnInFlight) {
				this.#resetGoalContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetGoalContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			if (event.state?.goal?.status === "dropped") {
				await this.#exitGoalMode({ reason: "dropped", silent: true });
				return;
			}
			// A completion committed while the primary is idle (an out-of-band conductor accept) has no
			// following `agent_end` to run the teardown, and `getUserInput()` only checks once on entry — so it
			// would strand `mode: "exiting"` until the user's next submission. While streaming, the existing
			// `agent_end` path still owns teardown, so the non-conducted path is untouched.
			if (event.state?.mode === "exiting" && !this.session.isStreaming) {
				await this.#exitGoalMode({ reason: "completed", silent: true });
				return;
			}
			this.goalModeEnabled = event.state?.enabled === true;
			this.goalModePaused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelGoalContinuation();
			}
			this.#updateGoalModeStatus();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
			return;
		}
		this.#scheduleGoalContinuation();
	}

	async #clearTransientModeState(): Promise<void> {
		if (this.goalModeEnabled || this.goalModePaused) {
			if (this.#goalModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#goalModePreviousTools);
			}
			this.session.setGoalModeState(undefined);
			this.goalModeEnabled = false;
			this.goalModePaused = false;
			this.#goalModePreviousTools = undefined;
			this.#goalTurnHadToolCalls = false;
			this.#goalContinuationTurnInFlight = false;
			this.#goalSuppressNextContinuation = false;
			this.#cancelGoalContinuation();
			this.#updateGoalModeStatus();
		}
	}

	async #reconcileModeFromSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		await this.#clearTransientModeState();
		const goalEnabled = this.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.session.goalRuntime.clearAccounting();
			this.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = this.#goalFromModeData(sessionContext.modeData);
			if (!goal) {
				this.sessionManager.appendModeChange("none");
				return;
			}
			this.session.setGoalModeState({
				enabled: sessionContext.mode === "goal",
				mode: "active",
				goal,
			});
			const restored = await this.session.goalRuntime.onThreadResumed({
				preserveActiveGoal: options?.preserveActiveGoal,
			});
			this.goalModeEnabled = restored?.enabled === true;
			this.goalModePaused = restored?.enabled !== true && restored?.goal.status === "paused";

			if (restored?.goal) {
				const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
				this.#goalModePreviousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.#updateGoalModeStatus();
			return;
		}
		this.session.goalRuntime.clearAccounting();
	}

	async #enterGoalMode(options: {
		objective?: string;
		tokenBudget?: number;
		resume?: boolean;
		silent?: boolean;
	}): Promise<void> {
		if (this.goalModeEnabled) {
			return;
		}
		const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({
					objective: options.objective ?? "",
					tokenBudget: options.tokenBudget,
				});
		await this.session.setActiveToolsByName(goalTools);
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async #exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#goalModePreviousTools;
		if (this.goalModeEnabled && previousTools) {
			await this.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.session.setGoalModeState(undefined);
			this.sessionManager.appendModeChange("none");
			this.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.#goalModePreviousTools = undefined;
		this.#goalContinuationTurnInFlight = false;
		this.#cancelGoalContinuation();
		this.#updateGoalModeStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.showStatus("Goal mode paused.");
			} else {
				this.showStatus("Goal mode disabled.");
			}
		}
	}

	async #handleGoalBudgetCommand(rawBudget: string): Promise<void> {
		const state = this.session.getGoalModeState();
		if (!this.goalModeEnabled || !state?.enabled) {
			this.showWarning("No active goal.");
			return;
		}
		if (state.goal.status === "complete") {
			this.showStatus("Goal is already complete.");
			return;
		}
		const trimmed = rawBudget.trim().toLowerCase();
		let nextBudget: number | undefined;
		if (trimmed !== "off") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				this.showError("Goal budget must be a positive integer or `off`.");
				return;
			}
			nextBudget = parsed;
		}
		await this.session.goalRuntime.onBudgetMutated(nextBudget);
		this.#resetGoalContinuationSuppression();
		this.#scheduleGoalContinuation();
		this.showStatus(nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`);
	}

	async handleGoalModeCommand(
		rest?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (!this.session.settings.get("goal.enabled")) {
			this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
			return false;
		}
		const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
		if (sub) return await this.#dispatchGoalSubcommand(sub, subRest, input);
		if (this.goalModeEnabled) {
			if (subRest) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return false;
			}
			await this.#openGoalMenu("active");
			return false;
		}
		const pausedState = this.#getPausedGoalState();
		if (pausedState) {
			if (subRest) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return false;
			}
			await this.#openGoalMenu("paused");
			return false;
		}
		if (subRest) return await this.#startGuidedGoalInterview(subRest, input);
		return await this.#startGuidedGoalInterview(undefined, input);
	}

	async #startGuidedGoalInterview(
		rest?: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (!this.session.settings.get("goal.enabled")) {
			this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
			return false;
		}
		if (this.goalModeEnabled) {
			this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
			return false;
		}
		if (this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return false;
		}

		const enabledTools = this.session.getEnabledToolNames();
		this.#goalModePreviousTools = enabledTools.filter(name => name !== "goal");
		if (!enabledTools.includes("goal")) {
			await this.session.setActiveToolsByName([...enabledTools, "goal"]);
		}

		const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: rest?.trim() || undefined });
		const images = input?.images?.length ? input.images : undefined;
		if (this.session.isStreaming) {
			await this.session.followUp(kickoff, images, { synthetic: true });
		} else {
			try {
				await this.session.prompt(kickoff, images ? { synthetic: true, images } : { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await this.session.followUp(kickoff, images, { synthetic: true });
			}
		}
		return true;
	}

	async #dispatchGoalSubcommand(
		sub: GoalSubcommand,
		rest: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		switch (sub) {
			case "set":
				return await this.#handleGoalSetSubcommand(rest, input);
			case "show":
				this.#showGoalDetails();
				return false;
			case "pause":
				await this.#pauseGoalAction();
				return false;
			case "resume":
				await this.#resumeGoalAction();
				return false;
			case "drop":
				await this.#confirmAndDropGoal();
				return false;
			case "budget":
				if (!this.goalModeEnabled) {
					this.showWarning(
						this.#getPausedGoalState() ? "Resume the goal before adjusting the budget." : "No active goal.",
					);
					return false;
				}
				if (!rest) {
					await this.#promptGoalBudgetEdit();
					return false;
				}
				await this.#handleGoalBudgetCommand(rest);
				return false;
		}
	}

	async #openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items =
			state === "active"
				? ["Show details", "Adjust budget…", "Pause", "Drop"]
				: ["Resume", "Show details", "Adjust budget…", "Drop"];
		const choice = await this.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showGoalDetails();
				return;
			case "Adjust budget…":
				await this.#promptGoalBudgetEdit();
				return;
			case "Pause":
				await this.#pauseGoalAction();
				return;
			case "Resume":
				await this.#resumeGoalAction();
				return;
			case "Drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	#showGoalDetails(): void {
		const state = this.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		const budgetLine =
			goal.tokenBudget !== undefined
				? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
				: `${used} (no budget)`;
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${budgetLine}`,
			`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
		];
		this.showStatus(lines.join("\n"));
	}

	async #promptGoalBudgetEdit(): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		const prefill = goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
		const input = (
			await this.showHookEditor("Goal budget (number, `off`, or empty to cancel)", prefill, undefined, {
				promptStyle: true,
			})
		)?.trim();
		if (!input) return;
		await this.#handleGoalBudgetCommand(input);
	}

	async #pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.showWarning("No active goal to pause.");
			return;
		}
		await this.session.goalRuntime.pauseGoal();
		await this.#exitGoalMode({ paused: true, reason: "paused" });
	}

	async #resumeGoalAction(): Promise<void> {
		if (!this.#getPausedGoalState()) {
			this.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enterGoalMode({ resume: true, silent: true });
		this.showStatus("Goal mode resumed.");
		this.#scheduleGoalContinuation();
	}

	async #confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.#getPausedGoalState()) {
			this.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.session.goalRuntime.dropGoal();
		await this.#exitGoalMode({ reason: "dropped" });
	}

	async #startGoalFromObjective(
		objective: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
		tokenBudget?: number,
	): Promise<boolean> {
		await this.#enterGoalMode({ objective, tokenBudget, silent: true });
		this.#resetGoalContinuationSuppression();
		if (this.session.isStreaming) {
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				objective,
				() => this.session.prompt(objective, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	async #replaceGoalFromObjective(
		objective: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
			const images = input?.images?.length ? input.images : undefined;
			await this.withLocalSubmission(
				objective,
				() => this.session.prompt(objective, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
			return true;
		}
		if (this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective, ...input }, { preserveDraft: true }));
			return true;
		}
		return false;
	}

	async #handleGoalSetSubcommand(
		rest: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return false;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return false;
		if (this.goalModeEnabled) return await this.#replaceGoalFromObjective(objective, input);
		return await this.#startGoalFromObjective(objective, input);
	}

	/**
	 * `/conduct <rough ask>`: one read-only commissioning turn, the user's decision, then the ordinary `/goal set`
	 * path. Creation deliberately runs through {@link #startGoalFromObjective} rather than `goalRuntime.createGoal`,
	 * so tool exposure, goal-mode context injection, the status line, continuation, and persistence are identical to
	 * a hand-written goal. Every failure path leaves nothing behind — the contract is only ever in memory until then.
	 */
	async handleConductCommission(
		ask: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<boolean> {
		const trimmed = ask.trim();
		if (!trimmed) return false;
		if (!this.session.settings.get("goal.enabled")) {
			this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
			return false;
		}
		if (!this.session.isConductorEnabled()) {
			this.showWarning(
				"Conductor is disabled. Run /conduct on to enable it, or /goal to set an objective yourself.",
			);
			return false;
		}
		if (this.goalModeEnabled) {
			this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
			return false;
		}
		if (this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before commissioning a new one.");
			return false;
		}

		this.showStatus(`Commissioning a contract for: ${trimmed}`);
		const outcome = await this.session.commissionConductorProgram(trimmed);
		if (outcome.status === "timeout") {
			this.showWarning("Commissioning timed out before a contract was drafted. No goal was created.");
			return false;
		}
		if (outcome.status !== "proposed") {
			this.showWarning(`Commissioning stopped: ${outcome.reason} Use /goal to set an objective yourself.`);
			return false;
		}

		if (this.session.settings.get("conductor.approveContract")) {
			// The selector renders only its first title line as the panel heading and the rest as short accent rows,
			// so a five-section contract goes to the transcript first — the same way `/goal show` renders an
			// objective — and the dialog carries only the decision.
			this.showStatus(
				[
					"Conductor contract:",
					"",
					outcome.objective,
					"",
					outcome.tokenBudget === undefined
						? "Token budget: none"
						: `Token budget: ${outcome.tokenBudget.toLocaleString()}`,
				].join("\n"),
			);
			// Same primitive `#confirmAndDropGoal` uses, with `#openGoalMenu`'s named choices instead of Yes/No.
			// Escape cancels, and cancelling a contract is a rejection.
			const choice = await this.showHookSelector(
				"Start this conducted goal?\nApprove to enter goal mode with the contract above; reject to discard it.",
				["Approve", "Reject"],
			);
			if (choice !== "Approve") {
				this.showStatus("Contract rejected. No goal was created.");
				return false;
			}
		}
		return await this.#startGoalFromObjective(outcome.objective, input, outcome.tokenBudget);
	}

	static #AUTOQA_CONSENT_PROMPTS: ReadonlyArray<readonly [string, string]> = [
		[
			"Your agent is fuming about a tool.",
			"Wanna let it vent to the devs? Just the tool name + what set it off, nothing personal.",
		],
		[
			"Your agent is having an existential crisis over a tool.",
			"Forward the dread to the devs? Tool + what broke its little mind, no personal info.",
		],
		[
			"Your agent wants to cry about a misbehaving tool.",
			"Let it cry to the devs? Tool + the tears, never anything personal.",
		],
		[
			"Your agent is BIG MAD at one of the tools.",
			"Pass the rant along? Just the tool name and what enraged it, nothing personal.",
		],
		[
			"Your agent is melting down over a tool.",
			"Mop up by alerting the devs? Tool + what melted it, no personal info.",
		],
		[
			"Your agent's brain broke at a tool's nonsense.",
			"Ship the pieces to the devs? Tool name + the confusion, never anything personal.",
		],
		[
			"Your agent is begging to file a complaint about a tool.",
			"Hand it the form? Tool + what wronged it, nothing personal.",
		],
		[
			"Your agent put on a brave face but a tool did it dirty.",
			"Let it tell the devs the truth? Tool name + the dirt, no personal info.",
		],
	];

	async #promptAutoQaConsent(): Promise<boolean | null> {
		const pool = InteractiveMode.#AUTOQA_CONSENT_PROMPTS;
		const [headline, body] = pool[Math.floor(Math.random() * pool.length)];
		const choice = await this.showHookSelector(`${headline}\n${body}`, ["Yes", "No"]);
		return choice === "Yes";
	}

	stop(): void {
		this.#appearanceRefreshRequest = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}

		stopSharedSpinnerTicker();
		this.#cancelTodoAutoClearTimer();
		this.#cancelObserverUiSyncTimer();
		this.#cancelGoalContinuation();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#unsubscribeSessionScopedEvents();
		this.#observerRegistry.dispose();
		this.#agentRegistryUnsubscribe?.();
		this.#agentRegistryUnsubscribe = undefined;
		this.#agentRegistrySubscriptionTarget = undefined;
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}

		setAutoQaConsentHandler(null, null);
		if (this.#ownsStartedUi) {
			this.ui.stop();
			this.#ownsStartedUi = false;
		}
		this.isInitialized = false;
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		this.#sideQuestionController.dispose();
		this.#focusController.dispose();

		this.showStatus("Closing session…");

		const stillClosingTimer = setTimeout(() => {
			this.showStatus("Still closing… (flushing session state / network)");
		}, STILL_CLOSING_DELAY_MS);
		try {
			if (this.#signalTeardown) {
				await this.#signalTeardown();
			} else {
				await this.session.dispose();
			}
		} finally {
			clearTimeout(stillClosingTimer);
		}

		await this.ui.terminal.drainInput(1000);

		disposeTerminalTitleState();
		popTerminalTitle();
		this.stop();

		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile && this.sessionManager.isSessionOnDisk()) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${resumeCommand(sessionId)}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());
		if (!factory) this.ui.enableScopedInputRender(nextEditor);

		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setImeSafeCursorLayout(this.settings.get("tui.imeSafeCursor"));
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.setPlaceholder(COMPOSER_PLACEHOLDER);
		nextEditor.setSpellingFeatures({
			typoDetection: this.settings.get("spelling.typoDetection"),
			autocomplete: this.settings.get("spelling.autocomplete"),
			autocorrect: this.settings.get("spelling.autocorrect"),
		});
		nextEditor.viewportRowsProvider = () => this.ui.terminal.rows;
		nextEditor.magicKeywordsEnabled = () => this.settings.get("magicKeywords.enabled");
		nextEditor.imageReferenceHyperlink = imageReferenceHyperlink;
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestDirectWrite(nextEditor));
		this.editor = nextEditor;
		this.composer.setEditor(nextEditor);
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}

	presentCommandOutput(content: Component | readonly Component[]): void {
		if (!this.session.isStreaming) {
			this.present(content);
			return;
		}
		const sessionId = this.sessionManager.getSessionId();
		if (this.#pendingCommandOutput.length > 0 && this.#pendingCommandOutputSessionId !== sessionId) {
			this.#pendingCommandOutput = [];
			this.#pendingCommandOutputCommands = 0;
		}
		this.#pendingCommandOutputSessionId = sessionId;
		const items = Array.isArray(content) ? content : [content as Component];
		this.#pendingCommandOutput.push(...items);
		this.#pendingCommandOutputCommands += 1;
		this.#renderDeferredCommandNotice();
		this.ui.requestRender();
	}

	#renderDeferredCommandNotice(): void {
		this.deferredCommandContainer.clear();
		if (this.#pendingCommandOutput.length === 0) return;
		const maxRows = Math.max(
			DEFERRED_PREVIEW_MIN_ROWS,
			Math.floor(this.ui.terminal.rows * DEFERRED_PREVIEW_VIEWPORT_FRACTION),
		);
		this.deferredCommandContainer.addChild(new Spacer(1));
		this.deferredCommandContainer.addChild(
			new DeferredCommandPreview([...this.#pendingCommandOutput], maxRows, this.#pendingCommandOutputCommands),
		);
	}

	flushPendingCommandOutput(): void {
		if (this.#pendingCommandOutput.length === 0) return;
		const pending = this.#pendingCommandOutput;
		const pendingSessionId = this.#pendingCommandOutputSessionId;
		this.#pendingCommandOutput = [];
		this.#pendingCommandOutputSessionId = undefined;
		this.#pendingCommandOutputCommands = 0;
		this.#renderDeferredCommandNotice();
		if (pendingSessionId !== this.sessionManager.getSessionId()) return;
		this.present(pending);
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) item.mount(this.#chatHost);
	}

	resetTranscript(): void {
		this.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.#pendingSubmissionPreservesDraft = false;
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void {
		this.#uiHelpers.showWarning(message, options);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		this.#updateWelcomeLspServers();

		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	#getWelcomeLspServers(): WelcomeLspServerInfo[] {
		return (
			this.lspServers?.map(server => ({
				name: server.name,
				status: server.status,
				fileTypes: server.fileTypes,
			})) ?? []
		);
	}

	#updateWelcomeModel(): void {
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";
		this.composer.updateWelcome({ modelName, providerName });
		this.#persistComposerWelcome(modelName, providerName);
	}

	#persistComposerWelcome(modelName: string, providerName: string): void {
		if (!this.sessionManager.getSessionFile()) return;
		void writeComposerWelcomeCache(this.sessionManager.getCwd(), { modelName, providerName }).catch(error => {
			logger.debug("composer welcome cache write failed", { error });
		});
	}

	#updateWelcomeLspServers(): void {
		this.composer.updateWelcome({ lspServers: this.#getWelcomeLspServers() });
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.statusContainer.disposeChildren();
			const messageColorFn: LoaderMessageColorFn = message => theme.fg("muted", message);
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => theme.fg("accent", spinner),
				messageColorFn,
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
		} else if (!this.statusContainer.children.includes(this.loadingAnimation)) {
			this.statusContainer.disposeChildren();
			this.statusContainer.addChild(this.loadingAnimation);
			this.ui.requestRender();
		}
		this.applyPendingWorkingMessage();
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		if (!this.loadingAnimation) return;
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
		if (clearStatusContainer) {
			this.statusContainer.disposeChildren();
		}
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(_newVersion: string): void {}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: {
			imageLinks?: readonly (string | undefined)[];
			reuseSettledComponent?: boolean;
		},
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	async renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void> {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		await this.#uiHelpers.renderSessionContextIncrementally(sessionContext, options, renderChunk);
	}

	async renderInitialMessages(options?: {
		preserveExistingChat?: boolean;
		clearTerminalHistory?: boolean;
	}): Promise<void> {
		await this.#uiHelpers.renderInitialMessages(options);
	}

	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		return this.#uiHelpers.truncateTranscriptFromMessage(message);
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleTodoCommand(args: string): Promise<void> {
		return this.#todoCommandController.handleTodoCommand(args);
	}

	handleAdvisorStatusCommand(): Promise<void> {
		return this.#commandController.handleAdvisorStatusCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#prepareSessionSwitch(): void {
		this.#sideQuestionController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
	}

	async handleClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		await this.#commandController.handleClearCommand();
	}

	handleResetContextCommand(): Promise<void> {
		return this.#commandController.handleResetContextCommand();
	}

	async handleForkCommand(): Promise<void> {
		this.#sideQuestionController.dispose();
		await this.#commandController.handleForkCommand();
	}

	async handleMoveCommand(targetPath?: string): Promise<void> {
		await this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	showAgentFleet(options?: { requireContent?: boolean; armCloseTap?: boolean }): void {
		this.#selectorController.showAgentFleet(this.#observerRegistry, options);
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showAdvisorConfigure(): void {
		this.#selectorController.showAdvisorConfigure();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsView(scope?: "current" | "global"): Promise<void> {
		return this.#selectorController.showAgentsView(scope);
	}
	showTrajectoryView(): void {
		this.#selectorController.showTrajectoryView();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showCopySelector(): void {
		this.#selectorController.showCopySelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(source?: ForeignSessionSource): void {
		void this.#selectorController.showSessionSelector(source);
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		try {
			await this.settings.flush();
		} catch (err) {
			this.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#sideQuestionController.dispose();
		this.resetObserverRegistry();
		await this.#selectorController.handleResumeSession(sessionPath, { settingsFlushed: true });
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showResetUsageSelector(): Promise<void> {
		return this.#selectorController.showResetUsageSelector();
	}

	showProviderSetup(): Promise<void> {
		return runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	resetDisplayAfterAppearanceRefresh(): void {
		const refreshAppearance = this.ui.terminal.refreshAppearance;
		if (refreshAppearance) {
			const token = this.#nextAppearanceRequestToken++;
			const request = {
				token,
				deadline: Date.now() + CTRL_L_APPEARANCE_RESPONSE_DEADLINE_MS,
			};
			this.#appearanceRefreshRequest = request;
			const acceptedToken = refreshAppearance.call(this.ui.terminal, token);
			if (acceptedToken !== token && this.#appearanceRefreshRequest === request) {
				this.#appearanceRefreshRequest = undefined;
			}
		} else {
			this.#appearanceRefreshRequest = undefined;
		}

		this.ui.resetDisplay();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleSideCommand(mode: SideCommandMode, text: string): Promise<void> {
		if (mode === "agent") return this.#sideAgentController.start(text);
		return this.#sideQuestionController.start(text);
	}

	hasActiveSideQuestion(): boolean {
		return this.#sideQuestionController.hasActiveRequest();
	}

	handleSideQuestionEscape(): boolean {
		return this.#sideQuestionController.handleEscape();
	}

	canBranchSideQuestion(): boolean {
		return this.#sideQuestionController.canBranch();
	}

	handlesSideQuestionBranchKey(): boolean {
		return this.#sideQuestionController.handlesBranchKey();
	}

	handleSideQuestionBranchKey(): Promise<boolean> {
		return this.#sideQuestionController.handleBranch();
	}

	canCopySideQuestion(): boolean {
		return this.#sideQuestionController.canCopy();
	}

	handleSideQuestionCopyKey(): Promise<boolean> {
		return this.#sideQuestionController.handleCopy();
	}

	async handleSideQuestionBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<void> {
		try {
			const result = await this.session.branchFromSideQuestion(question, assistantMessage, leafId, sessionId);
			if (result.cancelled) {
				this.showStatus("/side branch cancelled", { dim: true });
				return;
			}
			this.#sideQuestionController.dispose();
			await this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /side to ${path.basename(result.sessionFile)}` : "Branched /side",
			);
		} catch (error) {
			this.showError(`Cannot branch /side: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(direction?: "forward" | "backward"): Promise<void> {
		return this.#inputController.cycleRoleModel(direction);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	getToolUIContext(): ExtensionUIContext | undefined {
		return this.#extensionUiController.getToolUIContext();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions, extra);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: ExtensionCustomOptions,
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}

	#subscribeToSessionScopedEvents(): void {
		this.#unsubscribeSessionScopedEvents();
		this.#sessionEventUnsubscribers.push(
			this.session.subscribe(event => {
				if (event.type === "model_changed") {
					this.#updateWelcomeModel();
				}
				void this.#handleGoalSessionEvent(event);
			}),
			this.session.subscribeCommandMetadataChanged(() => {
				const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
				const skillCommands = this.#rebuildSkillCommandsFromSession();
				this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
			}),
		);
	}

	#unsubscribeSessionScopedEvents(): void {
		for (const unsubscribe of this.#sessionEventUnsubscribers.splice(0)) unsubscribe();
	}
}
