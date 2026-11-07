import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Rule } from "../capability/rule";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal, GoalModeState } from "../goals/state";
import type { ChecklistItem } from "../tools/checklist";
import type { CacheWarmingRefreshEnd, CacheWarmingRefreshStart } from "./cache-warmer";
import type { CustomMessage } from "./messages";

export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| (Extract<AgentEvent, { type: "agent_end" }> & {
			isTerminal?: boolean;
	  })
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;

			skipped?: boolean;
	  }
	| { type: "manual_compaction_start"; mode?: string }
	| {
			type: "manual_compaction_end";
			result?: CompactionResult;
			aborted: boolean;
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| ({ type: "cache_warming_start" } & CacheWarmingRefreshStart)
	| ({ type: "cache_warming_end" } & CacheWarmingRefreshEnd)
	| { type: "model_changed" }
	| { type: "config_warnings_changed" }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "checklist_reminder"; items: ChecklistItem[]; attempt: number; maxAttempts: number }
	| { type: "checklist_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
