import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, MessageAttribution, ServiceTierByFamily, TextContent, Usage } from "@oh-my-pi/pi-ai";
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

	modelOverride?: string;

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

	/** Spend of the subagents this session owns; excluded from the fields above. */
	subagent: SubagentUsageTotals;
}

export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests: number;
	cost: number;

	/** Distinct subagents that reported usage. */
	agents: number;

	/** Settled subagent runs that reported usage. */
	runs: number;
}

export function emptySubagentUsageTotals(): SubagentUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		premiumRequests: 0,
		cost: 0,
		agents: 0,
		runs: 0,
	};
}

export function emptyUsageStatistics(): UsageStatistics {
	return {
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
		subagent: emptySubagentUsageTotals(),
	};
}

/**
 * Subagents keep their own transcripts, so their spend is invisible to an owning session that only
 * sums its own messages. Each settled subagent run appends one of these entries to the owner, which
 * makes the rollup durable: reopening the session replays the same totals.
 */
export const SUBAGENT_USAGE_CUSTOM_TYPE = "subagent_usage";

const SUBAGENT_USAGE_VERSION = 1;

export interface SubagentUsageEntryData {
	version: typeof SUBAGENT_USAGE_VERSION;

	/** Immutable agent id the spend is attributed to. */
	agentId: string;

	agent?: string;

	label?: string;

	/** Worker turn this run settled, when the subagent is a persistent worker. */
	turn?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests: number;
	cost: number;
}

export function buildSubagentUsageEntryData(args: {
	agentId: string;
	agent?: string;
	label?: string;
	turn?: number;
	usage: Usage;
}): SubagentUsageEntryData {
	const { usage } = args;
	return {
		version: SUBAGENT_USAGE_VERSION,
		agentId: args.agentId,
		...(args.agent ? { agent: args.agent } : {}),
		...(args.label ? { label: args.label } : {}),
		...(args.turn !== undefined ? { turn: args.turn } : {}),
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		premiumRequests: usage.premiumRequests ?? 0,
		cost: usage.cost.total,
	};
}

function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseSubagentUsageEntry(data: unknown): SubagentUsageEntryData | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== SUBAGENT_USAGE_VERSION) return undefined;
	if (typeof record.agentId !== "string" || !record.agentId) return undefined;
	return {
		version: SUBAGENT_USAGE_VERSION,
		agentId: record.agentId,
		...(typeof record.agent === "string" && record.agent ? { agent: record.agent } : {}),
		...(typeof record.label === "string" && record.label ? { label: record.label } : {}),
		...(typeof record.turn === "number" && Number.isFinite(record.turn) ? { turn: record.turn } : {}),
		input: finiteCount(record.input),
		output: finiteCount(record.output),
		cacheRead: finiteCount(record.cacheRead),
		cacheWrite: finiteCount(record.cacheWrite),
		totalTokens: finiteCount(record.totalTokens),
		premiumRequests: finiteCount(record.premiumRequests),
		cost: finiteCount(record.cost),
	};
}
