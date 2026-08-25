/**
 * Full-screen unified session + subagent browser (the `/session` and `/agents`
 * surface). Ported from prime-agent's agents-view-mode.ts onto proto data:
 *
 * - Splash header reuses the proto brand wordmark/hero meta and adds view
 *   metadata rows (agent counts, scope, depth, cwd).
 * - One inline editor doubles as live search filter, reply composer, and
 *   rename input, with mode-specific placeholders.
 * - Rows render Running / Idle / Current / Inactive sections over the unified
 *   records from agents-view-state.ts, windowed around the selection.
 * - A 1s single-flight poll refreshes registry + sessions while visible;
 *   renders are driven by actual data changes.
 */
import * as fs from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Editor,
	matchesKey,
	type OverlayHandle,
	routeSgrMouseInput,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { Keybinding, KeyId } from "../../../config/keybindings";
import type { MessageRenderer } from "../../../extensibility/extensions/types";
import { AgentLifecycleManager } from "../../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, getAgentTombstonePath } from "../../../registry/agent-registry";
import { readAgentSpawnTask, registerPersistedSubagents } from "../../../registry/persisted-agents";
import { detachedSessionHolder } from "../../../session/detached-session-holder";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { listSessions, readLastAssistantText, type SessionInfo } from "../../../session/session-listing";
import { SessionManager } from "../../../session/session-manager";
import { FileSessionStorage } from "../../../session/session-storage";
import { recordSessionTitle } from "../../../session/title-index";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	lookupBuiltinSlashCommand,
} from "../../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../../slash-commands/helpers/parse";
import { shortenPath } from "../../../tools/render-utils";
import { getEditorTheme, getSymbolTheme, theme } from "../../theme/theme";
import type { InteractiveModeContext } from "../../types";
import { matchesSelectDown, matchesSelectUp } from "../../utils/keybinding-matchers";
import { AgentTranscriptViewer } from "../agent-transcript-viewer";
import { heroWordmark } from "../welcome";
import {
	type AgentsViewIndex,
	type AgentsViewPersistentState,
	type AgentsViewRecord,
	type AgentsViewRow,
	type AgentsViewScopeFrame,
	type AgentsViewSection,
	buildAgentsViewIndex,
	buildAgentsViewRows,
	countAgentsBySection,
	extractLastAssistantText,
	filterAgentsViewRecords,
	formatRelativeAge,
	getRecordModelLabel,
	getRecordSessionFile,
	getRecordTitle,
	hasExplicitTitle,
	reconcileAgentsViewRecords,
	resolveAgentsViewScopeFrames,
	resolveAgentsViewSelectionIndex,
	scopeToRecordSubtree,
	sectionTitle,
} from "./agents-view-state";
import { matchSearchText, type ParsedSearchQuery, parseSearchQuery } from "./session-view-search";

const POLL_INTERVAL_MS = 1000;
const DELETE_CONFIRM_DURATION_MS = 2000;
const STATUS_MESSAGE_DURATION_MS = 4500;
const ANIMATION_INTERVAL_MS = 120;

const SEARCH_PROMPT_PLACEHOLDER = "Search sessions";

// Row-targeted commands the armed composer maps onto our rename/delete
// primitives; everything else builtin-shaped is rejected with a pointer to the
// session itself. Unlike prime we do not forward session-owned slash commands
// (/compact et al) as prompt text: our session.prompt would send them literally.
const AGENTS_VIEW_COMMAND_NAMES = ["name", "kill"] as const;
type AgentsViewCommandName = (typeof AGENTS_VIEW_COMMAND_NAMES)[number];
const AGENTS_VIEW_COMMAND_NAME_LOOKUP: Record<string, true> = { name: true, kill: true };

export interface AgentsViewCommand {
	name: AgentsViewCommandName;
	args: string;
}

/** Canonicalize an alias to its builtin name so /name-style aliases match. */
function resolveBuiltinSlashCommandName(name: string): string {
	return lookupBuiltinSlashCommand(name)?.name ?? name;
}

export function parseAgentsViewCommand(text: string): AgentsViewCommand | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	if (!AGENTS_VIEW_COMMAND_NAME_LOOKUP[name]) return undefined;
	return { name: name as AgentsViewCommandName, args: parsed.args };
}

/**
 * Reject recognized built-ins that are neither view commands nor runnable
 * here, so they are never sent to the model as plain prompt text.
 */
export function getReplyComposerCommandRejection(text: string): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	if (AGENTS_VIEW_COMMAND_NAME_LOOKUP[resolveBuiltinSlashCommandName(parsed.name)]) return undefined;
	if (!BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(parsed.name)) return undefined;
	return `/${parsed.name} is not available here; open the session to run it`;
}

/** First non-empty line of the latest response, for the composer header. */
function createAgentsViewReplyHeadline(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map(line => line.replace(/\s+/g, " ").trim())
		.find(line => line.length > 0);
}

const REPLY_PROMPT_PLACEHOLDER = "Write a reply to this agent";
const RESUME_PROMPT_PLACEHOLDER = "Write a prompt to resume this session";
const RENAME_PROMPT_PLACEHOLDER = "Name this agent session";

const IDLE_ROW_ICON = "●";
const CURRENT_ROW_ICON = "◆";
const INACTIVE_ROW_ICON = "✓";

const KEY_ARROWS: Record<string, string> = { up: "\u2191", down: "\u2193", left: "\u2190", right: "\u2192" };

/** Display label for one binding, mirroring prime's keyText casing rules. */
function formatViewKey(key: string): string {
	return key
		.split("+")
		.map(part => {
			const normalized = part === "escape" ? "esc" : part;
			return KEY_ARROWS[normalized] ?? normalized.charAt(0).toUpperCase() + normalized.slice(1);
		})
		.join("+");
}

const SELECTED_ROW_MARKER = "\0agents-view-selected-row\0";
const CODE_ROW_MARKER = "\0agents-view-code-row\0";

type ViewMode = "browse" | "reply" | "rename";

interface ReplyTarget {
	identity: string;
	/** Registry id when the target is a live/parked agent. */
	refId?: string;
	/** Transcript path when the target resolves through a session file. */
	sessionPath?: string;
	isInactive: boolean;
}

interface RenameTarget {
	sessionPath: string;
	isCurrentSession: boolean;
	currentName: string;
}

/** Controller-provided actions; keeps this component decoupled from the full context. */
export interface AgentsViewActions {
	close: () => void;
	openSession: (sessionPath: string) => Promise<boolean>;
	focusAgent: (id: string) => Promise<void>;
	newSession: () => void;
	renameCurrentSession: (name: string) => Promise<void>;
	deleteCurrentSession: () => Promise<void>;
	promptAfterResume: (text: string) => Promise<void>;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
}

export interface AgentsViewDeps extends AgentsViewActions {
	ui: TUI;
	keybindings: Pick<InteractiveModeContext["keybindings"], "getKeys">;
	/** Current main-session transcript file, used to seed persisted subagents. */
	currentSessionFile: string | null;
	cwd: string;
	version: string;
	modelName: string | undefined;
	providerName: string | undefined;
	requestRender: () => void;
	getTool?: (name: string) => AgentTool | undefined;
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys?: KeyId[];
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Open rooted at this record's subtree (/agents scoped at a subtree). */
	initialScopeIdentity?: string;
	initialScopeTitle?: string;
	/**
	 * View state shared across open/close within one process. The controller
	 * owns the instance; omitted (tests, standalone use) starts fresh.
	 */
	persistentState?: AgentsViewPersistentState;
	/** Strip every subagent row (summaries, children, code blocks): flat
	 *  session-switcher flavor opened by the double-← gesture. */
	hideSubagents?: boolean;
}

