import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import { sanitizeStatusText } from "../../shared";
import { withIcon } from "../../theme/icon-label";
import { theme } from "../../theme/theme";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { focusExitBadge, renderSegment, type SegmentContext } from "./segments";
import { segmentSeparator, stateSeparator } from "./state-grammar";
import { calculateTokensPerSecond } from "./token-rate";
import type {
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

/**
 * Gap between the location group and the total-elapsed clock. Deliberately
 * wider than the standard separator and dot-free, so the clock reads as its
 * own quiet zone at the end of the line rather than one more segment.
 */
const SESSION_CLOCK_GAP = "      ";

/**
 * One quiet-footline part: the segment id it came from plus its rendered
 * content. Ids are StatusLineSegmentId values, or the synthetic "badges"
 * (the animated badge slot) / "location_right" (owner-pinned right content).
 */
type QuietPart = { id: string; content: string };

const RIGHT_PART_SHED_RANK: Record<string, number> = {
	context_pct: 1,
	mode: 2,
	location_right: 3,
	subagents: 4,
};

/** One segment's slot on the rendered quiet footline (0-based columns, end exclusive). */
export interface QuietSegmentBounds {
	id: string;
	start: number;
	end: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Context-usage memo
// ═══════════════════════════════════════════════════════════════════════════

function structuralTextSize(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean" || value === null || value === undefined) return 1;
	if (Array.isArray(value)) {
		let sum = 2;
		for (const item of value) sum += 1 + structuralTextSize(item);
		return sum;
	}
	if (typeof value === "object") {
		let sum = 2;
		for (const key in value as Record<string, unknown>) {
			sum += key.length + 1 + structuralTextSize((value as Record<string, unknown>)[key]);
		}
		return sum;
	}
	return 1;
}

export function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const usageExt = assistantMsg.usage as unknown as { promptTokensDetails?: unknown };
		const usageTotal = assistantMsg.usage?.totalTokens ?? 0;
		const promptBuckets = usageExt?.promptTokensDetails ? 1 : 0;
		const stopReason = assistantMsg.stopReason ?? "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		const thinkingSignature = msgExt.thinkingSignature;
		if (typeof thinkingSignature === "string") {
			signatureLen += thinkingSignature.length;
		}
		const textSignature = msgExt.textSignature;
		if (typeof textSignature === "string") {
			signatureLen += textSignature.length;
		}
		const thoughtSignature = msgExt.thoughtSignature;
		if (typeof thoughtSignature === "string") {
			signatureLen += thoughtSignature.length;
		}
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") {
			redactedLen += redactedData.length;
		}

		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as {
					type?: string;
					text?: string;
					thinking?: string;
					thinkingSignature?: string;
					signature?: string;
					textSignature?: string;
					thoughtSignature?: string;
					data?: string;
					name?: string;
					arguments?: unknown;
				};
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking") {
					if (typeof b.thinking === "string") textLen += b.thinking.length;
					if (typeof b.thinkingSignature === "string") signatureLen += b.thinkingSignature.length;
					if (typeof b.signature === "string") signatureLen += b.signature.length;
					if (typeof b.textSignature === "string") signatureLen += b.textSignature.length;
					if (typeof b.thoughtSignature === "string") signatureLen += b.thoughtSignature.length;
				} else if (b.type === "redactedThinking" && typeof b.data === "string") {
					redactedLen += b.data.length;
				} else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					if (b.arguments !== undefined) {
						textLen += structuralTextSize(b.arguments);
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${promptBuckets}:${stopReason}`;
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number | null;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly unknown[] | undefined;
	skillsRef: readonly unknown[] | undefined;
}

interface ActiveRepoCache {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	/** Project + worktree dir name when `projectDir` is a linked worktree, else null. */
	worktree: WorktreeContext | null;
}

interface WorktreeContext {
	/** Primary-checkout (project) name shown by the path segment. */
	projectName: string;
	/** Worktree directory name — suppressed from the path when it equals the branch. */
	worktreeName: string;
}

function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	/** Duration of the most recently COMPLETED run window — what the location
	 * line's stopped clock (`✓ 0:21`) shows once the agent yields. */
	lastRunMs: number;
	sessionFile: string | undefined;
}

const EMPTY_MESSAGES: readonly AgentMessage[] = [];
const STATUS_USAGE_START_DELAY_MS = 0;
const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}
function hasGitSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("git");
}

function hasPrSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("pr");
}
function hasPathSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("path");
}

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

function scopedTimeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`scoped timeout after ${ms}ms`)), ms);
	return {
		signal: controller.signal,
		cancel: () => clearTimeout(timer),
	};
}

function withScopedTimeoutSignal<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const { signal, cancel } = scopedTimeoutSignal(ms);
	return fn(signal).finally(cancel);
}

function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

type ResolvedContextLimit = { tokens: number; kind: "window" | "compaction" };

function resolveContextLimit(contextWindow: number, compaction: CompactionSettings): ResolvedContextLimit {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { tokens: 0, kind: "window" };
	if (!compaction.enabled || compaction.strategy === ("off" as CompactionSettings["strategy"])) {
		return { tokens: contextWindow, kind: "window" };
	}
	const threshold = resolveThresholdTokens(contextWindow, compaction);
	// A non-positive threshold means no usable fire point was configured.
	if (!(threshold > 0)) return { tokens: contextWindow, kind: "window" };
	return { tokens: Math.min(threshold, contextWindow), kind: "compaction" };
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	#cachedPrBranch: string | null = null;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#locationRightProvider: (() => string | null) | undefined;
	#subagentCount: number = 0;
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#focusedAgentId: string | undefined;
	#previewTitle: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: git.GitStatusSummary | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchCwd: string | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	// Provider usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;

	// Serving-account memo keyed on the cheap facts that can change the answer.
	#cachedServingAccount: {
		key: string;
		value: { label: string; storedCount: number; isPrediction: boolean } | null;
	} | null = null;
	// Context-usage memo. The status line redraws on every agent event, so the
	// hot path must not recompute context tokens unless an input changed.
	#contextUsageCache: ContextUsageMemo | undefined;

	constructor(private session: AgentSession) {
		this.#settings = {
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		};
	}
	#gitEnabled(): boolean {
		return settings.get("git.enabled");
	}
	#hasGitBackedSegment(): boolean {
		const effectiveSettings = this.#resolveSettings();
		return (
			hasGitBackedSegment(effectiveSettings.leftSegments) || hasGitBackedSegment(effectiveSettings.rightSegments)
		);
	}

	#resolveActiveRepoCache(): ActiveRepoCache {
		const projectDir = this.session.sessionManager?.getCwd?.() ?? getProjectDir();
		if (this.#activeRepoCache?.projectDir === projectDir) {
			return this.#activeRepoCache;
		}

		const activeRepo = resolveActiveRepoContextSync(projectDir);
		const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
		// Only collapse the bare-cwd case: a single-direct-child-repo context
		// (activeRepo set) renders `<parent> ↳ <child>`, which we leave intact.
		const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd, worktree };
		return this.#activeRepoCache;
	}

	/**
	 * Re-point the status line at another session (focus proxy). Invalidate: model/context/usage all derive
	 * from it. `focusedAgentId` is the focused subagent id while the view is proxied, undefined for main.
	 */
	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.session = session;
		this.#focusedAgentId = focusedAgentId;
		if (sessionChanged) {
			this.#invalidateSessionCaches();
			this.#closeStaleActiveWindow();
		}
		this.invalidate();
	}

	#closeStaleActiveWindow(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		if (this.session.isStreaming) return;
		meter.activeStartedAt = null;
	}

	updateSettings(settingsUpdate: StatusLineSettings): void {
		this.#settings = settingsUpdate;
		this.#effectiveSettings = undefined;
		if (this.#onBranchChange) this.#setupGitWatcher();
	}

	getEffectiveSettingsForTest(): EffectiveStatusLineSettings {
		return this.#resolveSettings();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
	}

	/** Currently executing subagents shown on every interactive status surface. */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
		meter.lastRunMs = 0;
	}

	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		const windowMs = Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeMs += windowMs;
		meter.lastRunMs = windowMs;
		meter.activeStartedAt = null;
	}

	getRunClock(): { runningMs: number | null; lastRunMs: number } {
		const meter = this.#meter();
		return {
			runningMs: meter.activeStartedAt === null ? null : Math.max(0, Date.now() - meter.activeStartedAt),
			lastRunMs: meter.lastRunMs,
		};
	}

	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

	#meter(): ActiveMeter {
		const currentFile = this.session.sessionFile;
		let meter = this.#activeMeters.get(this.session);
		if (meter) {
			const switched =
				currentFile !== undefined && meter.sessionFile !== undefined && meter.sessionFile !== currentFile;
			if (switched) {
				meter = undefined;
			} else {
				meter.sessionFile = currentFile;
			}
		}
		if (!meter) {
			meter = { activeMs: 0, activeStartedAt: null, lastRunMs: 0, sessionFile: currentFile };
			this.#activeMeters.set(this.session, meter);
		}
		return meter;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: { enabled: boolean } | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		if (!this.#gitEnabled() || !this.#hasGitBackedSegment()) {
			this.#invalidateGitCaches();
			return;
		}

		const { effectiveGitCwd } = this.#resolveActiveRepoCache();
		const repository = git.repo.resolveSync(effectiveGitCwd);
		if (!repository) return;

		const watchPath = git.repo.isReftableSync(repository)
			? path.join(repository.gitDir, "reftable")
			: repository.headPath;

		try {
			this.#gitWatcher = fs.watch(watchPath, () => {
				if (this.#disposed) return;
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#onBranchChange = null;
		this.#clearUsageStartTimer();
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	#clearUsageStartTimer(): void {
		if (!this.#usageStartTimer) return;
		clearTimeout(this.#usageStartTimer);
		this.#usageStartTimer = null;
	}

	invalidate(): void {
		this.#invalidateGitCaches();
	}

	/**
	 * Repo/cwd switch: drop every cached answer derived from the working
	 * directory and re-arm the git watcher. Called by
	 * `InteractiveMode.applyCwdChange`; generic repaints use {@link invalidate}.
	 */
	applyCwdChange(): void {
		this.#activeRepoCache = undefined;
		this.#cachedGitStatus = null;
		this.#cachedGitStatusCwd = undefined;
		this.#gitStatusLastFetch = 0;
		this.#invalidateGitCaches();
		this.#setupGitWatcher();
	}

	#invalidateSessionCaches(): void {
		this.#clearUsageStartTimer();
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#contextUsageCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondTimestamp = null;
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(effectiveGitCwd?: string): string | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === gitCwd) {
			return this.#cachedBranch;
		}

		const head = git.head.resolveSync(gitCwd);
		const headPath = head?.headPath ?? null;
		this.#cachedBranchCwd = gitCwd;
		this.#cachedBranchRepoId = headPath;
		if (head?.kind !== "ref") {
			this.#cachedBranch = null;
			this.#cachedPrBranch = null;
			return null;
		}

		this.#cachedBranch = head.branchName ?? head.ref ?? null;
		this.#cachedPrBranch = head.branchName;

		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string, effectiveGitCwd: string): boolean {
		if (this.#defaultBranchCwd !== effectiveGitCwd) {
			this.#defaultBranch = undefined;
			this.#defaultBranchCwd = effectiveGitCwd;
		}

		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			const lookupCwd = effectiveGitCwd;
			(async () => {
				const resolved = await git.branch.default(lookupCwd);
				if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(effectiveGitCwd?: string): git.GitStatusSummary | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#gitStatusInFlightCwd !== undefined) {
			return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
		}
		if (this.#cachedGitStatusCwd === gitCwd && Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlightCwd = gitCwd;

		(async () => {
			let nextStatus: git.GitStatusSummary | null = null;
			try {
				nextStatus = await git.status.summary(gitCwd);
			} catch {
				nextStatus = null;
			} finally {
				if (this.#gitStatusInFlightCwd === gitCwd) {
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
				}
			}
		})();

		return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
	}

	#lookupPr(effectiveGitCwd?: string): { number: number; url: string } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const branch = this.#getCurrentBranch(gitCwd);
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		if (!branch) {
			this.#cachedPr = null;
			this.#cachedPrContext = undefined;
			return null;
		}

		// Don't look up without a plain branch to look up BY (detached), on the
		// default branch, or with one in flight.
		const lookupBranch = this.#cachedPrBranch;
		if (!lookupBranch || this.#isDefaultBranch(lookupBranch, gitCwd) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const lookupCwd = gitCwd;

		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch(lookupCwd);
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				const result = await withScopedTimeoutSignal(git.GIT_COMMAND_TIMEOUT_MS, signal =>
					git.github.run(lookupCwd, ["pr", "view", "--json", "number,url"], signal),
				);
				if (this.#disposed) return;
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				if (this.#disposed) return;
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (!this.#disposed && this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider ?? "";
		if (!activeProvider) return "";
		const identity = session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId);
		// orgId is part of the key: rotating between two same-email Anthropic
		// subscriptions must invalidate the cached usage immediately.
		return [
			activeProvider,
			identity?.accountId ?? "",
			identity?.email ?? "",
			identity?.projectId ?? "",
			identity?.orgId ?? "",
		].join("\0");
	}

	/**
	 * Which stored credential is serving the active provider, and how many it stores.
	 *
	 * Proto's auth storage keeps one identity per provider; the label comes from
	 * that identity's email/account, and there is no routing prediction to name.
	 */
	#servingAccount(session: AgentSession): { label: string; storedCount: number; isPrediction: boolean } | null {
		if (!settings.get("statusLine.showAccount")) return null;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const authStorage = session.modelRegistry?.authStorage;
		if (!activeProvider || !authStorage) return null;
		const stored = authStorage.listStoredCredentials(activeProvider);
		if (stored.length === 0) return null;
		const identity = authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId);
		const label = identity?.email ?? identity?.accountId ?? String(stored[0]?.id ?? "");
		if (!label) return null;
		const key = [activeProvider, label, stored.length].join("\0");
		const cached = this.#cachedServingAccount;
		if (cached?.key === key) return cached.value;
		const value = { label, storedCount: stored.length, isPrediction: false };
		this.#cachedServingAccount = { key, value };
		return value;
	}

	refreshUsageInBackground(): void {
		const now = Date.now();
		const session = this.session;
		const usageContextKey = this.#getUsageContextKey(session);
		if (this.#cachedUsageContextKey !== usageContextKey) {
			this.#cachedUsage = null;
			this.#usageFetchedAt = 0;
			this.#cachedUsageContextKey = usageContextKey;
		}
		if (this.#usageInFlight || this.#usageStartTimer) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const fetcher = (session as { fetchUsageReports?: (signal?: AbortSignal) => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		this.#usageStartTimer = setTimeout(() => {
			this.#usageStartTimer = null;
			void this.#runUsageRefresh(session, fetcher);
		}, STATUS_USAGE_START_DELAY_MS);
	}

	async #runUsageRefresh(session: AgentSession, fetcher: (signal?: AbortSignal) => Promise<unknown>): Promise<void> {
		if (this.#disposed || this.session !== session) {
			this.#usageInFlight = false;
			return;
		}
		const { signal, cancel } = scopedTimeoutSignal(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let reportsPromise: Promise<unknown> | undefined;
		try {
			reportsPromise = fetcher.call(session, signal);
			this.#applyUsageRefreshReports(session, await this.#raceUsageRefreshWithSignal(reportsPromise, signal));
		} catch {
			if (this.session !== session) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && reportsPromise) {
				this.#observeLateUsageRefresh(session, reportsPromise);
			}
		} finally {
			cancel();
			if (this.session === session) this.#usageInFlight = false;
		}
	}

	#applyUsageRefreshReports(session: AgentSession, reports: unknown): void {
		if (this.#disposed || this.session !== session) return;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const activeIdentity =
			activeProvider && session.modelRegistry?.authStorage
				? session.modelRegistry.authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId)
				: undefined;
		this.#cachedUsage = this.#normalizeUsageReports(reports, activeProvider, activeIdentity);
		this.#usageFetchedAt = Date.now();
	}

	#observeLateUsageRefresh(session: AgentSession, reportsPromise: Promise<unknown>): void {
		void reportsPromise
			.then(reports => {
				this.#applyUsageRefreshReports(session, reports);
			})
			.catch(() => {
				if (this.#disposed || this.session !== session) return;
				this.#usageFetchedAt = Date.now();
			});
	}

	async #raceUsageRefreshWithSignal(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw signal.reason;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#normalizeUsageReports(
		reports: unknown,
		activeProvider?: string,
		activeIdentity?: OAuthAccountIdentity,
	): {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		let fiveHourTier: string | undefined;
		let sevenDayTier: string | undefined;
		const now = Date.now();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = (report as { provider?: unknown }).provider;
			if (activeProvider && provider !== activeProvider) continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				if (
					activeIdentity &&
					!limitMatchesActiveAccount(report as UsageReport, limit as UsageLimit, activeIdentity)
				) {
					continue;
				}
				const l = limit as {
					scope?: { windowId?: string; tier?: string };
					window?: { resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const windowId = l.scope?.windowId;
				const tier = l.scope?.tier;
				const resetsAt = l.window?.resetsAt;
				// Accept tiered limits, but prefer untiered (backward compat).
				if (windowId === "5h" && (!fiveHour || (fiveHourTier !== undefined && !tier))) {
					fiveHour = {
						percent: fraction * 100,
						resetMinutes:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
					};
					fiveHourTier = tier || undefined;
				}
				if (windowId === "7d" && (!sevenDay || (sevenDayTier !== undefined && !tier))) {
					sevenDay = {
						percent: fraction * 100,
						resetHours:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
					};
					sevenDayTier = tier || undefined;
				}
			}
		}
		if (!fiveHour && !sevenDay) return null;
		const effectiveTier = fiveHourTier ?? sevenDayTier;
		return { tier: effectiveTier, fiveHour, sevenDay };
	}

	/**
	 * Used-tokens / context-window totals for the context% segment, memoized so
	 * the per-event redraw stays O(1) when nothing changed. The numerator comes
	 * from `session.getContextUsage()`, which anchors on the last assistant's
	 * real prompt-token count, and reports `null` while that count is unknown.
	 */
	getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number } {
		const messages = this.session.messages ?? EMPTY_MESSAGES;
		const modelContextWindow = this.session.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		// Bumps when the in-flight pending snapshot is set/cleared.
		const contextUsageRevision = this.session.contextUsageRevision ?? 0;

		const systemPrompt = this.session.systemPrompt;
		const tools = this.session.agent?.state?.tools;
		const skills = this.session.skills;

		const cache = this.#contextUsageCache;
		if (
			cache &&
			cache.messagesRef === messages &&
			cache.length === length &&
			cache.lastFingerprint === lastFingerprint &&
			cache.modelContextWindow === modelContextWindow &&
			cache.contextUsageRevision === contextUsageRevision &&
			cache.systemPromptRef === systemPrompt &&
			cache.toolsRef === tools &&
			cache.skillsRef === skills
		) {
			return { usedTokens: cache.usedTokens, contextWindow: cache.contextWindow };
		}

		const usage = this.session.getContextUsage();
		// `undefined` from the session means "no anchor yet", which is a different fact
		// from zero tokens and is carried as `null` rather than flattened into a number.
		const usedTokens = usage?.tokens ?? null;
		const contextWindow = usage?.contextWindow ?? modelContextWindow;
		this.#contextUsageCache = {
			messagesRef: messages,
			length,
			lastFingerprint,
			modelContextWindow,
			contextUsageRevision,
			usedTokens,
			contextWindow,
			systemPromptRef: systemPrompt,
			toolsRef: tools,
			skillsRef: skills,
		};
		return { usedTokens, contextWindow };
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		let contextLimit = contextWindow;
		let contextLimitKind: "window" | "compaction" = "window";
		let contextPercent: number | null = 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextWindow = breakdown.contextWindow || contextWindow;
			contextLimit = contextWindow;
			// Measure against the auto-compact fire point, not the raw model
			// window. The window itself stays intact in `contextWindow`.
			const compaction = this.session.settings?.getGroup?.("compaction");
			if (this.#autoCompactEnabled && compaction) {
				const limit = resolveContextLimit(contextWindow, compaction);
				contextLimit = limit.tokens;
				contextLimitKind = limit.kind;
			}
			contextPercent =
				breakdown.usedTokens === null
					? null
					: contextLimit > 0
						? (breakdown.usedTokens / contextLimit) * 100
						: null;
		}

		const shouldResolveActiveRepo = this.#gitEnabled() && (includePath || includeGit || includePr);
		const projectDir = this.session.sessionManager?.getCwd?.() ?? getProjectDir();
		const activeRepoCache = shouldResolveActiveRepo
			? this.#resolveActiveRepoCache()
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir, worktree: null };
		const gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		const gitStatus = includeGit ? this.#getGitStatus(activeRepoCache.effectiveGitCwd) : null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		return {
			session: this.session,
			focusedAgentId: this.#focusedAgentId,
			previewTitle: this.#previewTitle,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			compactThinkingLevel: this.#resolveSettings().compactThinkingLevel ?? false,
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			prewalk:
				typeof this.session.getPrewalkState === "function" && this.session.getPrewalkState()
					? { enabled: true }
					: null,
			goalMode: this.#goalModeStatus,
			usageStats,
			contextPercent,
			contextWindow,
			contextLimit,
			contextLimitKind,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			activeMs: this.getActiveMs(),
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
			worktree: activeRepoCache.worktree,
			account: this.#servingAccount(this.session),
			usage: this.#cachedUsage,
		};
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};
		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		return {
			...this.#settings,
			// Partial `updateSettings` payloads (previews) omit the segment lists;
			// fall back to the configured defaults instead of an empty line.
			leftSegments: this.#settings.leftSegments ?? settings.get("statusLine.leftSegments"),
			rightSegments: this.#settings.rightSegments ?? settings.get("statusLine.rightSegments"),
			segmentOptions: mergedSegmentOptions,
		};
	}

	#subagentBadgeText(): string {
		if (this.#subagentCount === 0) return "";
		return theme.fg("statusLineSubagents", withIcon(theme.icon.agents, `${this.#subagentCount}`));
	}

	/**
	 * Running background jobs the SUBAGENT badge does not already stand for.
	 * Async bash, debug and launch jobs are real background work with no
	 * subagent behind them; worker jobs count as subagents elsewhere.
	 */
	#backgroundJobBadgeCount(): number {
		const running = this.session.getAsyncJobSnapshot()?.running;
		if (!running) return 0;
		return running.reduce((count, job) => (job.type === "worker" ? count : count + 1), 0);
	}

	/**
	 * Gather the quiet-zone segments into their three groups: location (path ·
	 * git · pr), capability-left (model · mode …), and capability-right
	 * (context, badges). ONE owner for the grouping logic — both the two-line
	 * selector layout ({@link renderQuietLines}) and the composer's single
	 * footline ({@link renderQuietLine}) read from here.
	 */
	#gatherQuietSegments(width: number): { location: QuietPart[]; capLeft: QuietPart[]; capRight: QuietPart[] } {
		const effectiveSettings = this.#resolveSettings();
		const gitEnabled = this.#gitEnabled();
		const leftCfg = effectiveSettings.leftSegments;
		const rightCfg = effectiveSettings.rightSegments;
		const includePath = hasPathSegment(leftCfg) || hasPathSegment(rightCfg);
		const includeContext = hasContextSegment(leftCfg) || hasContextSegment(rightCfg);
		const includeGit = gitEnabled && (hasGitSegment(leftCfg) || hasGitSegment(rightCfg));
		const includePr = gitEnabled && (hasPrSegment(leftCfg) || hasPrSegment(rightCfg));
		const quietOptions = {
			...effectiveSettings.segmentOptions,
			path: {
				...effectiveSettings.segmentOptions?.path,
				maxLength: effectiveSettings.segmentOptions?.path?.maxLength ?? 30,
			},
		};
		const ctx = this.#buildSegmentContext(width, quietOptions, includePath, includeContext, includeGit, includePr);
		const LOCATION_IDS: Record<string, true> = { path: true, git: true, pr: true };
		const CONTEXT_IDS: Record<string, true> = { context_pct: true, context_total: true };
		const subagentBadge = this.#subagentBadgeText();
		const location: QuietPart[] = [];
		const capLeft: QuietPart[] = [];
		const capRight: QuietPart[] = [];
		const push = (id: StatusLineSegmentId, out: QuietPart[]) => {
			if (id === "subagents") return;
			const rendered = renderSegment(id, ctx);
			if (rendered.visible && rendered.content) out.push({ id, content: rendered.content });
		};
		// The context gauge is the footline's one LIVE value; held aside and
		// appended after the right group so it reads as the line's last word.
		const contextFromLeft: QuietPart[] = [];
		for (const id of leftCfg) {
			if (LOCATION_IDS[id]) push(id, location);
			else if (CONTEXT_IDS[id]) push(id, contextFromLeft);
			else push(id, capLeft);
		}
		for (const id of rightCfg) {
			if (LOCATION_IDS[id]) push(id, location);
			else push(id, capRight);
		}
		capRight.push(...contextFromLeft);
		const runningBackgroundJobs = this.#backgroundJobBadgeCount();
		const badgeParts: string[] = [];
		if (runningBackgroundJobs > 0) {
			badgeParts.push(theme.fg("statusLineSubagents", withIcon(theme.icon.job, `${runningBackgroundJobs}`)));
		}
		const badgeSlot = this.#animatedBadgeSlot(badgeParts);
		if (badgeSlot !== null) capRight.unshift({ id: "badges", content: badgeSlot });
		if (subagentBadge) capRight.unshift({ id: "subagents", content: subagentBadge });
		return { location, capLeft, capRight };
	}

	// Layout of the last rendered quiet footline, for click hit-testing
	// (quietSegmentAt). Rewritten on every renderQuietLine call.
	#quietLineBounds: QuietSegmentBounds[] = [];

	// Background-job badge animation state. Jobs ease in/out over BADGE_ANIM_MS
	// so a start or finish reads as an intentional merge instead of the right
	// group jumping sideways.
	#badgeSlotFromWidth = 0;
	#badgeSlotTargetWidth = 0;
	#badgeSlotAnimStartMs = 0;
	#badgeSlotText = "";
	static readonly #BADGE_ANIM_MS = 240;

	#animatedBadgeSlot(badgeParts: string[]): string | null {
		const targetWidth = badgeParts.length > 0 ? visibleWidth(badgeParts.join(stateSeparator())) : 0;
		if (targetWidth !== this.#badgeSlotTargetWidth) {
			this.#badgeSlotFromWidth = this.#badgeSlotCurrentWidth();
			this.#badgeSlotTargetWidth = targetWidth;
			this.#badgeSlotAnimStartMs = Date.now();
			if (targetWidth > 0) this.#badgeSlotText = badgeParts.join(stateSeparator());
		}
		const width = this.#badgeSlotCurrentWidth();
		if (width === 0) return null;
		const clipped = truncateToWidth(this.#badgeSlotText, width);
		const clippedWidth = visibleWidth(clipped);
		return clippedWidth >= width ? clipped : clipped + " ".repeat(width - clippedWidth);
	}

	#badgeSlotCurrentWidth(): number {
		const elapsed = Date.now() - this.#badgeSlotAnimStartMs;
		if (elapsed >= StatusLineComponent.#BADGE_ANIM_MS) return this.#badgeSlotTargetWidth;
		const t = elapsed / StatusLineComponent.#BADGE_ANIM_MS;
		const eased = t * t * (3 - 2 * t);
		return Math.round(this.#badgeSlotFromWidth + (this.#badgeSlotTargetWidth - this.#badgeSlotFromWidth) * eased);
	}

	/**
	 * Join the location group and append the MODEL RUN clock with a roomy gap.
	 * While the agent runs it ticks the current run (`0:42`); once the run
	 * finishes it freezes as a quiet receipt of the completed run (`✓ 0:21`).
	 * Dim; degrades first on tight widths.
	 */
	#locationWithRunClock(location: string[], sep: string, gap: string = SESSION_CLOCK_GAP): string {
		const left = location.join(sep);
		if (!left) return left;
		const { runningMs, lastRunMs } = this.getRunClock();
		const readout = runningMs !== null ? formatClock(runningMs) : lastRunMs > 0 ? `✓ ${formatClock(lastRunMs)}` : "";
		if (!readout) return left;
		return `${left}${gap}${theme.fg("dim", readout)}`;
	}

	/**
	 * The focus badge on its own, with no segments: the footline row rendered
	 * while `statusLine.enabled` is off. Null when nothing is proxied.
	 */
	renderFocusBadge(width: number): string | null {
		this.#quietLineBounds = [];
		if (!this.#focusedAgentId) return null;
		return truncateToWidth(focusExitBadge(this.#focusedAgentId), Math.max(1, width));
	}

	renderQuietLine(width: number, extras?: { locationRight?: string | null; previewTitle?: string }): string | null {
		this.#previewTitle = extras?.previewTitle;
		const rawBadge = this.#focusedAgentId ? focusExitBadge(this.#focusedAgentId) : "";
		const badge = rawBadge === "" ? "" : truncateToWidth(rawBadge, Math.max(1, width));
		const badgeWidth = visibleWidth(badge);
		const { location, capLeft, capRight } = this.#gatherQuietSegments(Math.max(0, width - badgeWidth));
		const sep = segmentSeparator();
		// One cell of right margin, always — nothing kisses the terminal edge.
		const inset = 2;
		const budget = Math.max(0, width - 1 - badgeWidth - inset);
		if (budget === 0) {
			this.#quietLineBounds = [];
			return badge === "" ? null : badge;
		}
		const locationContents = location.map(part => part.content);
		let left = this.#locationWithRunClock(locationContents, sep);
		const rightParts = [...capLeft, ...capRight];
		if (extras?.locationRight) rightParts.push({ id: "location_right", content: extras.locationRight });
		let right = rightParts.map(part => part.content).join(sep);
		// The run clock is comfort chrome; the capability segments are operating
		// data. On a tight width the clock degrades FIRST, then ranked parts shed.
		const sepWidth = visibleWidth(sep);
		let clockStage = 0;
		let locationShortened = false;
		while (
			rightParts.length > 0 &&
			visibleWidth(left) + visibleWidth(right) + (left && right ? sepWidth : 0) > budget
		) {
			if (clockStage === 0) {
				clockStage = 1;
				left = this.#locationWithRunClock(locationContents, sep, "  ");
				continue;
			}
			if (clockStage === 1) {
				clockStage = 2;
				left = locationContents.join(sep);
				continue;
			}
			let dropIndex = -1;
			let dropRank = Number.POSITIVE_INFINITY;
			for (let i = rightParts.length - 1; i >= 0; i--) {
				const rank = RIGHT_PART_SHED_RANK[rightParts[i]?.id ?? ""] ?? 0;
				if (rank < dropRank) {
					dropRank = rank;
					dropIndex = i;
				}
			}
			if (dropRank === 0 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = rightParts.map(part => part.content).join(sep);
				continue;
			}
			// Only ranked parts are left. Shorten the location before touching any
			// of them: a clipped path still says where you are.
			if (!locationShortened) {
				locationShortened = true;
				const leftBudget = Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0));
				left = truncateToWidth(locationContents.join(sep), leftBudget);
				continue;
			}
			if (rightParts.length > 1 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = rightParts.map(part => part.content).join(sep);
				continue;
			}
			break;
		}
		if (!left && !right) {
			this.#quietLineBounds = [];
			return badge === "" ? null : badge;
		}
		const bounds: QuietSegmentBounds[] = [];
		if (left) {
			let col = 0;
			for (const part of location) {
				const partWidth = visibleWidth(part.content);
				bounds.push({ id: part.id, start: col, end: col + partWidth });
				col += partWidth + sepWidth;
			}
		}
		const rightStart = left && right ? visibleWidth(left) + sepWidth : 0;
		if (right) {
			let col = rightStart;
			for (const part of rightParts) {
				const partWidth = visibleWidth(part.content);
				bounds.push({ id: part.id, start: col, end: col + partWidth });
				col += partWidth + sepWidth;
			}
		}
		this.#quietLineBounds = bounds
			.filter(entry => entry.start < budget)
			.map(entry => ({
				...entry,
				start: entry.start + badgeWidth + inset,
				end: Math.min(entry.end, budget) + badgeWidth + inset,
			}));
		if (left && right) {
			// One contiguous run: groups join with the standard segment separator
			// instead of an elastic filler, so no blank stretch opens mid-line.
			return badge + padding(inset) + truncateToWidth(`${left}${sep}${right}`, budget);
		}
		return badge + padding(inset) + truncateToWidth(left || right, Math.max(0, budget));
	}

	/**
	 * Resolve a 0-based column of the LAST rendered quiet footline to the id of
	 * the segment occupying it, or null for gaps/padding. The footline records
	 * its layout as it renders, so the answer is always in sync with what is on
	 * screen. Non-segment chrome reports synthetic ids ("badges",
	 * "location_right"); the run clock is unaddressable chrome.
	 */
	quietSegmentAt(col: number): string | null {
		for (const entry of this.#quietLineBounds) {
			if (col >= entry.start && col < entry.end) return entry.id;
		}
		return null;
	}

	/** Last rendered quiet-footline layout, for tests and debugging. */
	getQuietSegmentBounds(): readonly QuietSegmentBounds[] {
		return this.#quietLineBounds;
	}

	renderQuietLines(
		width: number,
		extras?: { locationRight?: string | null; previewTitle?: string },
	): { locationLine: string | null; capabilityLine: string | null } {
		this.#previewTitle = extras?.previewTitle;
		const gathered = this.#gatherQuietSegments(width);
		const location = gathered.location.map(part => part.content);
		const capLeft = gathered.capLeft.map(part => part.content);
		const capRight = gathered.capRight.map(part => part.content);
		const sep = segmentSeparator();
		// One cell of right margin, always — nothing kisses the terminal edge.
		const budget = Math.max(1, width - 1);
		let locationLine: string | null = null;
		if (location.length > 0) {
			const left = this.#locationWithRunClock(location, sep);
			const right = extras?.locationRight ?? null;
			if (right && visibleWidth(left) + visibleWidth(right) + 2 <= budget) {
				locationLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
			} else {
				locationLine = truncateToWidth(left, budget);
			}
		}
		let capabilityLine: string | null = null;
		if (capLeft.length > 0 || capRight.length > 0) {
			const left = capLeft.join(sep);
			const rightParts = [...capRight];
			let right = rightParts.join(sep);
			while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > budget) {
				rightParts.pop();
				right = rightParts.join(sep);
			}
			if (left && right) {
				capabilityLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
			} else {
				capabilityLine = truncateToWidth(left || right, budget);
			}
		}
		return { locationLine, capabilityLine };
	}

	render(width: number): readonly string[] {
		const rows: string[] = [];
		// Read per render rather than captured at construction: toggling the row
		// in `/settings` lands on the next frame with no re-mount.
		if (settings.get("statusLine.enabled")) {
			const footline = this.renderQuietLine(width, { locationRight: this.#locationRightProvider?.() ?? null });
			if (footline) rows.push(footline);
		} else {
			const badge = this.renderFocusBadge(width);
			if (badge) rows.push(badge);
		}
		return rows;
	}

	renderHookStatus(width: number): readonly string[] {
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) return [];
		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		return [truncateToWidth(sortedStatuses.join(" "), width)];
	}

	setLocationRightProvider(provider: (() => string | null) | undefined): void {
		this.#locationRightProvider = provider;
	}
}
