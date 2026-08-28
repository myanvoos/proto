import type { Api, ApiKey, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { prompt } from "@oh-my-pi/pi-utils";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { ReadonlySessionManager, SessionEntry } from "./entries";
import {
	type ConvertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
} from "./messages";
import branchSummaryPrompt from "./prompts/branch-summary.md" with { type: "text" };
import branchSummaryPreamble from "./prompts/branch-summary-preamble.md" with { type: "text" };
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	truncateToolResultForSummary,
	upsertFileOperations,
} from "./utils";

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils";

export interface BranchPreparation {
	messages: AgentMessage[];

	fileOps: FileOperations;

	totalTokens: number;
}

export interface CollectEntriesResult {
	entries: SessionEntry[];

	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	model: Model;

	apiKey: ApiKey;

	signal: AbortSignal;

	customInstructions?: string;

	reserveTokens?: number;

	metadata?: Record<string, unknown>;

	convertToLlm?: ConvertToLlm;

	telemetry?: AgentTelemetry;

	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	const oldPath = new Set(session.getBranch(oldLeafId).map(e => e.id));
	const targetPath = session.getBranch(targetId);

	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	entries.reverse();

	return { entries, commonAncestorId };
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult" && entry.message.useless === true && entry.message.isError !== true) {
				return undefined;
			}
			return entry.message;

		case "custom_message":
			return createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.attribution,
			);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, {
				shortSummary: entry.shortSummary,
			});

		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "service_tier_change":
		case "ttsr_injection":
		case "session_init":
		case "mode_change":
			return undefined;
	}
}

function estimateBranchSummaryTokens(message: AgentMessage, tokenizer: Tokenizer): number {
	if (message.role !== "toolResult") return tokenizer.countMessage(message);
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("");
	if (!text) return 0;
	return tokenizer.countMessage({
		...message,
		content: [{ type: "text", text: truncateToolResultForSummary(text) }],
	});
}

export function prepareBranchEntries(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	tokenBudget: number = 0,
): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromExtension && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateBranchSummaryTokens(message, tokenizer);

		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}

			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

const BRANCH_SUMMARY_PREAMBLE = prompt.render(branchSummaryPreamble);

const BRANCH_SUMMARY_PROMPT = prompt.render(branchSummaryPrompt);

export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, signal, customInstructions, reserveTokens = 16384, metadata } = options;

	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;
	const tokenizer = new Tokenizer(model);

	const { messages, fileOps } = prepareBranchEntries(entries, tokenizer, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));

	const instructions = customInstructions || BRANCH_SUMMARY_PROMPT;
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	let response: AssistantMessage;
	try {
		response = await instrumentedCompleteSimple(
			model,
			{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
			{ apiKey, signal, maxTokens: 2048, metadata },
			{ telemetry: options.telemetry, oneshotKind: "branch_summary", completeImpl: options.completeImpl, retry: {} },
		);
	} catch (error) {
		if (signal.aborted) return { aborted: true };
		throw error;
	}

	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
