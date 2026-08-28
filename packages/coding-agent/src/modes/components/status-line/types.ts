import type { StatusLineSegmentId, StatusLineSeparatorStyle } from "../../../config/settings-schema";
import type { AgentSession } from "../../../session/agent-session";
import type { ActiveRepoContext } from "../../../utils/active-repo-context";
import type { GitStatusSummary } from "../../../utils/git";

export type { StatusLineSegmentId, StatusLineSeparatorStyle };

export interface StatusLineSegmentOptions {
	model?: {
		showThinkingLevel?: boolean;
	};
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];

	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;

	transparent?: boolean;

	compactThinkingLevel?: boolean;
}

export type EffectiveStatusLineSettings = Required<
	Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "segmentOptions">
> &
	StatusLineSettings;

export type RGB = readonly [number, number, number];

export interface SegmentContext {
	session: AgentSession;

	focusedAgentId?: string | undefined;

	previewTitle?: string;
	activeRepo: ActiveRepoContext | null;
	width: number;
	options: StatusLineSegmentOptions;

	compactThinkingLevel: boolean;
	prewalk: {
		enabled: boolean;
	} | null;
	loopMode: {
		enabled: boolean;
	} | null;
	goalMode: {
		enabled: boolean;
		paused: boolean;
	} | null;

	usageStats: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		orchestrationInput: number;
		orchestrationOutput: number;
		orchestrationCacheRead: number;
		premiumRequests: number;
		cost: number;
		tokensPerSecond: number | null;
	};

	contextPercent: number | null;

	contextWindow: number;

	contextLimit: number;
	contextLimitKind: "window" | "compaction";
	autoCompactEnabled: boolean;
	subagentCount: number;

	activeMs: number;
	git: {
		branch: string | null;
		status: GitStatusSummary | null;
		pr: { number: number; url: string } | null;
	};

	worktree: { projectName: string; worktreeName: string } | null;

	account: { label: string; storedCount: number; isPrediction: boolean } | null;
	usage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null;
}

export interface RenderedSegment {
	content: string;
	visible: boolean;
}

export interface StatusLineSegment {
	id: StatusLineSegmentId;
	render(ctx: SegmentContext): RenderedSegment;
}
