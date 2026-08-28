import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { coerceServiceTierByFamily, type ProviderPayload, type ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	isCustomMessageContent,
	normalizeCustomMessagePayload,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "./messages";
import { type CompactionEntry, EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";

const SUPERSEDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided after a newer compaction]";
const SUPERSEDED_COMPACTION_SHORT_SUMMARY = "Superseded compaction elided";

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;

	configuredThinkingLevel?: string;
	serviceTier?: ServiceTierByFamily;

	models: Record<string, string>;

	injectedTtsrRules: string[];

	mode: string;

	modeData?: Record<string, unknown>;

	cacheMissExplainedAt?: boolean[];
}

export function getRestorableSessionModels(
	models: Readonly<Record<string, string>>,
	lastModelChangeRole: string | undefined,
): string[] {
	const defaultModel = models.default;
	if (
		!lastModelChangeRole ||
		lastModelChangeRole === "default" ||
		lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE
	) {
		return defaultModel ? [defaultModel] : [];
	}

	const roleModel = models[lastModelChangeRole];
	if (!roleModel) return defaultModel ? [defaultModel] : [];
	if (!defaultModel || roleModel === defaultModel) return [roleModel];
	return [roleModel, defaultModel];
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export interface BuildSessionContextOptions {
	transcript?: boolean;

	collapseCompactedHistory?: boolean;

	keepDanglingToolCalls?: boolean;
}

export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

export function getOpenAiRemoteCompactionPayload(
	compaction: CompactionEntry | null | undefined,
): ProviderPayload | undefined {
	const candidate = compaction?.preserveData?.openaiRemoteCompaction;
	if (!candidate || typeof candidate !== "object") return undefined;
	const remote = candidate as { provider?: unknown; replacementHistory?: unknown };
	if (typeof remote.provider !== "string" || remote.provider.length === 0) return undefined;
	if (!Array.isArray(remote.replacementHistory)) return undefined;
	return {
		type: "openaiResponsesHistory",
		provider: remote.provider,
		items: remote.replacementHistory as Array<Record<string, unknown>>,
	};
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: BuildSessionContextOptions,
): SessionContext {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
	}

	const path: SessionEntry[] = [];
	const seenPathIds = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !seenPathIds.has(current.id)) {
		seenPathIds.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let serviceTier: ServiceTierByFamily | undefined;
	const models: Record<string, string> = {};
	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;

	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction") {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
			}
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);

	const resetBoundaryIdx = path.reduce((latest, entry, i) => (entry.type === "reset_boundary" ? i : latest), -1);

	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] = [];
	let pendingReset = false;
	let lastAssistantModel: string | undefined;

	const handleEntryResetTracking = (entry: SessionEntry) => {
		if (entry.type === "compaction") {
			pendingReset = true;
		} else if (entry.type === "model_change") {
			pendingReset = true;
		}
	};

	const pushMessage = (msg: AgentMessage) => {
		messages.push(msg);
		if (!options?.transcript) return;
		if (msg.role === "assistant") {
			const currentModel = `${msg.provider}/${msg.model}`;
			const modelChanged = lastAssistantModel !== undefined && lastAssistantModel !== currentModel;
			lastAssistantModel = currentModel;
			cacheMissExplainedAt.push(pendingReset || modelChanged);
			pendingReset = false;
		} else {
			cacheMissExplainedAt.push(false);
		}
	};

	const appendMessage = (entry: SessionEntry) => {
		handleEntryResetTracking(entry);
		if (entry.type === "message") {
			if (!options?.transcript && entry.message.role === "assistant" && entry.message.retryRecovery) {
				return;
			}
			pushMessage(entry.message);
		} else if (entry.type === "custom_message") {
			if (!options?.transcript && entry.customType === PREWALK_PLAN_MESSAGE_TYPE) return;
			if (!isCustomMessageContent(entry.content)) return;
			const normalized = normalizeCustomMessagePayload(entry);
			const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
			pushMessage(
				createCustomMessage(
					normalized.customType,
					normalized.content,
					normalized.display,
					normalized.details,
					entry.timestamp,
					attribution,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			pushMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (options?.transcript && !options.collapseCompactedHistory) {
		for (const entry of path) {
			handleEntryResetTracking(entry);
			if (entry.type === "compaction") {
				const active = entry.id === compaction?.id;
				pushMessage(
					createCompactionSummaryMessage(
						active ? entry.summary : SUPERSEDED_COMPACTION_SUMMARY,
						entry.tokensBefore,
						entry.timestamp,
						{
							shortSummary: active ? entry.shortSummary : SUPERSEDED_COMPACTION_SHORT_SUMMARY,
							warning: entry.warning,
							method: entry.method,
							tokensAfter: entry.tokensAfter,
						},
					),
				);
			} else {
				appendMessage(entry);
			}
		}
	} else if (
		resetBoundaryIdx >= 0 &&
		resetBoundaryIdx > (compaction ? path.findIndex(e => e.type === "compaction" && e.id === compaction.id) : -1)
	) {
		for (let i = resetBoundaryIdx + 1; i < path.length; i++) {
			appendMessage(path[i]);
		}
	} else if (compaction) {
		const providerPayload = getOpenAiRemoteCompactionPayload(compaction);
		const remoteReplacementHistory = providerPayload?.items;
		const compactionSummaryMsg = createCompactionSummaryMessage(
			compaction.summary,
			compaction.tokensBefore,
			compaction.timestamp,
			{
				shortSummary: compaction.shortSummary,
				providerPayload,
				warning: compaction.warning,
				method: compaction.method,
				tokensAfter: compaction.tokensAfter,
			},
		);

		if (!options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		if (!remoteReplacementHistory || options?.transcript) {
			let foundFirstKept = false;
			for (let i = 0; i < compactionIdx; i++) {
				const entry = path[i];
				if (entry.id === compaction.firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (foundFirstKept) {
					appendMessage(entry);
				}
			}
		} else if (compaction.providerReplayThroughEntryId) {
			const replayThroughIdx = path.findIndex(entry => entry.id === compaction.providerReplayThroughEntryId);
			if (replayThroughIdx >= 0 && replayThroughIdx < compactionIdx) {
				for (let i = replayThroughIdx + 1; i < compactionIdx; i++) {
					appendMessage(path[i]);
				}
			}
		}

		if (options?.transcript) handleEntryResetTracking(compaction);
		if (options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	const keepDangling = options?.transcript === true && options.keepDanglingToolCalls === true;
	if (!keepDangling) {
		const pairedToolResultIds = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			let strippedToolCalls = 0;
			for (const block of message.content) {
				if (block.type === "toolCall" && !pairedToolResultIds.has(block.id)) strippedToolCalls++;
			}
			if (strippedToolCalls === 0) continue;
			const normalized = message.content
				.filter(
					block =>
						!(block.type === "toolCall" && !pairedToolResultIds.has(block.id)) &&
						block.type !== "redactedThinking",
				)
				.map(block =>
					block.type === "thinking" && block.thinkingSignature
						? { ...block, thinkingSignature: undefined }
						: block,
				);
			if (normalized.length === 0 && !options?.transcript) {
				messages.splice(i, 1);
			} else {
				const rewritten = { ...message, content: normalized };
				if (options?.transcript) {
					(rewritten as AgentMessage & StrippedToolCallsMarker).strippedToolCalls = strippedToolCalls;
				}
				messages[i] = rewritten;
			}
		}
	}

	if (!options?.transcript) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			if (message.stopReason !== "aborted" && message.stopReason !== "error") continue;
			const next = messages[i + 1];
			if (next?.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE) continue;

			const droppedToolCallIds = new Set<string>();
			for (const block of message.content) {
				if (block.type === "toolCall") droppedToolCallIds.add(block.id);
			}
			messages.splice(i, 1);
			if (droppedToolCallIds.size > 0) {
				for (let j = messages.length - 1; j >= i; j--) {
					const candidate = messages[j];
					if (candidate?.role === "toolResult" && droppedToolCallIds.has(candidate.toolCallId)) {
						messages.splice(j, 1);
					}
				}
			}
		}
	}

	return {
		messages,
		cacheMissExplainedAt: options?.transcript ? cacheMissExplainedAt : undefined,
		thinkingLevel,
		configuredThinkingLevel,
		serviceTier,
		models,
		injectedTtsrRules,
		mode,
		modeData,
	};
}
