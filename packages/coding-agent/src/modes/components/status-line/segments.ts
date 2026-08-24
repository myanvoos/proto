import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, getProjectDir, pathIsWithin, relativePathWithinRoot } from "@oh-my-pi/pi-utils";
import { PRIORITY_TIER_LABEL } from "../../../config/service-tier";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../../tools/render-utils";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { withIcon } from "../../theme/icon-label";
import { type ThemeColor, theme } from "../../theme/theme";
import {
	type ContextUsageLevel,
	formatContextRemainingPercent,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "./context-thresholds";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

// Every mode label reads in the cool arc's mode hue so "what mode am I in" is
// one color everywhere; proto's palette resolves that hue through `accent`.
const MODE_ACCENT: ThemeColor = "accent";
// Session identity reads in the cool arc's session hue; same resolution.
const SESSION_ACCENT: ThemeColor = "accent";

function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Left-truncate a path/label to `maxLen`, prefixing an ellipsis when clipped. */
function clampPathLength(pwd: string, maxLen: number): string {
	if (pwd.length <= maxLen) return pwd;
	const ellipsis = "…";
	return `${ellipsis}${pwd.slice(-Math.max(0, maxLen - ellipsis.length))}`;
}

/**
 * Leading glyph of a thinking-level display string (e.g. "◉ xhigh" → "◉").
 * Compact mode promotes this glyph to the model-segment icon so the level
 * stays visible without the verbose effort tail.
 */
function thinkingGlyph(display: string): string {
	const space = display.indexOf(" ");
	return space === -1 ? display : display.slice(0, space);
}

/**
 * Chevron prefix for an effort label: one `›` through medium, `»` once the
 * effort is high or beyond — the count itself signals how hard the model is
 * pushed.
 */
function effortChevrons(level: string): string {
	return level === "high" || level === "xhigh" || level === "max" ? "»" : "›";
}

function stripDisplayRoot(pwd: string): string {
	for (const root of [path.join(os.homedir(), "Projects"), "/work"]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

const SCRATCH_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>([os.tmpdir(), path.join(os.homedir(), "tmp"), "/tmp", "/var/tmp"]);
	if (process.platform === "darwin") {
		roots.add("/private/tmp");
		roots.add("/private/var/tmp");
	}
	return [...roots];
})();

function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of SCRATCH_ROOTS) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `<agent> · esc to go back`, the one place the proxied view says whose
 * session you are in. Prefixed unconditionally by the live status surface, so
 * no preset can drop it and no preset choice can hide the way out.
 */
export function focusExitBadge(focusedAgentId: string): string {
	const who = theme.fg("warning", withIcon(theme.icon.ghost, focusedAgentId));
	const exit = `${theme.fg("accent", "esc")}${theme.fg("muted", " to go back")}`;
	return `${who}${theme.fg("muted", " · ")}${exit}${theme.fg("border", " │")}`;
}

const piSegment: StatusLineSegment = {
	id: "pi",
	render() {
		const content = withIcon(theme.icon.pi, "");
		return { content: theme.fg("accent", content), visible: true };
	},
};

const modelSegment: StatusLineSegment = {
	id: "model",
	render(ctx) {
		const state = ctx.session.state;
		const opts = ctx.options.model ?? {};

		let modelName = state.model?.name || state.model?.id || "no-model";
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}

		let thinkingDisplay = "";
		let effortLevel = "";
		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			const level = state.thinkingLevel ?? ThinkingLevel.Off;
			if (level !== ThinkingLevel.Off) {
				effortLevel = level;
				thinkingDisplay = theme.thinking[level as keyof typeof theme.thinking] ?? "";
			}
		}

		const compact = ctx.compactThinkingLevel && thinkingDisplay !== "";
		const modelIcon = compact ? thinkingGlyph(thinkingDisplay) : theme.icon.model;

		let tail = "";
		if (!compact && thinkingDisplay) {
			tail += ` ${effortChevrons(effortLevel)} ${thinkingDisplay}`;
		}

		let content = theme.fg("statusLineModel", withIcon(modelIcon, modelName));
		if (ctx.session.isAdvisorActive()) {
			content += theme.fg("success", "++");
		}
		if (tail) {
			content += theme.fg("statusLineModel", tail);
		}
		if (ctx.session.isFastModeActive()) {
			content += theme.fg("warning", ` ${formatServiceTierChip(compact)}`);
		}

		return { content, visible: true };
	},
};

/**
 * The priority-tier chip: icon plus the word, or the word alone when the symbol
 * theme has no icon. Compact mode keeps the icon only, falling back to the word.
 */
