import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, MessageAttribution, ServiceTierByFamily, TextContent } from "@oh-my-pi/pi-ai";
import type { StructuredSubagentSchemaMode } from "../task/types";
import type { CompactionMethod } from "./compaction-methods";

export const CURRENT_SESSION_VERSION = 3;

export const SESSION_TITLE_SLOT_BYTES = 256;

export const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";

export const TITLE_CHANGE_ENTRY_TYPE = "title_change";

export type SessionTitleSource = "auto" | "user";

export interface SessionTitleSlotEntry {
	type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE;
	v: 1;
	title: string;
	source?: SessionTitleSource;
	updatedAt: string;
	pad: string;
}

export const EPHEMERAL_MODEL_CHANGE_ROLE = "fallback";

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	title?: string;
	titleSource?: SessionTitleSource;
	timestamp: string;
	cwd: string;

	additionalDirectories?: string[];
	parentSession?: string;

	previousSessionFiles?: string[];

	providerPromptCacheKey?: string;
}

export interface NewSessionOptions {
	parentSession?: string;

	providerPromptCacheKey?: string;

	additionalDirectories?: string[];
}

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

	configured?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";

	model: string;

	role?: string;

	resolvedModelIsFallback?: boolean;
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

	tokensAfter?: number;

	method?: CompactionMethod;

	providerReplayThroughEntryId?: string;

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

export interface ResetBoundaryEntry extends SessionEntryBase {
	type: "reset_boundary";
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
	type: typeof TITLE_CHANGE_ENTRY_TYPE;
	title: string;
	previousTitle?: string;
	source: SessionTitleSource;
	trigger?: string;
}

declare module "@oh-my-pi/pi-agent-core/compaction/entries" {
	interface CustomCompactionSessionEntries {
		titleChange: TitleChangeEntry;
		credentialPin: CredentialPinEntry;
	}
}

export interface TtsrInjectionEntry extends SessionEntryBase {
	type: "ttsr_injection";

	injectedRules: string[];
}

export interface CredentialPinEntry extends SessionEntryBase {
	type: "credential_pin";

	provider: string;

	hash: string;
}

export interface SessionInitEntry extends SessionEntryBase {
	type: "session_init";

	systemPrompt: string;

	task: string;

	tools: string[];

	agent?: string;

	modelRole?: string;

	resolvedModel?: string;

	readOnly?: boolean;

	outputSchema?: unknown;

	outputSchemaMode?: StructuredSubagentSchemaMode;

	restrictToolNames?: boolean;

	spawns?: string;

	readSummarize?: boolean;

	advisor?: string;
}

export interface ModeChangeEntry extends SessionEntryBase {
	type: "mode_change";

	mode: string;

	data?: Record<string, unknown>;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;

	attribution?: MessageAttribution;
}

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
	| CredentialPinEntry
	| ResetBoundaryEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type RawFileEntry = SessionTitleSlotEntry | FileEntry;

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];

	label?: string;
}

export interface UsageStatistics {
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
}