interface StatusMessage {
	text: string;
	tone: "muted" | "error" | "warning";
	expiresAt?: number;
}

export class AgentsViewComponent implements Component {
	#deps: AgentsViewDeps;
	#registry: AgentRegistry;
	#disposed = false;
	#editor: Editor;
	#records: AgentsViewRecord[] = [];
	#index: AgentsViewIndex = { byKey: new Map(), childrenByParent: new Map() };
	#rows: AgentsViewRow[] = [];
	#selectedIndex = 0;
	#selectedIdentity: string | undefined;

	#scopeFrames: AgentsViewScopeFrame[] = [];
	/** Mounted with a per-invocation scope (/agents) — not user navigation. */
	#scopedAtMount = false;
	/** Scope frames carried in persistent state when this instance mounted. */
	#carriedScopeFrames: AgentsViewScopeFrame[] | undefined;
	#expandedParents = new Set<string>();
	#programShownParents = new Set<string>();
	#spawnTasks = new Map<string, string>();

	#viewMode: ViewMode = "browse";
	#query = "";
	#parsedQuery: ParsedSearchQuery = parseSearchQuery("");
	#savedQuery = "";
	#replyTarget: ReplyTarget | undefined;
	#replyHeadline: string | undefined;
	#replyHeadlineLoading = false;
	#renameTarget: RenameTarget | undefined;
	#pendingDelete: { identity: string; timer: NodeJS.Timeout } | undefined;

	#statusMessage: StatusMessage | undefined;
	#statusTimer: NodeJS.Timeout | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#animationTimer: NodeJS.Timeout | undefined;
	#animationFrame = 0;
	#refreshInFlight = false;
	#lastSignature = "";
	/** Transcript dirs already scanned for persisted subagents. */
	#persistSeededPaths = new Set<string>();
	/** Nested child transcripts recovered while seeding; merged into the catalog. */
	#persistedChildSessions: SessionInfo[] = [];
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;
	/** Shared view state carried across close/reopen; owned by the controller. */
	#persistentState: AgentsViewPersistentState | undefined;

