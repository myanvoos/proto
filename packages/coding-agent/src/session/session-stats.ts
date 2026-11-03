import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	calculatePromptTokens,
	findTranscriptUsageAnchor,
	isTranscriptUsageAnchor,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { ContextUsage } from "../extensibility/extensions/types";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	type NonMessageTokenSource,
} from "../modes/utils/context-usage";
import type { ContextUsageBreakdown, SessionStats } from "./agent-session-types";
import type { SessionEntry, SessionMessageEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

interface NonMessageSnapshot {
	nonMessageTokens: number;
	toolSchemaTokens?: number;
}

interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;
	toolSchemaTokens: number;
	cutoffCount: number;

	epoch: number;
}

export interface SessionStatsTrackerHost {
	session: NonMessageTokenSource;
	agent: Agent;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	model(): Model | undefined;
	sessionId(): string;
}

interface ContextBranchCache {
	entries: readonly SessionEntry[];
	observedLength: number;
	latestAnchor: SessionMessageEntry | undefined;
}

function correctedPromptTokens(assistant: AssistantMessage): number {
	const providerPromptTokens = assistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(assistant.usage);
	return Math.max(0, providerPromptTokens - (assistant.contextSnapshot?.historyRewriteTokensRemoved ?? 0));
}

export class SessionStatsTracker {
	readonly #host: SessionStatsTrackerHost;
	#pendingContextSnapshot: PendingContextSnapshot | undefined;
	#contextUsageRevision = 0;
	#compactionEpoch = 0;
	#contextBranchCache: ContextBranchCache | undefined;

	constructor(host: SessionStatsTrackerHost) {
		this.#host = host;
	}

