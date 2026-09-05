import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { Goal, GoalModeState } from "../goals/state";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../session/session-entries";
import type { TodoItem } from "../tools/todo";

export interface SessionStartEvent {
	type: "session_start";
}

export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";

	reason: "new" | "resume" | "fork";

	targetSessionFile?: string;
}

export interface SessionSwitchEvent {
	type: "session_switch";

	reason: "new" | "resume" | "fork";

	previousSessionFile: string | undefined;
}

export interface SessionBeforeBranchEvent {
	type: "session_before_branch";

	entryId: string;
}

export interface SessionBranchEvent {
	type: "session_branch";
	previousSessionFile: string | undefined;
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";

	preparation: CompactionPreparation;

	branchEntries: SessionEntry[];

	customInstructions?: string;

	signal: AbortSignal;
}

export interface SessionCompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: AgentMessage[];
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;

	fromExtension: boolean;
}

export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow" | "idle" | "incomplete";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
}

export interface SessionStopEvent {
	type: "session_stop";
	messages: AgentMessage[];
	turn_id: number;
	last_assistant_message?: AgentMessage;
	session_id: string;
	session_file?: string;
	stop_hook_active: boolean;

	signal: AbortSignal;
}

export interface TreePreparation {
	targetId: string;

	oldLeafId: string | null;

	commonAncestorId: string | null;

	entriesToSummarize: SessionEntry[];

	userWantsSummary: boolean;
}

export interface SessionBeforeTreeEvent {
	type: "session_before_tree";

	preparation: TreePreparation;

	signal: AbortSignal;
}

export interface SessionTreeEvent {
	type: "session_tree";

	newLeafId: string | null;

	oldLeafId: string | null;

	summaryEntry?: BranchSummaryEntry;

	fromExtension?: boolean;
}

export interface GoalUpdatedEvent {
	type: "goal_updated";
	goal: Goal | null;
	state?: GoalModeState;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeBranchEvent
	| SessionBranchEvent
	| SessionBeforeCompactEvent
	| SessionCompactingEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionStopEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| GoalUpdatedEvent;

export interface ContextEvent {
	type: "context";

	messages: AgentMessage[];
}

export interface AgentStartEvent {
	type: "agent_start";
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];

	willContinue?: boolean;
}

export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "remote";
}

export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: "context-full" | "remote";
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;

	skipped?: boolean;
}

export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	errorId?: number;
}

export interface RetryErrorUpdate {
	entryId: string;
	persistenceKey?: string;
	note: string;
	retryRecovery: AssistantRetryRecovery;
}

export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
	retryErrors?: RetryErrorUpdate[];
}

export interface RetryFallbackAppliedEvent {
	type: "retry_fallback_applied";
	from: string;
	to: string;
	role: string;
}

export interface RetryFallbackSucceededEvent {
	type: "retry_fallback_succeeded";
	model: string;
	role: string;
}

export interface TtsrTriggeredEvent {
	type: "ttsr_triggered";
	rules: Rule[];
}

export interface TodoReminderEvent {
	type: "todo_reminder";
	todos: TodoItem[];
	attempt: number;
	maxAttempts: number;
}

export interface ToolCallEventResult {
	block?: boolean;

	reason?: string;

	input?: Record<string, unknown>;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];

	details?: unknown;

	isError?: boolean;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeBranchResult {
	cancel?: boolean;

	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;

	compaction?: CompactionResult;
}

export interface SessionCompactingResult {
	context?: string[];

	prompt?: string;

	preserveData?: Record<string, unknown>;
}

export interface SessionStopEventResult {
	continue?: boolean;

	additionalContext?: string;

	decision?: "block";

	reason?: string;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;

	summary?: {
		summary: string;
		details?: unknown;
	};
}