	constructor(deps: AgentsViewDeps) {
		this.#deps = deps;
		this.#registry = deps.registry ?? AgentRegistry.global();
		// Prime-parity composer styling, scoped to this view: reverse-video block
		// cursor and a panel-tinted placeholder (fg #71717A on bg #1A1A1F).
		const editorTheme = { ...getEditorTheme(), symbols: { ...getSymbolTheme(), inputCursor: "" } };
		editorTheme.hintStyle = text => text;
		this.#editor = new Editor(editorTheme);
		this.#editor.cursorOverride = "\x1b[7m \x1b[0m";
		this.#editor.cursorOverrideWidth = 1;
		this.#editor.setPromptGutter("> ");
		this.#editor.setMaxHeight(1);
		this.#editor.setPlaceholder(this.#styledPlaceholder(SEARCH_PROMPT_PLACEHOLDER));
		this.#editor.onChange = text => this.#queryChanged(text);
		this.#editor.onSubmit = text => {
			if (this.#viewMode === "rename") void this.#confirmRename(text);
			else void this.#submitComposer(text);
		};
		this.#editor.onAltEnter = text => void this.#submitComposer(text, "followUp");
		// Restore persistent view state (prime parity): scope frames, selection,
		// expansion sets — installed as shared instances so mutations persist —
		// and search text. An explicit initialScopeIdentity is a per-invocation
		// request (/agents at a subtree), so it overrides carried frames; prime's
		// initialScopeKey is static CLI context and wins there instead.
		const persistent = deps.persistentState;
		this.#persistentState = persistent;
		this.#carriedScopeFrames = persistent?.scopeFrames;
		if (deps.initialScopeIdentity) {
			// Per-invocation scope (/agents at a subtree): never seed the shared
			// persistent state with it — a later plain open must not restore it.
			this.#scopedAtMount = true;
			this.#scopeFrames = [{ identity: deps.initialScopeIdentity, rootTitle: deps.initialScopeTitle ?? "scoped" }];
		} else if (persistent?.scopeFrames) {
			this.#scopeFrames = persistent.scopeFrames;
			persistent.scopeFrames = this.#scopeFrames;
		}
		if (persistent) {
			this.#selectedIdentity = persistent.selectedRowIdentity;
			this.#expandedParents = persistent.expandedSubagentParents ?? new Set();
			persistent.expandedSubagentParents = this.#expandedParents;
			this.#programShownParents = persistent.programShownParents ?? new Set();
			persistent.programShownParents = this.#programShownParents;
			if (persistent.query) {
				this.#query = persistent.query;
				this.#parsedQuery = parseSearchQuery(persistent.query);
				this.#editor.setText(persistent.query);
			}
		}
		void this.refresh();
		this.#pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
		this.#pollTimer.unref?.();
		this.#animationTimer = setInterval(() => {
			if (!this.#rows.some(row => row.section === "running")) return;
			this.#animationFrame += 1;
			this.#deps.requestRender();
		}, ANIMATION_INTERVAL_MS);
		this.#animationTimer.unref?.();
	}

	/**
	 * Register on-disk subagent transcripts for every known parent session so
	 * children appear under their parents regardless of which session is
	 * attached. Each transcript directory is scanned once per view lifetime;
	 * the registry ignores already-known ids, so re-seeding is cheap.
	 */
	async #seedPersistedSubagents(sessionPaths: readonly string[]): Promise<void> {
		const pending = sessionPaths.filter(path => path.endsWith(".jsonl") && !this.#persistSeededPaths.has(path));
		if (pending.length === 0) return;
		for (const sessionPath of pending) this.#persistSeededPaths.add(sessionPath);
		try {
			const nested = await Promise.all(
				pending.map(async sessionPath => {
					const artifactsDir = sessionPath.slice(0, -".jsonl".length);
					try {
						return await listSessions(artifactsDir, new FileSessionStorage());
					} catch {
						return [] as SessionInfo[];
					}
				}),
			);
			// Accumulate across waves: later seeds may re-scan child transcripts
			// (their own artifacts dirs are empty), which must not wipe earlier
			// recoveries.
			const merged = new Map(this.#persistedChildSessions.map(info => [info.path, info]));
			for (const infos of nested) {
				for (const info of infos) merged.set(info.path, info);
			}
			this.#persistedChildSessions = [...merged.values()];
			await Promise.all(
				pending.map(sessionPath =>
					registerPersistedSubagents(this.#registry, sessionPath, {
						shouldContinue: () => !this.#disposed,
					}).catch(error => {
						logger.warn("Agents view: failed to register persisted subagents", { sessionPath, error });
					}),
				),
			);
		} finally {
			this.#lastSignature = "";
			await this.refresh();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		if (this.#animationTimer) clearInterval(this.#animationTimer);
		this.#clearPendingDelete();
		clearTimeout(this.#statusTimer);
		this.#statusMessage = undefined;
		if (this.#persistentState) {
			// A per-invocation /agents scope that the user never navigated is not
			// theirs — restore whatever the state carried at mount so a later
			// plain open doesn't land inside it. (#setScopeFrames write-through
			// during refresh normalization may have persisted it meanwhile.)
			const teleported = this.#scopedAtMount && this.#scopeFrames.length === 1;
			this.#persistentState.scopeFrames = teleported ? this.#carriedScopeFrames : this.#scopeFrames;
			this.#persistentState.selectedRowIdentity = this.#selectedIdentity;
			this.#persistentState.query = this.#query;
		}
		const viewer = this.#transcriptViewer;
		this.#closeTranscriptOverlay(viewer);
	}

	// ==========================================================================
	// Data refresh
	// ==========================================================================

	async refresh(): Promise<void> {
		if (this.#refreshInFlight || this.#disposed) return;
		this.#refreshInFlight = true;
		try {
			const listed = await SessionManager.listAll();
			if (this.#disposed) return;
			// Parked child transcripts are not part of the global listing; merge
			// the nested scans so refs enrich with titles/counts/status. The host
			// session stays in the list — the view pins it under a Current section.
			const sessions = [...listed, ...this.#persistedChildSessions];
			const refs = this.#registry.list().filter(ref => !this.#isHostRef(ref));
			const signature =
				refs.map(ref => `${ref.id}:${ref.status}:${ref.lastActivity}:${ref.activity ?? ""}`).join("|") +
				"#" +
				sessions
					.map(
						session =>
							`${session.path}:${session.modified.getTime()}:${session.messageCount}:${session.title ?? ""}`,
					)
					.join("|");
			if (signature === this.#lastSignature && this.#records.length > 0) return;
			this.#lastSignature = signature;
			this.#applyData(refs, sessions);
			void this.#seedPersistedSubagents(sessions.map(session => session.path));
			this.#deps.requestRender();
		} finally {
			this.#refreshInFlight = false;
		}
	}

	/** The overlay host's own chat never appears as a browsable row. */
	#isHostSessionPath(candidate: string): boolean {
		const current = this.#deps.currentSessionFile;
		return current !== null && pathResolve(candidate) === pathResolve(current);
	}

	#isHostRef(ref: AgentRef): boolean {
		if (ref.kind === "main") return true;
		return ref.sessionFile !== null && this.#isHostSessionPath(ref.sessionFile);
	}

	#applyData(refs: readonly AgentRef[], sessions: readonly SessionInfo[]): void {
		this.#records = reconcileAgentsViewRecords(refs, sessions);
		// The attached host session gets its own Current section regardless of
		// its live/persisted classification.
		const currentFile = this.#deps.currentSessionFile;
		if (currentFile !== null) {
			for (const record of this.#records) {
				const file = getRecordSessionFile(record);
				if (file !== undefined && isCurrentSessionFile(file, currentFile)) record.section = "current";
			}
		}
		this.#index = buildAgentsViewIndex(this.#records);
		this.#setScopeFrames(resolveAgentsViewScopeFrames(this.#scopeFrames, this.#index).frames);
		this.#rebuildRows();
	}

	#rebuildRows(): void {
		const scopedIdentity = this.#scopeFrames.at(-1)?.identity;
		let records = scopeToRecordSubtree(this.#records, scopedIdentity, this.#index);
		if (this.#parsedQuery.error !== undefined) {
			// A malformed query (bad regex) matches nothing but stays visible.
			records = [];
		} else if (this.#query.trim().length > 0) {
			records = filterAgentsViewRecords(
				records,
				text => matchSearchText(text, this.#parsedQuery).matches,
				this.#index,
			);
		}
		let rows = buildAgentsViewRows(
			records,
			this.#expandedParents,
			this.#programShownParents,
			this.#spawnTasks,
			scopedIdentity,
		);
		if (this.#deps.hideSubagents) {
			// Flat session-switcher flavor: only top-level Inactive (persisted)
			// and Current rows survive — Running/Idle are live-roster concepts and
			// and message-less sessions carry no resume value here, so they go too.
			rows = rows.filter(row => {
				if (row.kind !== "agent" || (row.section !== "inactive" && row.section !== "current")) return false;
				const record = row.record;
				if (!record) return false;
				if (record.ref?.kind === "advisor") return false;
				if (record.session?.path.endsWith("__advisor.jsonl")) return false;
				if (getRecordTitle(record) === "(no messages)") return false;
				const session = record.session;
				if (session && !session.title?.trim() && !session.firstMessage.trim()) return false;
				return true;
			});
		}
		this.#rows = rows;
		this.#selectedIndex = resolveAgentsViewSelectionIndex(this.#rows, this.#selectedIdentity, this.#selectedIndex);
		this.#setSelectedIdentity(this.#rows[this.#selectedIndex]?.identity);
		this.#loadSpawnTasksForExpandedRows();
	}

	/** Lazily recover spawn-task text for expanded parents; cached per transcript. */
	#loadSpawnTasksForExpandedRows(): void {
		for (const row of this.#rows) {
			if (row.kind !== "subagent-summary" || !row.expanded || row.hasSpawnTask !== true) continue;
			if (row.parentIdentity === undefined) continue;
			for (const child of this.#childRowsOf(row.parentIdentity)) {
				const file = child.record ? getRecordSessionFile(child.record) : undefined;
				if (!file || this.#spawnTasks.has(file)) continue;
				this.#spawnTasks.set(file, "");
				void readAgentSpawnTask(file)
					.then(task => {
						if (task === undefined) this.#spawnTasks.delete(file);
						else this.#spawnTasks.set(file, task);
						this.#rebuildRows();
						this.#deps.requestRender();
					})
					.catch(() => this.#spawnTasks.delete(file));
			}
		}
	}

	#childRowsOf(parentIdentity: string): AgentsViewRow[] {
		return this.#rows.filter(row => row.parentIdentity === parentIdentity && row.kind === "subagent");
	}

	// ==========================================================================
	// Input
	// ==========================================================================

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (routeSgrMouseInput(data, () => true)) return;

		if (matchesKey(data, "escape")) {
			this.#handleEscape();
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.#deps.close();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			if (this.#viewMode !== "browse") this.#disarmComposer();
			else this.#deps.close();
			return;
		}
		if (this.#viewMode !== "browse") {
			// Reply/rename modes hand everything else to the composer editor;
			// Enter/Alt+Enter arrive through its onSubmit/onAltEnter hooks.
			this.#editor.handleInput(data);
			return;
		}
		this.#handleBrowseInput(data);
	}

	#handleBrowseInput(data: string): void {
		if (matchesSelectDown(data) || matchesKey(data, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.#moveSelection(this.#visibleListRows());
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.#moveSelection(-this.#visibleListRows());
			return;
		}
		// Enter is the only open key: Right previously mirrored it but kept
		// firing while the user reached for other keys, so it now falls through
		// to the search editor's cursor handling. Left still pops an active
		// scope frame.
		if (matchesKey(data, "enter")) {
			this.#openSelected();
			return;
		}
		if (matchesKey(data, "left")) {
			this.#drillOut();
			return;
		}
		if (data === " ") {
			this.#toggleReplyTarget();
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.#deps.close();
			this.#deps.newSession();
			return;
		}
		if (matchesKey(data, "ctrl+r") && this.#query.length === 0) {
			this.#enterRenameMode();
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.#handleDeleteRequested();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.#toggleProgram();
			return;
		}
		this.#editor.handleInput(data);
	}

	#handleEscape(): void {
		switch (this.#viewMode) {
			case "reply":
				this.#disarmComposer();
				return;
			case "rename":
				this.#exitRenameMode();
				return;
			case "browse":
				// Esc always returns to the main session — no query-clear or
				// drill-out intermediate screens. Left arrow still pops a scope.
				this.#deps.close();
				return;
		}
	}

	#moveSelection(delta: number): void {
		if (this.#rows.length === 0) return;
		let index = this.#selectedIndex;
		let remaining = Math.abs(delta);
		const step = delta >= 0 ? 1 : -1;
		while (remaining > 0) {
			index += step;
			if (index < 0 || index >= this.#rows.length) return;
			if (this.#rows[index]?.selectable) remaining--;
		}
		this.#selectedIndex = index;
		this.#setSelectedIdentity(this.#rows[index]?.identity);
		this.#deps.requestRender();
	}

	#openSelected(): void {
		const row = this.#rows[this.#selectedIndex];
		if (!row?.selectable) return;
		if (row.kind === "subagent-summary") {
			if (row.parentIdentity === undefined) return;
			const parentIdentity = row.parentIdentity;
			if (this.#expandedParents.has(parentIdentity)) this.#expandedParents.delete(parentIdentity);
			else this.#expandedParents.add(parentIdentity);
			this.#rebuildRows();
			this.#deps.requestRender();
			return;
		}
		// Enter opens/focuses the row's session; scope frames are entered via
		// Alt+A from inside a chat, never drilled in place. Left still pops an
		// active scope frame.
		if (row.kind === "subagent-code") return;
		this.#activateAgentRow(row);
	}

	#activateAgentRow(row: AgentsViewRow): void {
		const record = row.record;
		if (!record) return;
		const ref = record.ref;
		if (ref && ref.kind !== "advisor" && ref.status !== "aborted") {
			void (async () => {
				try {
					// ensureLive inside revives parked agents — same as fleet Enter.
					await this.#deps.focusAgent(ref.id);
					this.#closeForChat();
				} catch (error) {
					this.#setStatusMessage(error instanceof Error ? error.message : String(error), "error");
					this.#deps.requestRender();
				}
			})();
			return;
		}
		if (ref) {
			// Aborted/advisor refs have no revivable session: read-only transcript.
			this.#openTranscriptViewer(ref.id);
			return;
		}
		const sessionPath = record.session?.path;
		if (!sessionPath) return;
		this.#closeForChat();
		// Activating the host's own row just returns to its chat — resuming the
		// attached transcript would needlessly reload the live session.
		if (isCurrentSessionFile(sessionPath, this.#deps.currentSessionFile)) return;
		void this.#deps.openSession(sessionPath);
	}

	#drillOut(): void {
		if (this.#scopeFrames.length === 0) return;
		const frames = this.#scopeFrames.slice(0, -1);
		if (frames.length === 0 && !this.#deps.hideSubagents) {
			// Popping the last frame of a "current"-scoped view would expose the
			// removed global hierarchical browser — close back to the chat.
			this.#deps.close();
			return;
		}
		this.#setScopeFrames(frames);
		this.#rebuildRows();
		this.#deps.requestRender();
	}

	/** Frames changed: mirror into the controller-owned persistent state. */
	#setScopeFrames(frames: AgentsViewScopeFrame[]): void {
		this.#scopeFrames = frames;
		if (this.#persistentState) this.#persistentState.scopeFrames = frames;
	}

	#setSelectedIdentity(identity: string | undefined): void {
		this.#selectedIdentity = identity;
		if (this.#persistentState) this.#persistentState.selectedRowIdentity = identity;
	}

	/**
	 * Close because a chat is being opened. Prime clears the search text on
	 * chat round-trips while keeping selection and scope frames; ours does the
	 * same against the persistent state the next mount will restore.
	 */
	#closeForChat(): void {
		this.#query = "";
		this.#parsedQuery = parseSearchQuery("");
		if (this.#persistentState) this.#persistentState.query = "";
		this.#deps.close();
	}

	#programTargetIdentity(): string | undefined {
		const row = this.#rows[this.#selectedIndex];
		if (!row) return undefined;
		if (row.kind === "agent" || row.kind === "subagent") return row.identity;
		return row.kind === "subagent-summary" ? row.parentIdentity : undefined;
	}

	#toggleProgram(): void {
		const target = this.#programTargetIdentity();
		if (!target) return;
		if (this.#childRowsOf(target).length === 0 && !this.#programShownParents.has(target)) return;
		if (this.#programShownParents.has(target)) this.#programShownParents.delete(target);
		else this.#programShownParents.add(target);
		this.#deps.requestRender();
	}

	// ==========================================================================
	// Reply composer
	// ==========================================================================

	#toggleReplyTarget(): void {
		const row = this.#rows[this.#selectedIndex];
		if (row?.kind !== "agent" || !row.selectable || !row.record) return;
		if (this.#pendingDelete?.identity === row.identity) return;
		const record = row.record;
		const ref = record.ref;
		const sessionPath = record.session?.path ?? ref?.sessionFile ?? undefined;
		if (!ref && !sessionPath) return;
		const identity = row.identity;
		if (this.#replyTarget?.identity === identity) {
			this.#disarmComposer();
			return;
		}
		this.#enterComposer({
			identity,
			...(ref ? { refId: ref.id } : {}),
			...(sessionPath ? { sessionPath } : {}),
			isInactive: record.section === "inactive",
		});
	}

	#enterComposer(target: ReplyTarget): void {
		if (this.#viewMode === "browse") {
			this.#savedQuery = this.#query;
			this.#setQuery("", { render: false });
		}
		if (this.#viewMode === "rename") this.#exitRenameMode();
		this.#viewMode = "reply";
		this.#replyTarget = target;
		const liveSession = target.refId ? (this.#registry.get(target.refId)?.session ?? null) : null;
		if (liveSession) {
			// Live transcript: the latest assistant response reads from memory.
			this.#replyHeadline = createAgentsViewReplyHeadline(extractLastAssistantText(liveSession.messages));
			this.#replyHeadlineLoading = false;
		} else {
			// Prime seeds inactive targets with the persisted recap before the
			// tail read refines it to the actual last assistant response.
			const fallback = this.#replyTargetRecord(target)?.session?.firstMessage;
			this.#replyHeadline =
				fallback && fallback !== "(no messages)" ? createAgentsViewReplyHeadline(fallback) : undefined;
			this.#replyHeadlineLoading = Boolean(target.sessionPath);
		}
		this.#editor.setPlaceholder(
			this.#styledPlaceholder(target.isInactive ? RESUME_PROMPT_PLACEHOLDER : REPLY_PROMPT_PLACEHOLDER),
		);
		this.#editor.setText("");
		const sessionPath = target.sessionPath;
		if (!liveSession && sessionPath) {
			// Persisted transcript: read only a bounded tail, never whole file.
			void readLastAssistantText(sessionPath)
				.then(text => {
					if (this.#disposed || this.#replyTarget !== target) return;
					this.#replyHeadline = createAgentsViewReplyHeadline(text) ?? this.#replyHeadline;
					this.#replyHeadlineLoading = false;
					this.#deps.requestRender();
				})
				.catch(() => {
					if (this.#replyTarget === target) this.#replyHeadlineLoading = false;
				});
		}
		this.#deps.requestRender();
	}

	#replyTargetRecord(target: ReplyTarget): AgentsViewRecord | undefined {
		return this.#records.find(candidate =>
			target.sessionPath ? candidate.session?.path === target.sessionPath : candidate.identity === target.identity,
		);
	}

	#disarmComposer(): void {
		if (this.#viewMode !== "reply") return;
		this.#viewMode = "browse";
		this.#replyTarget = undefined;
		this.#replyHeadline = undefined;
		this.#replyHeadlineLoading = false;
		this.#editor.setPlaceholder(this.#styledPlaceholder(SEARCH_PROMPT_PLACEHOLDER));
		this.#editor.setText("");
		this.#setQuery(this.#savedQuery, { render: false });
		this.#savedQuery = "";
		this.#rebuildRows();
		this.#deps.requestRender();
	}

	async #submitComposer(text: string, delivery: "steer" | "followUp" = "steer"): Promise<void> {
		const trimmed = text.trim();
		this.#editor.setText("");
		if (!trimmed) return;
		const target = this.#replyTarget;
		if (!target) return;
		const viewCommand = parseAgentsViewCommand(trimmed);
		if (viewCommand) {
			// Stale rows mis-route the primitives after a refresh; resolve late.
			// Success or failure, the buffer stays cleared and the primitive's
			// own status/disarm handling is the only residue (reference parity).
			await this.#runAgentsViewCommand(viewCommand, target);
			return;
		}
		const rejection = getReplyComposerCommandRejection(trimmed);
		if (rejection) {
			// Every submit branch ends clean: buffer stays empty and the reason
			// surfaces immediately as a warning toast (reference parity).
			this.#setStatusMessage(rejection, "warning");
			this.#deps.requestRender();
			return;
		}
		if (target.refId) {
			const refId = target.refId;
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await AgentLifecycleManager.global().ensureLive(refId);
				// Steers a mid-turn agent; prompts an idle one; queues on followUp.
				await session.prompt(trimmed, { streamingBehavior: delivery });
				this.#setStatusMessage(delivery === "followUp" ? "Reply queued" : "Reply sent", "muted");
			} catch (error) {
				this.#setStatusMessage(error instanceof Error ? error.message : String(error), "error");
			}
			this.#deps.requestRender();
			return;
		}
		if (target.sessionPath) {
			const sessionPath = target.sessionPath;
			this.#closeForChat();
			// Replying to the host's own Current row steers the live session —
			// resuming the attached transcript would route through
			// switchSession's abort path and kill its in-flight turn (same guard
			// as #activateAgentRow).
			if (!isCurrentSessionFile(sessionPath, this.#deps.currentSessionFile)) {
				const resumed = await this.#deps.openSession(sessionPath);
				if (!resumed) return;
			}
			await this.#deps.promptAfterResume(trimmed);
		}
	}

	/** Map an armed-composer /name or /kill onto our row-targeted primitives. */
	async #runAgentsViewCommand(command: AgentsViewCommand, target: ReplyTarget): Promise<boolean> {
		const armedAtStart = this.#replyTarget;
		const disarmIfUnchanged = () => {
			if (armedAtStart && this.#replyTarget === armedAtStart) this.#disarmComposer();
		};
		try {
			switch (command.name) {
				case "name": {
					const name = command.args.trim();
					if (!name) {
						this.#setStatusMessage("Usage: /name <session name>", "warning");
						return false;
					}
					const record = this.#replyTargetRecord(target);
					if (!record) return false;
					return await this.#renameAgentSession(record, name);
				}
				case "kill": {
					const record = this.#replyTargetRecord(target);
					if (!record) {
						this.#setStatusMessage("This session cannot be deleted", "warning");
						return false;
					}
					await this.#executeDelete(record);
					disarmIfUnchanged();
					return true;
				}
			}
		} catch (error) {
			this.#setStatusMessage(
				`Failed to run /${command.name}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
		return false;
	}

	// ==========================================================================
	// Rename
	// ==========================================================================

	#enterRenameMode(): void {
		const row = this.#rows[this.#selectedIndex];
		if (row?.kind !== "agent" || !row.selectable || !row.record) return;
		const record = row.record;
		const sessionPath = record.session?.path ?? record.ref?.sessionFile ?? undefined;
		if (!sessionPath) {
			this.#setStatusMessage("This session cannot be renamed", "warning");
			this.#deps.requestRender();
			return;
		}
		if (this.#viewMode === "reply") this.#disarmComposer();
		this.#viewMode = "rename";
		this.#renameTarget = {
			sessionPath,
			isCurrentSession: isCurrentSessionFile(sessionPath, this.#deps.currentSessionFile),
			currentName: getRecordTitle(record),
		};
		this.#editor.setPlaceholder(this.#styledPlaceholder(RENAME_PROMPT_PLACEHOLDER));
		this.#editor.setText(record.session?.title ?? "");
		this.#deps.requestRender();
	}

	#exitRenameMode(): void {
		if (this.#viewMode !== "rename") return;
		this.#viewMode = "browse";
		this.#renameTarget = undefined;
		this.#editor.setPlaceholder(this.#styledPlaceholder(SEARCH_PROMPT_PLACEHOLDER));
		this.#editor.setText("");
		this.#setQuery(this.#query, { render: false });
		this.#deps.requestRender();
	}

	async #confirmRename(value: string): Promise<void> {
		const target = this.#renameTarget;
		if (!target) return;
		this.#viewMode = "browse";
		this.#renameTarget = undefined;
		this.#editor.setPlaceholder(this.#styledPlaceholder(SEARCH_PROMPT_PLACEHOLDER));
		this.#editor.setText("");
		const name = value.trim();
		const identity = `file:${pathResolve(target.sessionPath)}`;
		const record = this.#records.find(candidate => candidate.identityAliases.includes(identity));
		if (!name || name === target.currentName || !record) {
			this.#deps.requestRender();
			return;
		}
		await this.#renameAgentSession(record, name);
	}

	/** Shared by rename mode and /name: rename via controller or storage, report. */
	async #renameAgentSession(record: AgentsViewRecord, name: string): Promise<boolean> {
		const sessionPath = record.session?.path ?? record.ref?.sessionFile ?? undefined;
		if (!sessionPath) {
			this.#setStatusMessage("This session cannot be renamed", "warning");
			this.#deps.requestRender();
			return false;
		}
		try {
			if (isCurrentSessionFile(sessionPath, this.#deps.currentSessionFile)) {
				await this.#deps.renameCurrentSession(name);
			} else {
				const storage = new FileSessionStorage();
				await storage.updateSessionTitle(sessionPath, {
					title: name,
					source: "user",
					updatedAt: new Date().toISOString(),
				});
				if (record.session?.id) recordSessionTitle(record.session.id, name);
			}
			this.#lastSignature = "";
			await this.refresh();
			// Reference parity: success surfaces as a timed in-view toast.
			this.#setStatusMessage(`Renamed to ${name}`, "muted");
			return true;
		} catch (error) {
			this.#deps.showError(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	// ==========================================================================
	// Delete
	// ==========================================================================

	#handleDeleteRequested(): void {
		const row = this.#rows[this.#selectedIndex];
		if (row?.kind !== "agent" || !row.record) return;
		const identity = row.identity;
		if (this.#pendingDelete?.identity === identity) {
			void this.#executeDelete(row.record);
			return;
		}
		this.#clearPendingDelete();
		const timer = setTimeout(() => {
			this.#pendingDelete = undefined;
			this.#deps.requestRender();
		}, DELETE_CONFIRM_DURATION_MS);
		timer.unref?.();
		this.#pendingDelete = { identity, timer };
		this.#deps.requestRender();
	}

	#clearPendingDelete(): void {
		if (!this.#pendingDelete) return;
		clearTimeout(this.#pendingDelete.timer);
		this.#pendingDelete = undefined;
	}

	async #executeDelete(record: AgentsViewRecord | undefined): Promise<void> {
		this.#clearPendingDelete();
		if (!record) {
			this.#setStatusMessage("This session cannot be deleted", "warning");
			this.#deps.requestRender();
			return;
		}
		const sessionPath = record.session?.path ?? record.ref?.sessionFile ?? undefined;
		const ref = record.ref;
		if (!sessionPath) {
			this.#setStatusMessage("This session cannot be deleted", "warning");
			this.#deps.requestRender();
			return;
		}
		if (isCurrentSessionFile(sessionPath, this.#deps.currentSessionFile)) {
			this.#deps.close();
			await this.#deps.deleteCurrentSession();
			return;
		}
		try {
			if (ref) {
				// Mirror the fleet's kill path: abort a running turn, then release.
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await AgentLifecycleManager.global().release(ref.id, ref);
				this.#registry.unregister(ref.id, ref);
			}
			// A parked live instance must not keep writing to a deleted file:
			// take the entry and await its abort so artifact deletion cannot
			// race further appends (which would resurrect the .jsonl).
			await detachedSessionHolder.stopAndRemove(sessionPath);
			const storage = new FileSessionStorage();
			await storage.deleteSessionWithArtifacts(sessionPath);
			await fs.rm(getAgentTombstonePath(sessionPath), { force: true }).catch(() => undefined);
			await this.refresh();
			this.#setStatusMessage("Deleted", "muted");
		} catch (error) {
			this.#setStatusMessage(`Delete failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		this.#deps.requestRender();
	}

	// ==========================================================================
	// Search
	// ==========================================================================

	#setQuery(query: string, options: { render?: boolean } = {}): void {
		this.#query = query;
		this.#parsedQuery = parseSearchQuery(query);
		this.#editor.setText(query);
		this.#rebuildRows();
		if (options.render !== false) this.#deps.requestRender();
	}

	#queryChanged(text: string): void {
		if (this.#viewMode !== "browse") return;
		if (text === this.#query) return;
		this.#query = text;
		this.#parsedQuery = parseSearchQuery(text);
		this.#rebuildRows();
		this.#deps.requestRender();
	}

	// ==========================================================================
	// Transcript viewer sub-overlay
	// ==========================================================================

	#openTranscriptViewer(agentId: string): void {
		if (this.#disposed || typeof this.#deps.ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay(this.#transcriptViewer);
		const viewer = new AgentTranscriptViewer({
			agentId,
			registry: this.#registry,
			lifecycle: () => AgentLifecycleManager.global(),
			ui: this.#deps.ui,
			getTool: this.#deps.getTool,
			isBuiltInTool: this.#deps.isBuiltInTool,
			getMessageRenderer: this.#deps.getMessageRenderer,
			cwd: this.#deps.cwd,
			hideThinkingBlock: this.#deps.hideThinkingBlock,
			proseOnlyThinking: this.#deps.proseOnlyThinking,
			expandKeys: this.#deps.expandKeys ?? ["ctrl+o"],
			fleetKeys: [],
			requestRender: this.#deps.requestRender,
			onClose: () => this.#closeTranscriptOverlay(viewer),
			onFleetClose: () => this.#closeTranscriptOverlay(viewer),
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#deps.ui.showOverlay(viewer, {
			width: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#deps.ui.setFocus(viewer);
		this.#deps.requestRender();
	}

	#closeTranscriptOverlay(expectedViewer: AgentTranscriptViewer | undefined): void {
		if (expectedViewer && this.#transcriptViewer !== expectedViewer) return;
		const overlay = this.#transcriptOverlay;
		const viewer = this.#transcriptViewer;
		if (!overlay && !viewer) return;
		overlay?.hide();
		viewer?.dispose();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer = undefined;
		if (!this.#disposed) {
			this.#deps.ui.setFocus(this);
			this.#deps.requestRender();
		}
	}

	// ==========================================================================
	// Status messages
	// ==========================================================================

	#setStatusMessage(text: string, tone: StatusMessage["tone"]): void {
		this.#statusMessage = {
			text: text.replace(/\s+/g, " ").trim(),
			tone,
			expiresAt: Date.now() + STATUS_MESSAGE_DURATION_MS,
		};
		// Expire the toast even without an intervening render trigger, so a
		// stale warning can never outlive its slot (reference parity).
		clearTimeout(this.#statusTimer);
		const timer = setTimeout(() => {
			if (this.#statusMessage?.expiresAt !== undefined && Date.now() >= this.#statusMessage.expiresAt) {
				this.#statusMessage = undefined;
				this.#deps.requestRender();
			}
		}, STATUS_MESSAGE_DURATION_MS);
		timer.unref?.();
		this.#statusTimer = timer;
		this.#deps.requestRender();
	}

	// ==========================================================================
	// Rendering
	// ==========================================================================

	/** Panel-tinted ghost styling for composer placeholders (prime parity). */
	#styledPlaceholder(text: string): string {
		return `\x1b[38;2;113;113;122;48;2;26;26;31m${text}\x1b[0m`;
	}

	/** Display label for a keybinding's primary keys, e.g. "Ctrl+N" / "\u2192". */
	#keyText(action: Keybinding): string {
		const keys = this.#deps.keybindings.getKeys(action);
		if (keys.length > 0) return keys.map(formatViewKey).join("/");
		// Prime-default labels for bindings that may be unregistered in
		// reduced contexts (tests, embedded hosts).
		const fallbacks: Partial<Record<Keybinding, string>> = {
			"tui.select.confirm": "Enter",
			"tui.select.cancel": "Esc/Ctrl+C",
			"tui.select.up": "\u2191",
			"tui.select.down": "\u2193",
			"app.message.followUp": "Ctrl+Q/Ctrl+Enter",
		};
		const fallback = fallbacks[action];
		return fallback === undefined ? "" : fallback;
	}

	render(width: number): readonly string[] {
		const height = this.#terminalRows();
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];

		const promptLines = [...this.#renderReplyHeaderLine(safeWidth), ...this.#editor.render(safeWidth)];
		const hintsLine = this.#renderHints(safeWidth);
		// Trim optional header chrome first on short viewports; always reserve
		// the editor and hints plus one list row.
		const reservedTail = promptLines.length + 3;
		const headerBudget = Math.max(0, height - reservedTail - 1);
		lines.push(...this.#renderHeader(safeWidth).slice(0, headerBudget));
		lines.push(...promptLines);
		lines.push("");

		const listRows = Math.max(0, height - lines.length - 1);
		lines.push(...this.#renderList(safeWidth, listRows));

		while (lines.length < height - 1) lines.push("");
		lines.push(hintsLine);
		return lines.slice(0, height).map(line => this.#finalizeLine(line, safeWidth));
	}

	#renderHeader(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const paddingX = safeWidth > 1 ? 1 : 0;
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const labelWidth = 9;
		const labelled = (label: string, value: string): string => {
			const displayValue = truncateToWidth(value, Math.max(1, contentWidth - labelWidth));
			return theme.fg("dim", label.padEnd(labelWidth)) + theme.fg("muted", displayValue);
		};
		const selected = this.#rows[this.#selectedIndex];
		const resolvedModel = selected?.record?.ref?.history?.resolvedModel;
		const modelId = resolvedModel ? resolvedModel.split("@")[0]?.split("/").pop() : this.#deps.modelName;
		const scopeRoot = this.#scopeFrames.at(-1);
		const counts = countAgentsBySection(this.#rows);
		const cwd = selected?.record?.session?.cwd ?? this.#deps.cwd;
		const metaLines = [
			labelled("version", `v${this.#deps.version}`),
			labelled("model", modelId ?? "\u2014"),
			labelled("cwd", shortenPath(cwd)),
			labelled(
				"agents",
				`${counts.running} running, ${counts.idle} idle, ${counts.current} current, ${counts.inactive} inactive`,
			),
			labelled("scope", scopeRoot ? scopeRoot.rootTitle : "global"),
			labelled("depth", String(this.#scopeFrames.length)),
			"",
			theme.fg("dim", "type to search sessions"),
		];

		// Brand art (proto's letter-spaced wordmark) with the metadata block
		// stacked beneath it in a shared label column.
		const lines: string[] = [""];
		lines.push(" ".repeat(paddingX) + truncateToWidth(heroWordmark(), contentWidth));
		lines.push("");
		for (const meta of metaLines) {
			lines.push(truncateToWidth(`${" ".repeat(paddingX)}${meta}`, safeWidth));
		}
		return lines;
	}

	#renderReplyHeaderLine(width: number): string[] {
		if (this.#viewMode === "rename") {
			return [theme.fg("warning", "Rename agent session")];
		}
		if (this.#viewMode !== "reply" || !this.#replyTarget) return [];
		const target = this.#replyTarget;
		const record = this.#records.find(candidate =>
			target.sessionPath ? candidate.session?.path === target.sessionPath : candidate.identity === target.identity,
		);
		const ageValue = record
			? formatRelativeAge(record.ref?.lastActivity ?? record.session?.modified.getTime() ?? Date.now())
			: "";
		const headline =
			this.#replyHeadline ??
			theme.fg("dim", this.#replyHeadlineLoading ? "Loading last response..." : "No response yet");
		const line = ageValue ? `${theme.fg("warning", ageValue)} ${headline}` : headline;
		return [truncateToWidth(line, width)];
	}

	#terminalRows(): number {
		return this.#deps.ui.terminal?.rows || process.stdout.rows || 40;
	}

	#visibleListRows(): number {
		return Math.max(4, this.#terminalRows() - 9);
	}

	#renderList(width: number, maxRows: number): string[] {
		if (maxRows <= 0) return [];
		if (this.#rows.length === 0) {
			const emptyHeading = this.#deps.hideSubagents ? "inactive" : "running";
			return [theme.bold(sectionTitle(emptyHeading)), theme.fg("dim", "  No sessions match your search.")].slice(
				0,
				maxRows,
			);
		}
		// The Current section only exists when a host session is attached (and
		// survives the search filter); every other heading always renders.
		// The Current section only exists when a host session is attached (and
		// survives the search filter); every other heading always renders.
		const wantedSections: AgentsViewSection[] = this.#deps.hideSubagents
			? ["current", "inactive"]
			: ["running", "idle", "current", "inactive"];
		const counts = countAgentsBySection(this.#rows);
		const sections = wantedSections.filter(section => section !== "current" || counts.current > 0);
		const displayItems = buildDisplayItems(this.#rows, sections);
		const selectedIdentity = this.#rows[this.#selectedIndex]?.identity;
		const selectedIndex = displayItems.findIndex(
			item => item.type === "row" && item.row.identity === selectedIdentity,
		);
		const visibleRows = Math.min(maxRows, this.#visibleListRows());
		const start = Math.max(
			0,
			Math.min(displayItems.length - visibleRows, selectedIndex - Math.floor(visibleRows / 2)),
		);
		const showLeadingEllipsis = start > 0;
		let showTrailingEllipsis = start + visibleRows < displayItems.length;
		if ((showLeadingEllipsis ? 1 : 0) + (showTrailingEllipsis ? 1 : 0) >= visibleRows) {
			showTrailingEllipsis = false;
		}
		const contentVisibleRows = Math.max(
			0,
			visibleRows - (showLeadingEllipsis ? 1 : 0) - (showTrailingEllipsis ? 1 : 0),
		);
		const visibleItems = displayItems.slice(start, start + contentVisibleRows);
		const lines = visibleItems.map(item => {
			if (item.type === "spacer") return "";
			if (item.type === "heading") return theme.bold(sectionTitle(item.section));
			if (item.type === "empty") return theme.fg("dim", "  No agents");
			return this.#renderRow(item.row, width);
		});
		if (showLeadingEllipsis) lines.unshift(theme.fg("dim", "  ..."));
		if (showTrailingEllipsis) lines.push(theme.fg("dim", "  ..."));
		return lines;
	}

	#renderRow(row: AgentsViewRow, width: number): string {
		const selected = row.selectable && row.identity === this.#rows[this.#selectedIndex]?.identity;
		if (row.kind === "subagent-code") {
			const indent = "  ".repeat(row.depth);
			const body = theme.fg("muted", row.code || " ");
			return `${CODE_ROW_MARKER}${indent}  ${body}`;
		}
		if (row.kind === "subagent-summary") {
			const indent = "  ".repeat(row.depth);
			const hint = row.hasSpawnTask ? theme.fg("dim", ` \u00b7 ${formatViewKey("ctrl+o")} show program`) : "";
			// Stable model info ahead of the variable count text (prime parity).
			const modelSuffix = row.record ? getRecordModelLabel(row.record) : undefined;
			const modelCell = modelSuffix ? theme.fg("dim", ` \u00b7 ${modelSuffix}`) : "";
			const label = `${theme.fg("dim", `${row.expanded ? "▾" : "▸"} ${row.title}`)}${modelCell}${hint}`;
			return `${SELECTED_ROW_MARKER}${padLine(truncateToWidth(`${indent}${label}`, width), width)}`;
		}
		const pendingDelete = row.kind === "agent" && this.#pendingDelete?.identity === row.identity;
		// Parked/completed children render exactly like prime's completed
		// children: dim check, bare title, messageCount \u00b7 age right cell.
		const settledChild =
			row.kind === "subagent" && row.record?.ref !== undefined && row.record.ref.status !== "running";
		const rawIcon = settledChild ? INACTIVE_ROW_ICON : this.#getRowIcon(row.section);
		const icon = settledChild ? theme.fg("dim", rawIcon) : this.#formatRowIcon(row.section, rawIcon);
		const indent = "  ".repeat(row.depth);
		const record = row.record;
		const details = settledChild
			? `${record?.session?.messageCount ?? 0} \u00b7 ${formatRelativeAge(record?.ref?.lastActivity ?? record?.session?.modified.getTime() ?? Date.now())}`
			: row.details;
		const detailsWidth = row.detailsWidth > 0 ? row.detailsWidth : 10;
		const title = pendingDelete ? `${formatViewKey("ctrl+x")} again to remove` : this.#styleRowTitle(row);
		const suffixes: string[] = [];
		if (row.kind === "subagent" && !settledChild) {
			const modelLabel = getRecordModelLabel(record) ?? record?.ref?.history?.resolvedModel;
			if (modelLabel) suffixes.push(modelLabel);
			if (!pendingDelete && row.subtitle) suffixes.push(row.subtitle);
		}
		const titleContent = suffixes.length > 0 ? `${title} ${theme.fg("dim", `· ${suffixes.join(" · ")}`)}` : title;
		const titleWidth = Math.max(0, width - visibleWidth(indent) - visibleWidth(rawIcon) - detailsWidth - 2);
		const titleCell = formatTableCell(pendingDelete ? theme.fg("error", titleContent) : titleContent, titleWidth);
		const marked = selected ? SELECTED_ROW_MARKER : "";
		const base = `${indent}${icon} ${titleCell} ${formatRightTableCell(details, detailsWidth)}`;
		return `${marked}${padLine(truncateToWidth(base, width), width)}`;
	}

	#getRowIcon(section: AgentsViewSection): string {
		switch (section) {
			case "running":
				return theme.spinnerFrames[this.#animationFrame % theme.spinnerFrames.length] ?? "▶";
			case "idle":
				return IDLE_ROW_ICON;
			case "current":
				return CURRENT_ROW_ICON;
			case "inactive":
				return INACTIVE_ROW_ICON;
		}
	}

	#formatRowIcon(section: AgentsViewSection, icon: string): string {
		switch (section) {
			case "running":
				return theme.bold(icon);
			case "idle":
				return theme.fg("warning", icon);
			case "current":
				return theme.fg("accent", icon);
			case "inactive":
				return theme.fg("dim", icon);
		}
	}

	#styleRowTitle(row: AgentsViewRow): string {
		const record = row.record;
		if (!record) return row.title;
		if (hasExplicitTitle(record)) return theme.bold(row.title);
		if (row.title === "(no messages)") return theme.italic(row.title);
		return row.title;
	}

	// Spawn-task rows render deemphasized — muted text on a panel background so
	// the program reads as one quiet segmented block; the selected row repaints
	// its whole line with the selection background after every embedded reset.
	#finalizeLine(line: string, width: number): string {
		const code = line.startsWith(CODE_ROW_MARKER);
		const selected = !code && line.startsWith(SELECTED_ROW_MARKER);
		let content = code
			? line.slice(CODE_ROW_MARKER.length)
			: selected
				? line.slice(SELECTED_ROW_MARKER.length)
				: line;
		content = content.replace(/[\r\n]+/g, " ");
		const padded = padLine(truncateToWidth(content, width), width);
		if (code) return theme.bg("toolPendingBg", padded);
		if (!selected) return padded;
		return theme.bgFill("selectedBg", padded);
	}

	#renderHints(width: number): string {
		if (this.#statusMessage) {
			return truncateToWidth(theme.fg(this.#statusMessage.tone, this.#statusMessage.text), width);
		}
		if (this.#viewMode === "rename") {
			return truncateToWidth(
				theme.fg(
					"muted",
					`${this.#keyText("tui.select.confirm")} save   ${this.#keyText("tui.select.cancel")} cancel`,
				),
				width,
			);
		}
		if (this.#viewMode === "reply") {
			return truncateToWidth(theme.fg("muted", this.#renderReplyComposerHints()), width);
		}
		const row = this.#rows[this.#selectedIndex];
		const selectedAgent = row?.kind === "agent";
		const selectedSubagent = row?.kind === "subagent";
		const selectedSummary = row?.kind === "subagent-summary";
		const hints = [
			`${this.#keyText("tui.select.up")}/${this.#keyText("tui.select.down")} move`,
			selectedSummary
				? `${this.#keyText("tui.select.confirm")} ${row?.expanded ? "collapse" : "expand"}`
				: `${this.#keyText("tui.select.confirm")} open`,
			selectedAgent ? `${formatViewKey("space")} ${row?.section === "inactive" ? "resume" : "reply"}` : undefined,
			`${formatViewKey("ctrl+n")} new`,
			selectedAgent ? `${formatViewKey("ctrl+r")} rename` : undefined,
			selectedAgent
				? `${formatViewKey("ctrl+x")} ${row?.section === "inactive" ? "delete" : "stop/deactivate"}`
				: undefined,
			selectedSubagent ? `${formatViewKey("ctrl+x")} ${row.section === "running" ? "stop" : "delete"}` : undefined,
			this.#selectedRowCanShowProgram() ? `${formatViewKey("ctrl+o")} program` : undefined,
		]
			.filter(hint => hint !== undefined)
			.join("   ");
		return truncateToWidth(theme.fg("muted", hints), width);
	}

	#renderReplyComposerHints(): string {
		const target = this.#replyTarget;
		if (!target) return "";
		const streaming = Boolean(target.refId && this.#registry.get(target.refId)?.session?.isStreaming);
		const hasText = this.#editor.getText().trim().length > 0;
		return [
			`${this.#keyText("tui.select.confirm")} ${streaming ? "steer" : target.isInactive ? "resume & send" : "send"}`,
			hasText ? `${this.#keyText("app.message.followUp")} queue` : undefined,
			`${this.#keyText("tui.select.cancel")} cancel`,
		]
			.filter(hint => hint !== undefined)
			.join("   ");
	}

	#selectedRowCanShowProgram(): boolean {
		const target = this.#programTargetIdentity();
		if (!target) return false;
		if (this.#programShownParents.has(target)) return true;
		return this.#childRowsOf(target).some(child => child.spawnTask !== undefined);
	}

	invalidate(): void {
		this.#editor.invalidate();
	}
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function formatTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatRightTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

function isCurrentSessionFile(candidate: string, currentFile: string | null): boolean {
	if (!currentFile) return false;
	try {
		return pathResolve(candidate) === pathResolve(currentFile);
	} catch {
		return candidate === currentFile;
	}
}

type DisplayItem =
	| { type: "spacer" }
	| { type: "heading"; section: AgentsViewSection }
	| { type: "empty"; section: AgentsViewSection }
	| { type: "row"; row: AgentsViewRow };

// Nested rows always render inside their top-level agent's section block,
// regardless of their own section.
function getDisplayRowsForSection(rows: readonly AgentsViewRow[], section: AgentsViewSection): AgentsViewRow[] {
	const result: AgentsViewRow[] = [];
	let include = false;
	for (const row of rows) {
		if (row.depth === 0) include = row.section === section;
		if (include) result.push(row);
	}
	return result;
}

function buildDisplayItems(
	rows: readonly AgentsViewRow[],
	sections: readonly AgentsViewSection[] = ["running", "idle", "inactive"],
): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const [index, section] of sections.entries()) {
		if (index > 0) items.push({ type: "spacer" });
		items.push({ type: "heading", section });
		const sectionRows = getDisplayRowsForSection(rows, section);
		if (sectionRows.length === 0) {
			items.push({ type: "empty", section });
			continue;
		}
		for (const row of sectionRows) items.push({ type: "row", row });
	}
	return items;
}