	get #tokenizer() {
		return this.#host.agent.tokenizer;
	}

	#anchoredUsedTokens(
		base: number,
		anchor: NonMessageSnapshot,
		current: Required<NonMessageSnapshot>,
		tailFromIndex: number,
		activeMessages: readonly AgentMessage[],
		pendingTokens: number,
	): number {
		const delta =
			anchor.toolSchemaTokens === undefined
				? Math.max(0, current.nonMessageTokens - anchor.nonMessageTokens)
				: Math.max(
						0,
						current.nonMessageTokens -
							current.toolSchemaTokens -
							(anchor.nonMessageTokens - anchor.toolSchemaTokens),
					) +
					current.toolSchemaTokens -
					anchor.toolSchemaTokens;
		return (
			Math.max(0, base + delta) + this.#tokenizer.countMessages(activeMessages.slice(tailFromIndex)) + pendingTokens
		);
	}

	#contextBranch(): ContextBranchCache {
		const entries = this.#host.sessionManager.getBranchForStats();
		const cached = this.#contextBranchCache;
		// setLeaf/clear/rebuild replace the path; insert appends only when it extends the current leaf.
		if (cached?.entries === entries && entries.length >= cached.observedLength) {
			for (let index = cached.observedLength; index < entries.length; index++) {
				const entry = entries[index];
				if (entry.type === "compaction") {
					cached.latestAnchor = undefined;
				} else if (entry.type === "message" && isTranscriptUsageAnchor(entry.message)) {
					cached.latestAnchor = entry;
				}
			}
			cached.observedLength = entries.length;
			return cached;
		}

		let latestAnchor: SessionMessageEntry | undefined;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.type === "compaction") {
				latestAnchor = undefined;
			} else if (entry.type === "message" && isTranscriptUsageAnchor(entry.message)) {
				latestAnchor = entry;
			}
		}
		const next: ContextBranchCache = {
			entries,
			observedLength: entries.length,
			latestAnchor,
		};
		this.#contextBranchCache = next;
		return next;
	}

	getSessionStats(): SessionStats {
		const state = this.#host.agent.state;
		const userMessages = state.messages.filter(message => message.role === "user").length;
		const assistantMessages = state.messages.filter(message => message.role === "assistant").length;
		const toolResults = state.messages.filter(message => message.role === "toolResult").length;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalReasoning = 0;
		let totalCacheWrite = 0;
		let totalTokens = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;
		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistant = message;
				toolCalls += assistant.content.filter(content => content.type === "toolCall").length;
				// Persisted and imported transcripts can predate usage metadata.
				const usage = assistant.usage;
				if (!usage) continue;
				totalInput += usage.input;
				totalOutput += usage.output;
				totalReasoning += usage.reasoningTokens ?? 0;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalTokens += usage.totalTokens;
				totalPremiumRequests += usage.premiumRequests ?? 0;
				totalCost += usage.cost.total;
			}
		}
		return {
			sessionFile: this.#host.sessionManager.getSessionFile(),
			sessionId: this.#host.sessionId(),
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				reasoning: totalReasoning,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalTokens,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
			subagents: this.#host.sessionManager.getSubagentUsage(),
			contextUsage: this.getContextUsage(),
		};
	}

	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const rawContextWindow = options?.contextWindow ?? this.#host.model()?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;
		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(
			this.#host.session,
			this.#tokenizer,
		);
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const current = {
			nonMessageTokens: computeNonMessageTokens(this.#host.session, this.#tokenizer),
			toolSchemaTokens: toolsTokens,
		};
		const { entries: branchEntries, latestAnchor } = this.#contextBranch();
		let usedTokens = 0;
		let anchored = false;
		const pendingMessages = options?.pendingMessages ?? [];
		const pendingTokens = this.#tokenizer.countMessages(pendingMessages);
		const pending = this.#pendingContextSnapshot;

		const anchorEntry = latestAnchor;

		const activeMessages = this.#host.agent.state.messages;
		let anchorIndex = -1;
		let anchorAssistant: AssistantMessage | undefined;
		if (anchorEntry?.message.role === "assistant") {
			const assistant = anchorEntry.message;
			anchorAssistant = assistant;
			anchorIndex = activeMessages.indexOf(assistant);
			if (anchorIndex === -1) {
				anchorIndex = activeMessages.findIndex(
					message => message.role === "assistant" && message.timestamp === assistant.timestamp,
				);
			}
		}

		const anchorEpoch = anchorAssistant?.contextSnapshot?.compactionEpoch ?? 0;
		const useAnchor =
			anchorAssistant !== undefined &&
			anchorIndex !== -1 &&
			(!pending || (anchorIndex >= pending.cutoffCount && anchorEpoch >= pending.epoch));
		if (useAnchor && anchorAssistant) {
			anchored = true;
			usedTokens = this.#anchoredUsedTokens(
				correctedPromptTokens(anchorAssistant),
				anchorAssistant.contextSnapshot ?? current,
				current,
				anchorIndex + 1,
				activeMessages,
				pendingTokens,
			);
		} else if (pending) {
			anchored = true;
			usedTokens = this.#anchoredUsedTokens(
				pending.promptTokens,
				pending,
				current,
				pending.cutoffCount,
				activeMessages,
				pendingTokens,
			);
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			const liveAnchor = findTranscriptUsageAnchor(activeMessages);
			if (liveAnchor) {
				usedTokens = this.#anchoredUsedTokens(
					correctedPromptTokens(liveAnchor.message),
					liveAnchor.message.contextSnapshot ?? current,
					current,
					liveAnchor.index + 1,
					activeMessages,
					pendingTokens,
				);
				anchored = true;
			}
		}
		if (!anchored) {
			usedTokens = current.nonMessageTokens + this.#tokenizer.countMessages(activeMessages) + pendingTokens;
		}
		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens: Math.max(0, usedTokens - categoryNonMessageTokens),
		};
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const breakdown = this.getContextBreakdown(options);
		if (!breakdown) return undefined;
		return {
			tokens: breakdown.usedTokens,
			contextWindow: breakdown.contextWindow,
			percent: breakdown.contextWindow > 0 ? (breakdown.usedTokens / breakdown.contextWindow) * 100 : 0,
		};
	}

	get revision(): number {
		return this.#contextUsageRevision;
	}

	get compactionEpoch(): number {
		return this.#compactionEpoch;
	}

	/** Accounting captured with the active request, not a later model's schema policy. */
	nonMessageSnapshot(): Required<NonMessageSnapshot> {
		const pending = this.#pendingContextSnapshot;
		return pending
			? { nonMessageTokens: pending.nonMessageTokens, toolSchemaTokens: pending.toolSchemaTokens }
			: this.#currentNonMessageSnapshot();
	}

	#currentNonMessageSnapshot(): Required<NonMessageSnapshot> {
		return {
			nonMessageTokens: computeNonMessageTokens(this.#host.session, this.#tokenizer),
			toolSchemaTokens: computeNonMessageBreakdown(this.#host.session, this.#tokenizer).toolsTokens,
		};
	}

	recordAnchoredHistoryRewrite(tokensRemoved: number): void {
		if (!Number.isFinite(tokensRemoved) || tokensRemoved <= 0) return;

		const { latestAnchor } = this.#contextBranch();
		if (!latestAnchor) return;
		const materialized = this.#host.sessionManager.getEntry(latestAnchor.id);
		const candidate = materialized?.type === "message" ? materialized.message : latestAnchor.message;
		if (!isTranscriptUsageAnchor(candidate)) return;
		const assistant = candidate;
		if (this.#contextBranchCache?.latestAnchor === latestAnchor && materialized?.type === "message") {
			this.#contextBranchCache.latestAnchor = materialized;
		}

		if (!assistant.contextSnapshot) {
			assistant.contextSnapshot = {
				promptTokens: calculatePromptTokens(assistant.usage),
				...this.#currentNonMessageSnapshot(),
				compactionEpoch: this.#compactionEpoch,
			};
		}
		const snapshot = assistant.contextSnapshot;
		snapshot.historyRewriteTokensRemoved = (snapshot.historyRewriteTokensRemoved ?? 0) + Math.floor(tokensRemoved);
		this.#contextUsageRevision++;
	}

	setPendingSnapshot(snapshot: Omit<PendingContextSnapshot, "epoch" | "toolSchemaTokens"> | undefined): void {
		this.#pendingContextSnapshot = snapshot
			? {
					...snapshot,
					toolSchemaTokens: computeNonMessageBreakdown(this.#host.session, this.#tokenizer).toolsTokens,
					epoch: this.#compactionEpoch,
				}
			: undefined;
		this.#contextUsageRevision++;
	}

	rebaseAfterCompaction(): void {
		this.#compactionEpoch++;
		if (!this.#pendingContextSnapshot) return;
		const nonMessageTokens = computeNonMessageTokens(this.#host.session, this.#tokenizer);
		const messages = this.#host.agent.state.messages;
		this.setPendingSnapshot({
			promptTokens: nonMessageTokens + this.#tokenizer.countMessages(messages),
			nonMessageTokens,
			cutoffCount: messages.length,
		});
	}

	ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		const provider = model?.provider;
		if (!provider) return;
		this.#host.modelRegistry.authStorage.ingestUsageHeaders(provider, response.headers, {
			sessionId: this.#host.agent.sessionId,
			baseUrl: this.#host.modelRegistry.getProviderBaseUrl?.(provider),
			responseStatus: response.status,
		});
	}
}
export function sumAssistantMessageUsage(messages: readonly AgentMessage[]): {
	input: number;
	output: number;
	totalTokens: number;
	cost: number;
	toolCalls: number;
} {
	let input = 0;
	let output = 0;
	let totalTokens = 0;
	let cost = 0;
	let toolCalls = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		toolCalls += assistant.content.filter(content => content.type === "toolCall").length;
		input += assistant.usage?.input ?? 0;
		output += assistant.usage?.output ?? 0;
		totalTokens += assistant.usage?.totalTokens ?? 0;
		cost += assistant.usage?.cost?.total ?? 0;
	}
	return { input, output, totalTokens, cost, toolCalls };
}