function formatServiceTierChip(compact: boolean): string {
	const icon = theme.icon.fast;
	if (!icon) return PRIORITY_TIER_LABEL;
	return compact ? icon : `${icon} ${PRIORITY_TIER_LABEL}`;
}

/** Cells in the compact goal progress bar (verbose mode only). */
const GOAL_BAR_WIDTH = 8;
/** Spinner advances one frame per this many active-ms (steady when idle/paused). */
const GOAL_SPINNER_PERIOD_MS = 120;
/** Recolor to warning once the goal has burned this fraction of its token budget. */
const GOAL_NEAR_BUDGET_FRACTION = 0.9;

/** Compact filled/empty unicode bar for a 0..1 fraction (clamped). */
export function goalProgressBar(fraction: number): string {
	const clamped = clamp01(fraction);
	const filled = Math.round(clamped * GOAL_BAR_WIDTH);
	return `${"▰".repeat(filled)}${"▱".repeat(GOAL_BAR_WIDTH - filled)}`;
}

function formatGoalProgress(tokensUsed: number, tokenBudget: number | undefined, verbose: boolean): string {
	const used = formatNumber(tokensUsed);
	if (typeof tokenBudget !== "number" || tokenBudget <= 0) return used;
	const fraction = tokensUsed / tokenBudget;
	const percent = `${Math.min(999, Math.round(fraction * 100))}%`;
	const base = `${used}/${formatNumber(tokenBudget)} ${percent}`;
	return verbose ? `${base} ${goalProgressBar(fraction)}` : base;
}

function goalSpinnerIcon(activeMs: number): string {
	const frames = theme.spinnerFrames;
	if (frames.length === 0) return theme.icon.goal;
	const idx = Math.floor(Math.max(0, activeMs) / GOAL_SPINNER_PERIOD_MS) % frames.length;
	return frames[idx] ?? theme.icon.goal;
}

function renderGoalMode(ctx: SegmentContext, mode: { enabled: boolean; paused: boolean }): string {
	const goal = ctx.session.getGoalModeState()?.goal;
	const persistedStatus = goal?.status ?? (mode.paused ? "paused" : "active");

	let icon: string = theme.icon.goal;
	let color: ThemeColor = MODE_ACCENT;
	switch (persistedStatus) {
		case "paused":
			icon = theme.icon.pause || theme.symbol("status.pending");
			color = "warning";
			break;
		case "complete":
			icon = theme.symbol("status.success");
			color = "success";
			break;
		case "budget-limited":
			icon = theme.symbol("status.warning");
			color = "warning";
			break;
		case "dropped":
			icon = theme.symbol("status.aborted");
			color = "dim";
			break;
		default:
			break;
	}

	const tokensUsed = goal?.tokensUsed ?? 0;
	const tokenBudget = goal?.tokenBudget;
	const running = persistedStatus === "active";

	const nearBudget =
		typeof tokenBudget === "number" && tokenBudget > 0 && tokensUsed >= tokenBudget * GOAL_NEAR_BUDGET_FRACTION;
	if (running && nearBudget) color = "warning";

	if (running && ctx.session.isStreaming) icon = goalSpinnerIcon(ctx.activeMs);

	const verbose = ctx.session.settings?.get?.("goal.statusInFooter") === true;
	const parts: string[] = [withIcon(icon, "Goal")];
	if (goal) parts.push(formatGoalProgress(tokensUsed, tokenBudget, verbose));
	return theme.fg(color, parts.join(" "));
}

/**
 * One base mode the segment can be in, and how it renders when it is.
 *
 * The modes are MUTUALLY EXCLUSIVE and this list is their priority order: the
 * first entry that returns text wins.
 */
interface BaseModeState {
	readonly id: string;
	render(ctx: SegmentContext): string;
}

export const BASE_MODE_STATES: readonly BaseModeState[] = [
	{
		id: "prewalk",
		render(ctx) {
			if (!ctx.prewalk?.enabled) return "";
			return theme.fg(MODE_ACCENT, withIcon(theme.icon.prewalk, "Prewalk"));
		},
	},
	{
		id: "goal",
		render(ctx) {
			const goal = ctx.goalMode;
			if (!goal || !(goal.enabled || goal.paused)) return "";
			return renderGoalMode(ctx, goal);
		},
	},
	{
		id: "loop",
		render(ctx) {
			if (!ctx.loopMode?.enabled) return "";
			return theme.fg(MODE_ACCENT, withIcon(theme.icon.loop, "Loop"));
		},
	},
];

