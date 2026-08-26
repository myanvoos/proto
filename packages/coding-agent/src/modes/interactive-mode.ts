/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
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
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TanCommandController } from "./controllers/tan-command-controller";
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
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const STILL_CLOSING_DELAY_MS = 3_000;

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
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

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/**
 * Anchored live-region container for the HUD/status rows between the transcript
 * and the editor (working loader, todo + subagent HUDs, transient notification
 * panels). While it has content every row is live: it reports a seam at 0 and
 * pins that live region so the engine never commits these anchored,
 * rebuilt-in-place rows to native scrollback — otherwise stale duplicates pile
 * up above the live copy on short terminals once the loader sits below a tall HUD. The transcript's own seam,
 * when present, sits higher and wins (topmost-seam merge in TUI.render).
 */
class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
}

/**
 * Preview of the command panels queued while the agent streams, rendered above
 * the editor so `/usage` and friends answer immediately mid-turn.
 *
 * Capped in height: the panels are shown in full in the transcript at the next
 * settle, so the preview only has to answer the question, not reproduce the
 * whole report. Rendering is delegated to the real panels at the real width, so
 * the preview cannot drift from what eventually lands in the transcript.
 */
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

/** Never shrink the queued-output preview below this, even on a short terminal. */
const DEFERRED_PREVIEW_MIN_ROWS = 6;
/** Ceiling for the preview as a share of the viewport, so the prompt stays visible. */
const DEFERRED_PREVIEW_VIEWPORT_FRACTION = 0.4;

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * a bounded set of running-agent rows in the same `Id ⟨role⟩: description` shape
 * the inline task rows use (muted task preview when no description was given).
 * Layout mirrors the Todos HUD exactly: unindented header, then
 * `renderTreeList` rows (dim connectors) shifted right by one space.
 * Only detached background spawns are listed: a sync task call blocks the
 * parent turn and its inline tool block already renders progress live, and
 * eval `agent()` spawns are rendered by their own eval cell tree.
 * Returns an empty array when nothing is running so the container can clear.
 */
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
					// No spawn description: fall back to a muted task preview, same as
					// the inline task rows when a row has no label.
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

	/** Canonical composer shared by cold prepaint and the session-aware runtime. */
	readonly composer: Composer;
	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	btwContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	deferredCommandContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	#hookStatusRow: HookStatusRow | undefined;
	readonly #composerShortcuts = new ComposerShortcutsBar();
	/** Composer attachment band (chip cards) rendered directly above the prompt box. */
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
	/** Whether the visible session has produced thinking content the user can reveal. */
	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}
	/** Record received reasoning content so Ctrl+T can reveal it even when model metadata says thinking is off. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}
	/**
	 * Effective thinking-block visibility: hidden when the user's setting is on,
	 * or while thinking is "off" before the session has actually produced
	 * displayable thinking content. Some providers return thinking blocks without
	 * advertising reasoning support, so observed content unlocks the visibility
	 * toggle.
	 */
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
	/** True while an optimistically-rendered `/skill:` row awaits its canonical
	 *  `message_start`. Read by the event controller to reconcile the row. */
	optimisticSkillMessagePending = false;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	/** Owns Esc for every `/mcp test` that is active or whose cancellation hint may still be visible. */
	mcpTestEscapeHandlers = new Set<() => void>();
	lastLeftTapTime = 0;
	lastRightTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
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
	/** Commands (not components) queued while streaming, for the deferral hint. */
	#pendingCommandOutputCommands = 0;
	#pendingSlashCommands: SlashCommand[] = [];
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
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

	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
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
	/**
	 * Always derived from the live `session`: wholesale main-session swaps
	 * (detached resume) replace ctx.session, and every cached manager reference
	 * must follow instead of going stale.
	 */
	get sessionManager(): SessionManager {
		return this.session.sessionManager;
	}
	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}
	/** Re-attach the view to a wholesale-swapped main AgentSession (detached resume). */
	attachSessionView(target: AgentSession): Promise<void> {
		const attached = this.#focusController.attachSwappedMain(target);
		// Session-scoped subscriptions and the mode reconciler bind per
		// AgentSession instance: a wholesale swap must re-point both or the
		// swapped-in session renders stale welcome/command/mode state.
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
	/** Subscriptions bound to the CURRENT main session; re-pointed on wholesale swaps. */
	#sessionEventUnsubscribers: Array<() => void> = [];
	/**
	 * Mode reconciler installed on every attached main session: a swapped-in
	 * instance (detached resume) must reconcile mode on its own internal
	 * switches exactly like the startup session did.
	 */
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
		// A cold-start composer already owns the terminal. Reuse it so input
		// buffered during startup remains in the same editor instance.
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		this.ui.setResizeScrollback(settings.get("tui.resizeScrollback"));
		this.ui.setShowHardwareCursor(settings.get("showHardwareCursor"));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.supportsTextSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.supportsTextSizing);
		this.chatContainer = new TranscriptContainer();
		// The first conversation block ends the welcome-screen anchor split:
		// re-home the fills so the transcript + HUD/loader stack pins to the
		// bottom edge instead of floating above the composer (syncHomeAnchor
		// otherwise runs only at init and on resize).
		this.chatContainer.onFirstContent = () => {
			this.composer.syncHomeAnchor(this.chatContainer.children.length);
		};
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new AnchoredLiveContainer();
		this.todoContainer = new AnchoredLiveContainer();
		this.subagentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
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
		// Sync editor geometry only; never request a render here. This listener is
		// registered before ProcessTerminal's own stdout "resize" listener (added in
		// tui.start()), so it runs first on every SIGWINCH. The TUI's resize path
		// already owns the repaint on every route (viewport fast path + settle,
		// multiplexer debounce, alt-overlay repaint) and its settled render picks up
		// the new editor max height. Requesting an ordinary render here additionally
		// marked every resize as "render pending" (TUI hasPendingRender), which forced
		// the multiplexer width epoch's conservative full-transcript replay — one
		// duplicated transcript copy in pane history per tmux width change.
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
		// Restored drafts (esc-esc, /tree, branch) re-materialize blob-store links off the render
		// path so their chip tokens become clickable again instead of degrading to dead text.
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

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		const skillCommandList = this.#rebuildSkillCommandsFromSession();

		const builtinCommands: SlashCommand[] = [...buildTuiBuiltinSlashCommands({ ctx: this })];
		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#tanCommandController = new TanCommandController(this);
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

		// Route SIGINT/SIGTERM/SIGHUP/uncaughtException through the same teardown
		// the TUI Ctrl+C keypress path performs: persist the in-progress editor
		// draft for `--resume`, then dispose the session (which emits the extension
		// `session_shutdown` event, cancels the owned async job manager, disposes
		// eval kernels, releases owned browser tabs, and closes the session
		// manager). Without this callback a real kernel signal would drop the
		// draft, skip the `session_shutdown` contract from `shared-events.ts`,
		// and orphan background bash/task processes (issue #4080). The registered
		// callback and `shutdown()` share one promise-memoized teardown, so a
		// signal arriving mid-Ctrl+C no-ops instead of racing a second dispose.
		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.#inputController.getDraftText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			disposeSession: reason => this.session.dispose({ reason }),
		});
		// Forward the postmortem reason (SIGTERM/SIGHUP/uncaughtException/…) so the
		// persisted `session_exit` diagnostic carries the real trigger. Postmortem
		// runs callbacks in REVERSE registration order — this callback (registered
		// after the AgentSession constructor's `agent-session:<id>` recorder) runs
		// FIRST and its dispose() would otherwise persist the generic "dispose".
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		// Wire the report_tool_issue consent gate to the Yes/No dialog popup.
		// The handler is process-global — subagent tools (which can't reach
		// `showHookSelector` on their own) resolve through this exact closure.
		// `Settings.instance` is the disk-backed singleton; passing it explicitly
		// guarantees the decision persists even when the prompt is triggered
		// from a subagent whose own `Settings` is an in-memory snapshot.
		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
			this.session.slashCommands,
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
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
				this.btwContainer,
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

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});
		// Let the transient todo tool result light up pending todos executed by a
		// live subagent, matching the sticky HUD's active set (#5873).
		setActiveTodoDescriptionsProvider(() => this.#getActiveSubagentDescriptions());

		// Load initial todos
		await this.#loadTodoList();

		if (process.platform === "darwin" && TERMINAL.id === "wezterm" && !isInsideTerminalMultiplexer()) {
			this.#eventBusUnsubscribers.push(startMacOSAppearanceReprobeFallback(this.ui.terminal));
		}

		// A prepaint Composer may already own raw mode and the render loop.
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
		// Single side-effect point for title changes: every setSessionName caller
		// (first-input titling, /rename, extension renames) gets the terminal
		// title + accent updates from here. Registered before
		// initHooksAndCustomTools/#reconcileModeFromSession — all of which can
		// reach setSessionName during init.
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

		// Prewarm the local tiny-title worker off the submit hot path: spawn it
		// now, idle and unref'd, so the first submit reuses a live subprocess
		// instead of paying spawn latency ahead of the first frame (issue #6462).
		// No-ops for the online default and for already-named sessions that will
		// not be titled. Deferred via setImmediate so it runs AFTER the render
		// callback requestRender(true) queued above (immediates are FIFO) — the
		// spawn syscall never lands in the same loop turn ahead of the first paint.
		setImmediate(() => {
			if (!$env.PI_NO_TITLE && !this.sessionManager.getSessionName()) {
				tinyTitleClient.prewarm(this.settings.get("providers.tinyModel"));
			}
		});

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. goal mode on resume)
		this.session.setSessionSwitchReconciler?.(this.#sessionSwitchReconciler);
		await this.#reconcileModeFromSession();

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
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

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#subscribeToSessionScopedEvents();
		// Resync the welcome banner to the live model: the init-time
		// reconciliation (#reconcileModeFromSession) can change the model before
		// this subscription exists, so the model_changed events it emits are
		// never observed by the handler above.
		this.#updateWelcomeModel();
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					// Theme previews and multiplexer panes cannot safely replace native
					// scrollback: previews must stay non-destructive, and multiplexers
					// suppress ED3 so a forced replay would duplicate transcript history.
					this.ui.requestRender();
					return;
				}
				// Rows already committed to native scrollback are immutable; replay them
				// after a theme swap so a reader scrolled up sees the same palette.
				this.ui.requestRender(true, { clearScrollback: true });
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		const unsubscribeAppearanceReport = this.ui.terminal.onAppearanceReport?.((_mode, requestToken) => {
			const request = this.#appearanceRefreshRequest;
			if (request === undefined || requestToken !== request.token) return;
			// ProcessTerminal dispatches report callbacks first, then synchronously
			// dispatches onAppearanceChange when the reported appearance changed.
			// That change callback consumes the request below before this microtask
			// runs; an unchanged matching report has no change callback, so it
			// consumes the one-shot here. Comparing the captured request prevents a
			// newer Ctrl+L request from being cleared by this report's microtask.
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
			// Ctrl+L already replays immediately below. If either its asynchronous
			// OSC 11 response or an automatic query ahead of it reveals a theme
			// change, commit that change so theme loading performs a second full
			// replay with the newly detected palette.
			onTerminalAppearanceChange(mode, appearanceRefreshWasRequested ? {} : undefined);
		});
	}

	/** Reload the title-generation system prompt override for the provided working
	 *  directory and stash it on the session so first-input titling
	 *  ({@link input-controller}) shares one source
	 *  ({@link discoverTitleSystemPromptFile}; issue #3734). */
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

	/** Reload session skills and the `/skill:<name>` command list. */
	async refreshSkillState(): Promise<void> {
		await this.session.refreshSkills();
		const retainedCommands = this.#pendingSlashCommands.filter(command => !command.name.startsWith("skill:"));
		const skillCommands = this.#rebuildSkillCommandsFromSession();
		this.#pendingSlashCommands = [...retainedCommands, ...skillCommands];
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string, preloaded?: ReadonlyArray<FileSlashCommand>): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		// Session construction already ran slash-command discovery for this cwd;
		// init passes that result through instead of re-walking the providers.
		const fileCommands = preloaded ? [...preloaded] : await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		// Surface discovered prompt templates in the picker. AgentSession.prompt() expands
		// `expandSlashCommand` before `expandPromptTemplate`, and builtin command
		// execution resolves aliases before template expansion. Mirror that command
		// resolution order by skipping templates whose names already appear in any
		// builtin/hook/custom/skill/file command token.
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
				// `PromptTemplate.description` from `loadTemplatesFromDir` already includes the
				// source suffix (e.g. "Review code (project)"), so pass it through verbatim.
				description: template.description,
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Rebuild the editor's autocomplete provider: the built-in provider wrapped
	 * by every extension-registered factory, in registration order. A factory
	 * that throws or returns a malformed provider is skipped so one broken
	 * extension cannot take down core autocomplete.
	 */
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

	/** Stack extension autocomplete behavior on top of the built-in editor provider (#4919). */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<void> {
		setProjectDir(newCwd);
		// Re-scope project settings (`.claude/settings.yml` etc.) to the new
		// directory in place so the active session and every settings reader pick
		// up the destination project's configuration.
		if (isSettingsInitialized()) {
			await settings.reloadForCwd(newCwd);
			// Reapply provider preferences from the newly-loaded settings so the
			// module-level search/image provider state reflects the destination
			// project's configuration. Without this, the previous project's
			// exclusions leak and newly-excluded providers are still used.
			applyProviderGlobalsFromSettings(settings);
		}
		// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
		// the next prompt sees everything scoped to the new project directory.
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
		// Brief delay so the user has a chance to press Esc between iterations.
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
			// The 800ms timer can outlive the idle window that scheduled it: a
			// `/goal set` taken via the streaming branch (or any extension/hook
			// path that starts a turn while we wait) leaves the agent busy. Firing
			// the continuation now would route through `submitInteractiveInput` →
			// `promptCustomMessage` with no `streamingBehavior` and resurface
			// `AgentBusyError`. Drop this tick; `#handleGoalSessionEvent` reschedules
			// on the next `agent_end`.
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

	/**
	 * Pause the loop without exiting it: drops the captured prompt and any
	 * pending auto-resubmit. Loop mode stays enabled — the next prompt the
	 * user submits becomes the new loop prompt and resumes iteration.
	 */
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
		// Hand any inline prompt back to the dispatcher so the normal submit flow
		// runs the first iteration — it records the text as the loop prompt and
		// auto-resubmits it after each yield, identical to typing the prompt right
		// after enabling loop mode.
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

	/**
	 * Optimistically render a user-invoked `/skill:` row before its awaited
	 * dispatch so a slow preflight (memory recall, `before_agent_start` hooks,
	 * pre-prompt compaction) does not leave the
	 * submission invisible — normal prompts paint their row via
	 * {@link startPendingSubmission} the same way (issue #8895). The canonical
	 * skill `message_start` swaps this row in place via
	 * {@link reconcileOptimisticSkillMessage}; a failed or bailed dispatch drops
	 * it via {@link clearOptimisticSkillMessage}.
	 */
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

	/** Replace the optimistic `/skill:` row with the canonical message emitted by
	 *  the session, mirroring {@link replaceOptimisticUserMessage} for skills. */
	reconcileOptimisticSkillMessage(message: AgentMessage): void {
		this.optimisticSkillMessagePending = false;
		for (const component of this.#optimisticSkillMessageComponents) {
			this.chatContainer.removeChild(component);
		}
		this.#optimisticSkillMessageComponents = [];
		this.addMessageToChat(message);
	}

	/** Drop the optimistic `/skill:` row when dispatch fails or bails before the
	 *  message reaches the agent (aborted preflight, streaming-race requeue). */
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

	/**
	 * Hands back a prompt the session dropped before dispatch (an Esc abort or
	 * usage preflight denial raced turn setup). The message was never persisted,
	 * so the tree/branch selectors cannot offer it — remove the optimistic
	 * transcript row and put the typed text back in the editor for editing.
	 */
	#restoreDroppedPrompt(prompt: DroppedPrompt): void {
		this.clearOptimisticUserMessage();
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.rebuildChatFromMessages();
		// The drop arrives asynchronously (after the abort settles); never clobber
		// a draft the user has already started typing in the meantime.
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
			// Focused subagent view: faint the outline so the borrowed session is
			// visually distinct from the main one.
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

	/** Refresh the running-subagents status badge. */
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
		// Mid-stream rebuilds (theme/setting changes that touch the transcript)
		// replay only committed `state.messages`. The agent's in-flight
		// `streamMessage` and its still-pending tool calls live OUTSIDE
		// `state.messages` until `message_end`, so a plain clear+replay detaches
		// their UI components while keeping the `streamingComponent` / `pendingTools`
		// references — subsequent `message_update`/`message_end` events would then
		// update orphaned components that never re-render and the live LLM output
		// vanishes from the chat (#3656). Snapshot the in-flight components,
		// clear+replay, then re-append them in their original chat-container order
		// and restore the `pendingTools` map so streaming routes back into them.
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
		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers choose
		// their own mode.
		const context = this.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
		});
		const preservedLiveToolCallIds = new Set<string>();
		// A preserved pending-tool component whose result has already landed in
		// the replayed transcript is re-rendered by `renderSessionContext` itself
		// (the toolResult message reconstructs the block with its output). Keeping
		// it in the live set too re-appends a second identical block below the
		// replayed one — the tool call renders twice (#6516). The preservation
		// above assumes every pending-tool component is still dangling (its result
		// lives outside `state.messages`), which stops holding the instant the
		// result is persisted while the component lingers in `pendingTools` (a
		// rebuild racing tool-completion, a background/displaceable snapshot).
		// Drop the already-resolved ones and let the replay own them; only
		// genuinely in-flight (dangling, replay-stripped) calls still need
		// preserving.
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			const resolved = livePendingTools.get(message.toolCallId);
			if (!resolved) continue;
			// A background task's initial `async.state === "running"` result is
			// persisted while `EventController#handleToolExecutionEnd` deliberately
			// keeps its component in `pendingTools` so a later
			// `tool_execution_update`/`_end` settles it. Such a handle is still
			// live — dropping it would strand those updates on the running snapshot
			// — so keep it and let the live component retain ownership; only
			// terminal results are owned by the replay. (Cast mirrors the async
			// detail reads in tool-execution.ts / event-controller.ts.)
			const details = message.details as { async?: { state?: string } } | undefined;
			if (details?.async?.state === "running") {
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			livePendingTools.delete(message.toolCallId);
			// A `ReadToolGroupComponent` is shared by every read id it renders
			// (ui-helpers sets the same group for each collapsed read call). While a
			// sibling read id still points at it the component must stay on screen
			// and preserved — splicing it here would detach the pending read's
			// display and strand its future result on an off-screen component.
			// Splice only once no remaining pending id shares it.
			let stillShared = false;
			for (const other of livePendingTools.values()) {
				if (other === resolved) {
					stillShared = true;
					break;
				}
			}
			if (stillShared) {
				// The shared component still owns this completed member as well as
				// its pending sibling. Suppress the replay copy so the group remains
				// a single on-screen block while future results keep routing to it.
				preservedLiveToolCallIds.add(message.toolCallId);
				continue;
			}
			const index = liveComponents.indexOf(resolved as unknown as Component);
			if (index >= 0) liveComponents.splice(index, 1);
		}
		// Prune the settled-component cache to the messages this rebuild will
		// actually render. Message objects stay strongly reachable through
		// session entries for the whole session, so entries for compacted-away
		// history would otherwise pin their components' rendered layout caches
		// forever — exactly the memory a collapsed compaction used to release.
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
		// `renderSessionContext` clears `pendingTools` at start AND end so the
		// reconstructed historical tool components don't leak into live tracking.
		// Restore the in-flight entries afterwards so the next streamed tool-call
		// delta is routed into the preserved component instead of stacking a
		// duplicate ToolExecutionComponent below it.
		for (const [id, component] of livePendingTools) {
			this.pendingTools.set(id, component);
		}
		// During the pre-streaming window — after `startPendingSubmission` has
		// optimistically rendered the user's message but before the user
		// `message_start` event lands it in `session` entries — any rebuild
		// (e.g. Ctrl+T toggleThinkingBlockVisibility, theme selector) would
		// otherwise erase the user's just-submitted message until the first
		// assistant token arrived (#2372). Once `message_start` fires the
		// signature is cleared by `EventController`, so this replay is a no-op
		// post-streaming and cannot duplicate.
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

	/**
	 * Auto-complete any open todo (pending/in_progress/blocked) whose content
	 * matches a subagent that has finished successfully. Fires on every observer
	 * `onChange` so the visual state stays in sync with subagent lifecycle
	 * without requiring the agent to issue a follow-up `todo`. A todo `block`ed
	 * while waiting on a detached subagent is included: that subagent completing
	 * is exactly the unblock signal, and blocked todos are excluded from the stop
	 * reminder, so leaving it blocked would strand it silently. Failed and aborted
	 * subagents are intentionally NOT auto-completed — those stay open so the user
	 * (or the next agent turn) can decide what to do.
	 *
	 * Idempotent: only flips open tasks, never re-touches completed ones.
	 */
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
				// Drop any blocker note along with the blocked status — the wait the
				// note described is over.
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

	/**
	 * Whether every todo is closed, so the HUD has nothing left to track.
	 *
	 * The auto-clear only fires on a settled list. Scrubbing closed tasks while
	 * open work remains is destructive: the walking viewport already hides all but
	 * the newest closed row, and those tasks are what the phase progress counters
	 * and the stage roman numerals are computed from — dropping them mid-run reset
	 * an in-flight phase to `0/n` and renumbered the stages, so a plan the agent
	 * was four tasks into rendered as untouched until the next `todo` call
	 * restored the real snapshot.
	 */
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

	/**
	 * Render the ctrl+p model-role cycle chip track into its own anchored
	 * container (just above the editor), mirroring the todo HUD: the container is
	 * cleared and rebuilt in place on every cycle, so rapid presses or concurrent
	 * chat activity can never stack duplicate tracks into the scrollback.
	 */
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
		// Fixed budgets keep the HUD bounded regardless of plan size / progress.
		const subsequentStageCap = 4; // stages shown after the active one (a trailing summary row covers the rest)
		const activeTaskCap = 5; // open tasks previewed for the active stage

		const activeDescs = this.#getActiveSubagentDescriptions();
		// A pending todo "lights up" (accent) when an in-flight subagent is doing
		// its work, matched by normalized content overlap.
		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		// Task subtree for a phase. Collapsed runs the shared walking-viewport
		// policy (completed/abandoned omitted, active work pulled to the head,
		// then following pending tasks) so the HUD and the transient tool result
		// can never disagree about the current work (#5873). Expanded lists all.
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

		// One phase node. The active stage is highlighted with normal-brightness task
		// progress; other stages render their whole row (name + progress) in the
		// brighter muted gray. Overall progress lives in the tree spine (below).
		const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
			const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
			// Closed, not just completed: the collapsed task window hides abandoned
			// tasks too, so counting only completions leaves the phase reading stuck.
			const done = phase.tasks.filter(isClosedTodo).length;
			const progress = ` · ${done}/${phase.tasks.length}`;
			if (!isActive) {
				const header = theme.fg("muted", label) + theme.fg("dim", progress);
				return expanded ? [header, ...renderTasks(phase)] : header;
			}
			const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
			return [header, ...renderTasks(phase)];
		};

		// Collapsed: active stage + a bounded number of following stages, with a
		// "… n more stages" row for anything past the cap. Expanded: every stage
		// from the top. Roman numerals stay tied to the real phase index.
		const baseIdx = expanded ? 0 : activeIdx;
		const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
		const hiddenStages = phases.length - baseIdx - phaseSlice.length;

		// Flatten the stage tree into content rows plus a per-row top-level spine
		// glyph (`├─` for stage rows, `│` for continuations). The spine never
		// closes downward — a short elbow tail (`└────`) ends the block instead,
		// so spine + bend + tail form one continuous progress path.
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

		// Closing tail: hook + a few horizontals. Every tail cell is 1 column in
		// both glyph sets, so string slicing below splits it by visible cells.
		const tailLen = 6;
		const tail = theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, tailLen - visibleWidth(theme.tree.hook)));

		// Overall progress (summed across every stage) fills the path in reading
		// order: down the spine, around the bend, out along the tail.
		// Clamp so partial progress lights at least one cell; a closed plan fills
		// the entire path until the configured auto-clear removes the HUD.
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

	/**
	 * Anchored HUD of in-flight subagents, mirroring the Todos block above the
	 * editor. Driven entirely by observer-registry change events, so rows appear
	 * on spawn and the whole block clears itself once the last subagent leaves
	 * the "active" state.
	 */
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
			// Handle drop before clearing goalModeEnabled so #exitGoalMode can
			// still restore the previous tool set while the flag is true.
			if (event.state?.goal?.status === "dropped") {
				await this.#exitGoalMode({ reason: "dropped", silent: true });
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

	/** Reconcile mode state and persistent workers after resume/switch. */
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
			// sdk.ts excludes "goal" from the initial active tool set unconditionally.
			// Re-add it now so the agent can call resume, complete, or drop on this goal.
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

	async #enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		if (this.goalModeEnabled) {
			return;
		}
		const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
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

	/** Guided-goal kickoff (the former `/guided-goal`): the agent interviews the
	 *  user in chat, then creates the goal itself via the `goal` tool. */
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

		// Expose the goal tool for the interview so the agent can finish by
		// calling `goal create`. Record the pre-interview toolset first: the
		// tool-driven create flips goalModeEnabled via `goal_updated`, and the
		// eventual goal exit restores this set (dropping the goal tool again).
		const enabledTools = this.session.getEnabledToolNames();
		this.#goalModePreviousTools = enabledTools.filter(name => name !== "goal");
		if (!enabledTools.includes("goal")) {
			await this.session.setActiveToolsByName([...enabledTools, "goal"]);
		}

		// The interview is a normal conversation: the kickoff rides in as a
		// hidden developer message, the agent asks its questions as regular
		// assistant turns, and the user answers in the ordinary editor. Queue
		// behind an in-flight run instead of aborting it.
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
	): Promise<boolean> {
		await this.#enterGoalMode({ objective, silent: true });
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
	 * Pool of consent-prompt variants. Each entry is `[headline, reassurance]`;
	 * the second line always promises the same scope (tool name + confusion
	 * details, never personal data) so users learn what they're consenting to
	 * even as the top line rotates.
	 *
	 * Kept in-module rather than i18n'd because the whole charm is the tone
	 * — translations would need to preserve it deliberately, not auto-render.
	 */
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

	/**
	 * Show the report_tool_issue consent popup and return the user's decision.
	 * Invoked by the process-global consent handler the tool dispatches to;
	 * subagent invocations bubble up here through the shared module state.
	 */
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
		// Stop the shared tool-spinner ticker: a live block missed by per-component
		// stopAnimation would otherwise keep an 80ms interval pinning the process.
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
		// Clear the process-global consent handler so it doesn't outlive this
		// InteractiveMode instance (e.g. test harnesses, headless re-init).
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

		this.#btwController.dispose();
		this.#focusController.dispose();

		// Surface an explicit "Closing session…" line so the user sees a reason
		// for the pause while `session.dispose()` flushes pending cleanups
		// (issue #3641). The await on the next line yields the
		// event loop, giving requestRender() a tick to paint the status before
		// dispose blocks.
		this.showStatus("Closing session…");

		// Persist the draft and dispose the session through the shared teardown
		// so a signal that arrives mid-shutdown cannot fire a second dispose.
		// The teardown is a promise-memoized singleton; whichever path calls it
		// first runs the work, the other awaits the same settled promise.
		// The teardown is registered lazily in `init()` — a `/exit` reached
		// before `init()` completed falls back to a direct dispose.
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

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible OMP content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		// Stop the run-state spinner interval BEFORE restoring the shell title, so a
		// pending tick cannot re-emit an OSC title after `popTerminalTitle` hands the
		// terminal back (which would leave the parent shell with a `π ⠋ …` tab).
		disposeTerminalTitleState();
		popTerminalTitle();
		this.stop();

		// Print resumption hint only if the session was actually materialized to
		// durable storage. Persistence is lazy — a session that exits before its
		// first assistant message (or dies early to an auth error, a mid-flight
		// Ctrl+C, or a launch-then-quit) never wrote its JSONL, so the path is
		// allocated but the file does not exist and `--resume <id>` would fail
		// (issue #8860).
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

	// Extension UI integration
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

	// UI helpers
	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}

	/**
	 * Defer transcript command panels while the agent is streaming, then mount
	 * them at the next settle, terminal or not. A non-terminal settle is only a
	 * scheduling pause, so resumed streaming can still land below a panel
	 * flushed there. That is preferred over leaving it queued behind a command
	 * the user runs during the pause, which mounts immediately and would put the
	 * older panel out of order.
	 *
	 * The deferral is acknowledged in {@link deferredCommandContainer}, an
	 * anchored container above the editor. Nothing is mounted into the
	 * transcript: a mid-turn transcript mount re-renders rows below the growing
	 * live block and duplicates them in native scrollback (issues #4806/#6767),
	 * which is why the earlier `showStatus` acknowledgment was reverted. An
	 * anchored container is cleared and rebuilt in place, so it costs no
	 * scrollback rows — the same reason the ctrl+p role-cycle track lives there.
	 */
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

	/**
	 * Preview the queued panels above the editor so a command answers straight
	 * away, then clear at settle when the real panels enter the transcript.
	 *
	 * Height is capped against the viewport: a `/usage` report with several
	 * providers is tall enough to push the prompt off screen, and the full text
	 * is a moment away in the transcript either way.
	 */
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

	/** Mount every command panel queued for the current session while the agent was streaming. */
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

	/** Build a session context in bounded chunks so terminal input runs between event-loop turns. */
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

	// Command handling
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
		this.#btwController.dispose();
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
		this.#btwController.dispose();
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

	// Selector handling
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
		// Flush pending settings writes *before* disposing controllers or resetting
		// observers: a save failure must leave the session, process project dir,
		// and Settings in the source scope with all UI intact.
		try {
			await this.settings.flush();
		} catch (err) {
			this.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#btwController.dispose();
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

	// Input handling
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
		// Preserve Ctrl+L's immediate full replay when the probe is unsupported,
		// receives no response, or reports an unchanged appearance.
		this.ui.resetDisplay();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(work: string): Promise<void> {
		return this.#tanCommandController.start(work);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	canBranchBtw(): boolean {
		return this.#btwController.canBranch();
	}

	/** Reserves plain `b` only after /btw has a completed branch action to handle. */
	handlesBtwBranchKey(): boolean {
		return this.#btwController.handlesBranchKey();
	}

	handleBtwBranchKey(): Promise<boolean> {
		return this.#btwController.handleBranch();
	}

	canCopyBtw(): boolean {
		return this.#btwController.canCopy();
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	async handleBtwBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage, leafId, sessionId);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			await this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /btw to ${path.basename(result.sessionFile)}` : "Branched /btw",
			);
		} catch (error) {
			this.showError(`Cannot branch /btw: ${error instanceof Error ? error.message : String(error)}`);
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

	// Hook UI methods
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

	/**
	 * Subscribe the session-scoped UI reactions (welcome-model resync, goal
	 * events, slash-command metadata) to the CURRENT main session. Called at
	 * init and again after every wholesale swap (attachSessionView): these
	 * subscriptions bind to a specific AgentSession instance, so a swapped-in
	 * instance needs its own.
	 */
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
