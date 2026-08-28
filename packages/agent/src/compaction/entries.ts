import type { ImageContent, MessageAttribution, ServiceTierByFamily, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "../types";

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";

	model: string;

	role?: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTierByFamily | null;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;

	details?: T;

	preserveData?: Record<string, unknown>;

	fromExtension?: boolean;

	warning?: string;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;

	details?: T;

	fromExtension?: boolean;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;

	attribution?: MessageAttribution;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface TitleChangeEntry extends SessionEntryBase {
	type: "title_change";
	title: string;
	previousTitle?: string;
	source: "auto" | "user";
	trigger?: string;
}

export interface TtsrInjectionEntry extends SessionEntryBase {
	type: "ttsr_injection";

	injectedRules: string[];
}

export interface SessionInitEntry extends SessionEntryBase {
	type: "session_init";

	systemPrompt: string;

	task: string;

	tools: string[];

	outputSchema?: unknown;
}

export interface ModeChangeEntry extends SessionEntryBase {
	type: "mode_change";

	mode: string;

	data?: Record<string, unknown>;
}

export interface ResetBoundaryEntry extends SessionEntryBase {
	type: "reset_boundary";
}

export interface CustomCompactionSessionEntries {}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ServiceTierChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| TitleChangeEntry
	| TtsrInjectionEntry
	| SessionInitEntry
	| ModeChangeEntry
	| ResetBoundaryEntry
	| CustomCompactionSessionEntries[keyof CustomCompactionSessionEntries];

export interface ReadonlySessionManager {
	getBranch(leafId?: string | null): SessionEntry[];
	getEntry(id: string): SessionEntry | undefined;
}