/** The active mode label (prewalk/goal/loop). */
function renderBaseMode(ctx: SegmentContext): string {
	for (const mode of BASE_MODE_STATES) {
		const content = mode.render(ctx);
		if (content !== "") return content;
	}
	return "";
}

const modeSegment: StatusLineSegment = {
	id: "mode",
	render(ctx) {
		const content = renderBaseMode(ctx);
		if (content === "") return { content: "", visible: false };
		return { content, visible: true };
	},
};

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};
		const stripPrefix = opts.stripWorkPrefix !== false;

		if (stripPrefix && ctx.worktree) {
			const { projectName, worktreeName } = ctx.worktree;
			const label = ctx.git.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
			const content = withIcon(theme.icon.worktree, clampPathLength(label, opts.maxLength ?? 40));
			return { content: theme.fg("statusLinePath", content), visible: true };
		}

		const projectDir = ctx.session.sessionManager?.getCwd?.() ?? ctx.activeRepo?.cwd ?? getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (stripPrefix) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd);
			}
		}
		const repoSuffix = ctx.activeRepo ? ` ↳ ${ctx.activeRepo.relativeRepoRoot}` : "";
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		pwd = clampPathLength(pwd, opts.maxLength ?? 40);
		if (repoSuffix) {
			pwd = `${pwd}${repoSuffix}`;
		}

		const showScratchIcon = scratch && stripPrefix;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, pwd);
		return { content: theme.fg("statusLinePath", content), visible: true };
	},
};

const gitSegment: StatusLineSegment = {
	id: "git",
	render(ctx) {
		const { branch, status } = ctx.git;
		if (!branch && !status) return { content: "", visible: false };

		const opts = ctx.options.git ?? {};
		const gitStatus = status;
		const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);

		const showBranch = opts.showBranch !== false;
		let content = "";
		if (showBranch && branch) {
			content = withIcon(theme.icon.branch, branch);
		}

		// Branch plus one bare dirty marker; the star carries its own hue so it
		// reads against the branch label.
		if (isDirty) content = `${content} ${theme.fg("statusLineDirty", "*")}`;

		const colorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";
		return { content: theme.fg(colorName, content), visible: true };
	},
};

