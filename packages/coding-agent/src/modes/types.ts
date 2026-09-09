import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@oh-my-pi/pi-ai";
import type { Component, Container, EditorTheme, Loader, Spacer, Text, TUI } from "@oh-my-pi/pi-tui";
import type { ConductorActivity } from "../conductor/runtime";
import type { KeybindingsManager } from "../config/keybindings";
import type { Settings } from "../config/settings";
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
import type { MCPManager } from "../mcp";
import type { AgentSession } from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import type { ForeignSessionSource } from "../session/foreign-session-store";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CustomEditor } from "./components/custom-editor";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorOptions } from "./components/hook-selector";
import type { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import type { TranscriptContainer } from "./components/transcript-container";
import type { EventController } from "./controllers/event-controller";
import type { LoopLimitRuntime } from "./loop-limit";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { Theme } from "./theme/theme";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

export type SubmittedUserInput = {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	customType?: string;

	synthetic?: boolean;

	userInitiated?: boolean;
	display?: boolean;

	streamingBehavior?: "steer" | "followUp";
	cancelled: boolean;
	started: boolean;
};

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export type TodoItem = {
	content: string;
	status: TodoStatus;
	details?: string;
	notes?: string[];
};

export type TodoPhase = {
	name: string;
	tasks: TodoItem[];
};

export interface InteractiveModeInitOptions {
	clearInitialTerminalHistory?: boolean;
}

export type InteractiveSelectorDialogOptions = ExtensionUIDialogOptions & Pick<HookSelectorOptions, "disabledIndices">;

export interface RenderSessionContextOptions {
	updateFooter?: boolean;
	reuseSettledComponents?: boolean;

	preservedLiveToolCallIds?: ReadonlySet<string>;
}

export type SideCommandMode = "question" | "agent";

export interface InteractiveModeContext {
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
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;
	syncEditorSpelling(): void;

	session: AgentSession;
	sessionManager: SessionManager;

	readonly sessionName: string | undefined;

	readonly viewSession: AgentSession;

	readonly focusedAgentId: string | undefined;

	focusAgentSession(id: string): Promise<void>;

	attachSessionView(target: AgentSession): Promise<void>;

	focusParentSession(): Promise<void>;

	unfocusSession(): Promise<void>;

	clearTransientSessionUi(): void;
	settings: Settings;
	keybindings: KeybindingsManager;
	/** Streams one conductor run into the HUD/fleet displays; `undefined` clears. Backs `conductor_activity`. */
	syncConductorDisplay(activity: ConductorActivity | undefined): void;

	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;

	eventController: EventController;
	eventBus?: EventBus;

	isInitialized: boolean;

	initialChatRendered: boolean;
	isBashMode: boolean;
	toolOutputExpanded: boolean;
	hideToolActivity: boolean;
	todoExpanded: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	loopModeEnabled: boolean;
	loopModePaused: boolean;
	loopPrompt?: string;
	loopLimit?: LoopLimitRuntime;
	hideThinkingBlock: boolean;

	readonly effectiveHideThinkingBlock: boolean;

	readonly hasDisplayableThinkingContent: boolean;

	noteDisplayableThinkingContent(message: AgentMessage): boolean;
	proseOnlyThinking: boolean;
	compactionQueuedMessages: CompactionQueuedMessage[];

	transcriptMessageComponents: WeakMap<AgentMessage, Component>;
	pendingTools: Map<string, ToolExecutionHandle>;
	pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	pendingPythonComponents: EvalExecutionComponent[];
	pythonComponent: EvalExecutionComponent | undefined;
	isPythonMode: boolean;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;

	lastAssistantUsage: Usage | undefined;
	loadingAnimation: Loader | undefined;
	autoCompactionLoader: Loader | undefined;
	retryLoader: Loader | undefined;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined;
	locallySubmittedUserSignatures: Set<string>;
	lastSigintTime: number;
	lastEscapeTime: number;

	mcpTestEscapeHandlers: Set<() => void>;
	lastLeftTapTime: number;
	lastRightTapTime: number;
	shutdownRequested: boolean;

	readonly isShuttingDown: boolean;
	hookSelector: HookSelectorComponent | undefined;
	hookInput: HookInputComponent | undefined;
	hookEditor: HookEditorComponent | undefined;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, Skill>;
	oauthManualInput: OAuthManualInputManager;
	todoPhases: TodoPhase[];

	init(options?: InteractiveModeInitOptions): Promise<void>;
	shutdown(): Promise<void>;
	checkShutdownRequested(): Promise<void>;

	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void;

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	present(content: Component | readonly Component[]): void;

	presentCommandOutput(content: Component | readonly Component[]): void;

	flushPendingCommandOutput(): void;

	resetTranscript(): void;
	showStatus(message: string, options?: { dim?: boolean }): void;
	showModelCycleTrack(track: string): void;
	showError(message: string): void;
	showPinnedError(message: string): void;
	clearPinnedError(): void;
	showWarning(message: string, options?: { hideWithToolActivity?: boolean }): void;
	showNewVersionNotification(newVersion: string): void;
	clearEditor(): void;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	setWorkingMessage(message?: string): void;
	applyPendingWorkingMessage(): void;
	ensureLoadingAnimation(): void;
	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput;
	cancelPendingSubmission(): boolean;
	markPendingSubmissionStarted(input: SubmittedUserInput): boolean;
	finishPendingSubmission(input: SubmittedUserInput): void;

	recordLocalSubmission(text: string, imageCount?: number): () => void;

	withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T>;

	clearOptimisticUserMessage(): void;

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void;

	optimisticSkillMessagePending: boolean;

	renderOptimisticSkillMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void;

	reconcileOptimisticSkillMessage(message: AgentMessage): void;

	clearOptimisticSkillMessage(): void;
	isKnownSlashCommand(text: string): boolean;
	addMessageToChat(
		message: AgentMessage,
		options?: {
			imageLinks?: readonly (string | undefined)[];
			reuseSettledComponent?: boolean;
		},
	): Component[];
	renderSessionContext(sessionContext: SessionContext, options?: RenderSessionContextOptions): void;

	renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void>;
	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): Promise<void>;
	navigateTranscriptHistory(direction: "older" | "newer" | "latest"): Promise<void>;
	ensureLatestTranscriptWindow(): Promise<void>;

	truncateTranscriptFromMessage(message: AgentMessage): boolean;
	getUserMessageText(message: Message): string;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;

	syncRunningSubagentBadge(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(options?: { reuseSettledComponents?: boolean }): void;
	setTodos(todos: TodoItem[] | TodoPhase[]): void;
	reloadTodos(): Promise<void>;
	toggleTodoExpansion(): void;

	handleTodoCommand(args: string): Promise<void>;
	handleAdvisorStatusCommand(): Promise<void>;
	handleJobsCommand(): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleHotkeysCommand(): void;
	handleToolsCommand(): void;
	handleContextCommand(): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleResetContextCommand(): Promise<void>;
	handleForkCommand(): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
	): Promise<CompactionOutcome>;
	handleMoveCommand(targetPath?: string): Promise<void>;
	handleRenameCommand(title: string): Promise<void>;
	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;

	refreshSkillState(): Promise<void>;
	applyCwdChange(newCwd: string): Promise<void>;

	showSettingsSelector(): void;
	showAdvisorConfigure(): void;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsView(scope?: "current" | "global"): Promise<void>;
	showTrajectoryView(): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showPluginSelector(mode?: "install" | "uninstall"): void;
	showUserMessageSelector(): void;
	showCopySelector(): void;
	showTreeSelector(): void;
	showSessionSelector(source?: ForeignSessionSource): void;
	handleResumeSession(sessionPath: string): Promise<void>;
	handleSessionDeleteCommand(): Promise<void>;
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void>;
	showResetUsageSelector(): Promise<void>;
	showProviderSetup(): Promise<void>;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showAgentFleet(options?: { requireContent?: boolean; armCloseTap?: boolean }): void;
	resetObserverRegistry(): void;

	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;

	resetDisplayAfterAppearanceRefresh(): void;
	handleDequeue(): void;
	handleImagePaste(): Promise<boolean>;

	handleQueueCommand(message: string): Promise<void>;
	handleSideCommand(mode: SideCommandMode, text: string): Promise<void>;
	hasActiveSideQuestion(): boolean;
	handleSideQuestionEscape(): boolean;
	handleSideQuestionBranchKey(): Promise<boolean>;
	canBranchSideQuestion(): boolean;
	handlesSideQuestionBranchKey(): boolean;
	canCopySideQuestion(): boolean;
	handleSideQuestionCopyKey(): Promise<boolean>;
	handleSideQuestionBranch(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<void>;
	cycleThinkingLevel(): void;
	cycleRoleModel(direction?: "forward" | "backward"): Promise<void>;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleThinkingBlockVisibility(): void;
	handleGoalModeCommand(rest?: string, input?: Pick<SubmittedUserInput, "images" | "imageLinks">): Promise<boolean>;
	handleConductCommission(ask: string, input?: Pick<SubmittedUserInput, "images" | "imageLinks">): Promise<boolean>;
	handleLoopCommand(args?: string): Promise<string | undefined>;
	setLoopPrompt(prompt: string): void;
	disableLoopMode(): void;
	pauseLoop(): void;

	initHooksAndCustomTools(): Promise<void>;

	getToolUIContext(): ExtensionUIContext | undefined;
	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void>;
	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setHookStatus(key: string, text: string | undefined): void;
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<string | undefined>;
	hideHookSelector(): void;
	showHookInput(title: string, placeholder?: string): Promise<string | undefined>;
	hideHookInput(): void;
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
	hideHookEditor(): void;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: ExtensionCustomOptions,
	): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}