const prSegment: StatusLineSegment = {
	id: "pr",
	render(ctx) {
		const { pr } = ctx.git;
		if (!pr) return { content: "", visible: false };

		const label = withIcon(theme.icon.pr, `#${pr.number}`);
		const content = TERMINAL.hyperlinks ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07` : label;
		return { content: theme.fg("accent", content), visible: true };
	},
};

const subagentsSegment: StatusLineSegment = {
	id: "subagents",
	render(ctx) {
		if (ctx.subagentCount === 0) {
			return { content: "", visible: false };
		}
		const content = withIcon(theme.icon.agents, `${ctx.subagentCount}`);
		return { content: theme.fg("statusLineSubagents", content), visible: true };
	},
};

const tokenInSegment: StatusLineSegment = {
	id: "token_in",
	render(ctx) {
		const { input } = ctx.usageStats;
		if (!input) return { content: "", visible: false };

		const content = withIcon(theme.icon.input, formatNumber(input));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenOutSegment: StatusLineSegment = {
	id: "token_out",
	render(ctx) {
		const { output } = ctx.usageStats;
		if (!output) return { content: "", visible: false };

		const content = withIcon(theme.icon.output, formatNumber(output));
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const tokenTotalSegment: StatusLineSegment = {
	id: "token_total",
	render(ctx) {
		const { input, output, cacheWrite, orchestrationInput, orchestrationOutput } = ctx.usageStats;
		const total = input + output + cacheWrite + orchestrationInput + orchestrationOutput;
		if (!total) return { content: "", visible: false };

		const content = withIcon(theme.icon.tokens, formatNumber(total));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenRateSegment: StatusLineSegment = {
	id: "token_rate",
	render(ctx) {
		const { tokensPerSecond } = ctx.usageStats;
		if (!tokensPerSecond) return { content: "", visible: false };

		const content = withIcon(theme.icon.throughput, `${tokensPerSecond.toFixed(1)} tok/s`);
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const costSegment: StatusLineSegment = {
	id: "cost",
	render(ctx) {
		const { cost, premiumRequests } = ctx.usageStats;
		const normalizedPremiumRequests = normalizePremiumRequests(premiumRequests);
		const state = ctx.session.state;
		const usingSubscription = state.model ? (ctx.session.modelRegistry?.isUsingOAuth(state.model) ?? false) : false;

		if (!cost && !usingSubscription && !normalizedPremiumRequests) {
			return { content: "", visible: false };
		}

		const billingParts: string[] = [];
		if (cost) billingParts.push(`$${cost.toFixed(2)}`);
		if (normalizedPremiumRequests) billingParts.push(`* ${formatNumber(normalizedPremiumRequests)}`);
		if (usingSubscription) billingParts.push("(sub)");

		return { content: theme.fg("statusLineCost", billingParts.join(" ")), visible: true };
	},
};

/** The context bar's fixed cell count — small enough to whisper, wide enough
 *  that one cell is a meaningful 12.5% step. */
const CONTEXT_BAR_CELLS = 8;
/** Live-tip pulse cadence; past the error threshold the pulse doubles — the
 *  bar visibly quickens as compaction nears. */
const CONTEXT_BAR_TIP_STEP_MS = 1000;
const CONTEXT_BAR_TIP_STEP_URGENT_MS = 500;

/**
 * The draining context bar: `▰▰▰▰▰▰▱▱` — one filled cell per eighth of the room
 * still available, in the usage-level hue, spent cells dim. The caller passes
 * REMAINING room, so the bar empties as the session grows.
 */
export function renderContextBar(ratio: number, level: ContextUsageLevel, nowMs: number, live: boolean): string {
	const clamped = clamp01(Number.isFinite(ratio) ? ratio : 0);
	const filled = Math.min(CONTEXT_BAR_CELLS, Math.round(clamped * CONTEXT_BAR_CELLS));
	const levelColor = getContextUsageThemeColor(level);
	let bar = "";
	for (let cell = 0; cell < CONTEXT_BAR_CELLS; cell++) {
		if (live && cell === filled - 1) {
			const stepMs = level === "error" ? CONTEXT_BAR_TIP_STEP_URGENT_MS : CONTEXT_BAR_TIP_STEP_MS;
			const tipOn = Math.floor(nowMs / stepMs) % 2 === 0;
			bar += tipOn ? theme.fg(levelColor, "▰") : theme.fg("dim", "▱");
		} else if (cell < filled) {
			bar += theme.fg(levelColor, "▰");
		} else {
			bar += theme.fg("dim", "▱");
		}
	}
	return bar;
}

/**
 * The room-left gauge. It measures against {@link SegmentContext.contextLimit} —
 * the auto-compaction trigger when auto-compaction is on, the model's window
 * otherwise. The window itself belongs to {@link contextTotalSegment}.
 */
const contextPctSegment: StatusLineSegment = {
	id: "context_pct",
	render(ctx) {
		const pct = ctx.contextPercent;
		const level = getContextUsageLevel(pct);
		const remainingRatio = pct === null || pct === undefined ? 1 : Math.max(0, 100 - pct) / 100;
		const bar = renderContextBar(remainingRatio, level, Date.now(), ctx.session.isStreaming);
		const pctText = formatContextRemainingPercent(pct);
		return {
			content: `${bar} ${theme.fg(getContextUsageThemeColor(level), pctText)}`,
			visible: true,
		};
	},
};

/** The model's context window, and only ever that. */
const contextTotalSegment: StatusLineSegment = {
	id: "context_total",
	render(ctx) {
		const window = ctx.contextWindow;
		if (!window) return { content: "", visible: false };
		return {
			content: theme.fg("statusLineContext", withIcon(theme.icon.context, formatNumber(window))),
			visible: true,
		};
	},
};

/** Total time the agent was actively processing this session. Hidden before
 *  the first second of activity to avoid flashing `0s` at session start. */
const timeSpentSegment: StatusLineSegment = {
	id: "time_spent",
	render(ctx) {
		if (ctx.activeMs < 1000) return { content: "", visible: false };
		return { content: withIcon(theme.icon.time, formatDuration(ctx.activeMs)), visible: true };
	},
};

const timeSegment: StatusLineSegment = {
	id: "time",
	render(ctx) {
		const opts = ctx.options.time ?? {};
		const now = new Date();

		let hours = now.getHours();
		let suffix = "";
		if (opts.format === "12h") {
			suffix = hours >= 12 ? "pm" : "am";
			hours = hours % 12 || 12;
		}

		const mins = now.getMinutes().toString().padStart(2, "0");
		let timeStr = `${hours}:${mins}`;
		if (opts.showSeconds) {
			timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
		}
		timeStr += suffix;

		return { content: withIcon(theme.icon.time, timeStr), visible: true };
	},
};

const sessionSegment: StatusLineSegment = {
	id: "session",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		const display = sessionId?.slice(0, 8) || "new";

		return { content: theme.fg(SESSION_ACCENT, withIcon(theme.icon.session, display)), visible: true };
	},
};

const hostnameSegment: StatusLineSegment = {
	id: "hostname",
	render(_ctx) {
		const name = os.hostname().split(".")[0];
		return { content: withIcon(theme.icon.host, name), visible: true };
	},
};

const accountSegment: StatusLineSegment = {
	id: "account",
	render(ctx) {
		const account = ctx.account;
		if (!account || account.storedCount < 2) return { content: "", visible: false };
		const label = truncateToWidth(sanitizeStatusText(account.label), TRUNCATE_LENGTHS.SHORT);
		if (!label) return { content: "", visible: false };
		const prefix = account.isPrediction ? "next" : "as";
		return { content: theme.fg("muted", `${prefix} ${label}`), visible: true };
	},
};

const cacheReadSegment: StatusLineSegment = {
	id: "cache_read",
	render(ctx) {
		const { cacheRead } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheRead)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheWrite)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const cacheHitSegment: StatusLineSegment = {
	id: "cache_hit",
	render(ctx) {
		const { cacheRead, cacheWrite, input } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		// Hit rate = cacheRead / total prompt tokens. Including uncached input
		// keeps the denominator honest for Anthropic/OpenRouter; DeepSeek reports
		// its miss as input with cacheWrite 0, so this still yields hit/(hit+miss).
		const total = cacheRead + cacheWrite + input;

		const rate = (cacheRead / total) * 100;
		const rateStr = rate.toFixed(2);

		const parts: string[] = [theme.icon.cache];
		parts.push(theme.fg("statusLineSpend", `${rateStr}%`));
		return { content: parts.join(" "), visible: true };
	},
};

const sessionNameSegment: StatusLineSegment = {
	id: "session_name",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const name = sessionManager?.getSessionName() ?? ctx.previewTitle;
		if (!name) return { content: "", visible: false };
		const ansi =
			getSessionAccentAnsi(
				getSessionAccentHex(name, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
			) ?? theme.getFgAnsi("accent");
		// Clamp: auto-generated titles are sentence-length and an unclamped chip
		// dominates the shared footline.
		const label = truncateToWidth(sanitizeStatusText(name), TRUNCATE_LENGTHS.SHORT);
		return { content: `${ansi}${label}\x1b[39m`, visible: true };
	},
};

function pickUsageColor(percent: number): "muted" | "warning" | "error" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// total minutes (5h window: max 300)
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const usageSegment: StatusLineSegment = {
	id: "usage",
	render(ctx) {
		const u = ctx.usage;
		if (!u || (!u.fiveHour && !u.sevenDay)) {
			return { content: "", visible: false };
		}
		const parts: string[] = [];
		if (u.tier) {
			const tier = truncateToWidth(sanitizeStatusText(u.tier), TRUNCATE_LENGTHS.SHORT);
			if (tier) parts.push(theme.fg("accent", tier));
		}
		if (u.fiveHour) {
			const pct = u.fiveHour.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.fiveHour.resetMinutes !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.fiveHour.resetMinutes, "m")})`)
					: "";
			parts.push(`5h ${pctText}${reset}`);
		}
		if (u.sevenDay) {
			const pct = u.sevenDay.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.sevenDay.resetHours !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.sevenDay.resetHours, "h")})`)
					: "";
			parts.push(`7d ${pctText}${reset}`);
		}
		const content = withIcon(theme.icon.time, parts.join(theme.sep.dot));
		return { content, visible: true };
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	pi: piSegment,
	model: modelSegment,
	account: accountSegment,
	mode: modeSegment,
	path: pathSegment,
	git: gitSegment,
	pr: prSegment,
	subagents: subagentsSegment,
	token_in: tokenInSegment,
	token_out: tokenOutSegment,
	token_total: tokenTotalSegment,
	token_rate: tokenRateSegment,
	cost: costSegment,
	context_pct: contextPctSegment,
	context_total: contextTotalSegment,
	time_spent: timeSpentSegment,
	time: timeSegment,
	session: sessionSegment,
	hostname: hostnameSegment,
	cache_read: cacheReadSegment,
	cache_write: cacheWriteSegment,
	cache_hit: cacheHitSegment,
	session_name: sessionNameSegment,
	usage: usageSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const segment = SEGMENTS[id];
	if (!segment) {
		return { content: "", visible: false };
	}
	return segment.render(ctx);
}

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = Object.keys(SEGMENTS) as StatusLineSegmentId[];
