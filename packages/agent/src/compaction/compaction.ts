import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	type CodexCompactionContext,
	type Context,
	Effort,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type OneshotRetryOptions,
	type ProviderSessionState,
	type SimpleStreamOptions,
	type Tool,
	type Usage,
	withAuth,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createOpenAICodexCompactionRequestContext } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildResponsesInput, resolveOpenAICompatPolicy } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { stripOpenAIResponsesOutputOnlyStatusesForReplay } from "@oh-my-pi/pi-ai/utils";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import {
	buildCompactionV2Request,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	shouldUseCompactionV2Streaming,
	storeCompactionV2PreserveData,
	V2_RETAINED_MESSAGE_TOKEN_BUDGET,
} from "./compaction-v2-streaming";
import type { CompactionEntry, SessionEntry } from "./entries";
import { NativeCompactionError } from "./errors";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import {
	buildOpenAiNativeHistory,
	getPreservedOpenAiRemoteCompactionData,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseOpenAiRemoteCompaction,
	trimRemoteCompactionInputToContextWindow,
	withOpenAiRemoteCompactionPreserveData,
} from "./openai";
import autoHandoffThresholdFocusPrompt from "./prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import compactionShortSummaryPrompt from "./prompts/compaction-short-summary.md" with { type: "text" };
import compactionSummaryPrompt from "./prompts/compaction-summary.md" with { type: "text" };
import compactionTurnPrefixPrompt from "./prompts/compaction-turn-prefix.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "./prompts/compaction-update-summary.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };

import {
	computeFileLists,
	createFileOps,
	escapeSummaryBoundaryTags,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	upsertFileOperations,
} from "./utils";

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

export interface CompactionResult<T = unknown> {
	summary: string;

	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;

	details?: T;

	preserveData?: Record<string, unknown>;
}

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "shake" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	midTurnEnabled?: boolean;

	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
	remoteStreamingV2Enabled?: boolean;
	v2RetainedMessageBudget?: number;
}

export const DEFAULT_RESERVE_TOKENS = 16384;

const MAX_SUMMARY_TOKENS = DEFAULT_RESERVE_TOKENS;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
	remoteStreamingV2Enabled: true,
	v2RetainedMessageBudget: V2_RETAINED_MESSAGE_TOKEN_BUDGET,
};

export function shouldUseProviderNativeCompaction(
	model: Model,
	settings: Pick<CompactionSettings, "remoteEnabled" | "remoteStreamingV2Enabled">,
): boolean {
	if (settings.remoteEnabled === false) return false;
	return (
		shouldUseOpenAiRemoteCompaction(model) ||
		(settings.remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(model))
	);
}

export function calculateContextTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

export function hasContextTokenUsage(usage: Usage): boolean {
	return (
		(usage.contextTokens ?? 0) > 0 ||
		usage.input + usage.cacheRead + usage.cacheWrite > 0 ||
		calculateContextTokens(usage) > usage.output
	);
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return Math.max(
			0,
			Math.min(contextWindow - 1, contextWindow - resolveBudgetReserveTokens(contextWindow, settings)),
		);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

function estimateEntriesTokens(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	startIndex: number,
	endIndex: number,
): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += tokenizer.countMessage(msg);
		}
	}
	return total;
}

function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}

		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];

		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role as string;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	firstKeptEntryIndex: number;

	turnStartIndex: number;

	isSplitTurn: boolean;
}

export function findCutPoint(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const messageTokens = tokenizer.countMessage(entry.message);
		accumulatedTokens += messageTokens;

		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];

		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}

		cutIndex--;
	}

	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

const SUMMARIZATION_PROMPT = prompt.render(compactionSummaryPrompt);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(compactionUpdateSummaryPrompt);

const SHORT_SUMMARY_PROMPT = prompt.render(compactionShortSummaryPrompt);

const HANDOFF_DOCUMENT_PROMPT = prompt.render(handoffDocumentPrompt);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

function effortFromThinkingLevel(level: ThinkingLevel): Effort {
	switch (level) {
		case ThinkingLevel.Minimal:
			return Effort.Minimal;
		case ThinkingLevel.Low:
			return Effort.Low;
		case ThinkingLevel.Medium:
			return Effort.Medium;
		case ThinkingLevel.High:
			return Effort.High;
		case ThinkingLevel.XHigh:
			return Effort.XHigh;
		case ThinkingLevel.Max:
			return Effort.Max;
		case ThinkingLevel.Off:
		case ThinkingLevel.Inherit:
			throw new Error(`effortFromThinkingLevel: ${level} must be handled by caller`);
	}
}

function resolveCompactionEffort(model: Model, level: ThinkingLevel | undefined): Effort | undefined {
	if (level === ThinkingLevel.Off) return undefined;
	const requested: Effort =
		level === undefined || level === ThinkingLevel.Inherit ? Effort.High : effortFromThinkingLevel(level);
	return clampThinkingLevelForModel(model, requested);
}

function createSummarizationError(prefix: string, response: AssistantMessage): Error {
	const text = `${prefix}: ${response.errorMessage || "Unknown error"}`;
	return response.errorStatus === undefined
		? new Error(text)
		: new AIError.ProviderHttpError(text, response.errorStatus);
}

function shouldRetryHandoffWithAutoToolChoice(response: AssistantMessage): boolean {
	if (response.errorStatus !== 400) return false;
	const message = response.errorMessage ?? "";
	return /\btool_choice\b/i.test(message) && /\bauto\b/i.test(message) && /\bsupported\b/i.test(message);
}

export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;

	telemetry?: AgentTelemetry;

	thinkingLevel?: ThinkingLevel;

	sessionId?: string;

	promptCacheKey?: string;

	providerSessionState?: Map<string, ProviderSessionState>;

	preferWebsockets?: boolean;

	codexCompaction?: CodexCompactionContext;

	tools?: Tool[];

	fetch?: FetchImpl;

	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;

	oneshotRetry?: OneshotRetryOptions | false;
}

function summaryOneshotRetry(options: SummaryOptions | undefined): OneshotRetryOptions | undefined {
	const configured = options?.oneshotRetry;
	if (configured === false) return undefined;
	return configured ?? {};
}

function localCodexCompaction(options: SummaryOptions | undefined) {
	return createOpenAICodexCompactionRequestContext({
		context: options?.codexCompaction,
		implementation: "responses",
	});
}

const DEFAULT_SUMMARY_INPUT_WINDOW = 200_000;

const MIN_SUMMARY_INPUT_TOKENS = 16_384;

function minSummaryInputTokens(model: Model): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	return Math.min(MIN_SUMMARY_INPUT_TOKENS, Math.max(1_024, Math.floor(window / 8)));
}

function summaryInputBudgetTokens(model: Model, maxTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;

	return Math.max(minSummaryInputTokens(model), Math.floor(window * 0.8) - maxTokens - MAX_SUMMARY_TOKENS);
}

function clampConversationToBudget(text: string, budgetTokens: number, tokens: number): string {
	if (tokens <= budgetTokens) return text;
	const keep = Math.max(1024, Math.floor((text.length * budgetTokens * 0.95) / tokens));
	if (keep >= text.length) return text;
	return `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`;
}

interface SummaryWindow {
	messages: Message[];
	budgetTokens: number;

	text?: string;
}

function planSummaryWindows(
	messages: Message[],
	tokenizer: Tokenizer,
	dialect: Dialect | undefined,
	budgetTokens: number,
): Message[][] {
	const windows: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = tokenizer.countTokens(serializeConversationForSummary([message], dialect));
		if (currentTokens > 0 && currentTokens + tokens > budgetTokens) {
			windows.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), MAX_SUMMARY_TOKENS);

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(currentMessages);
	const dialect = preferredDialect(model.id);
	const tokenizer = new Tokenizer(model);
	const wholeConversation = serializeConversationForSummary(llmMessages, dialect);
	const budgetTokens = summaryInputBudgetTokens(model, maxTokens);

	const pending: SummaryWindow[] = tokenizer.checkTokenBudget(wholeConversation, budgetTokens).fits
		? [{ messages: llmMessages, budgetTokens, text: wholeConversation }]
		: planSummaryWindows(llmMessages, tokenizer, dialect, budgetTokens).map(messages => ({ messages, budgetTokens }));

	let carriedSummary = previousSummary;
	while (pending.length > 0) {
		const window = pending[0];
		const text = window.text ?? serializeConversationForSummary(window.messages, dialect);

		const budget = tokenizer.checkTokenBudget(text, window.budgetTokens);
		try {
			carriedSummary = await summarizeConversationWindow(
				budget.fits ? text : clampConversationToBudget(text, window.budgetTokens, budget.tokens),
				carriedSummary,
				model,
				maxTokens,
				apiKey,
				signal,
				customInstructions,
				options,
			);
		} catch (error) {
			const sentTokens = budget.exact ? budget.tokens : tokenizer.countTokens(text, "strict");
			const halved = Math.floor(Math.min(window.budgetTokens, sentTokens) / 2);
			if (
				!AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow) ||
				halved < minSummaryInputTokens(model)
			) {
				throw error;
			}
			pending.splice(
				0,
				1,
				...planSummaryWindows(window.messages, tokenizer, dialect, halved).map(messages => ({
					messages,
					budgetTokens: halved,
				})),
			);
			continue;
		}
		pending.shift();
	}
	return carriedSummary ?? "";
}

async function summarizeConversationWindow(
	conversationText: string,
	previousSummary: string | undefined,
	model: Model,
	maxTokens: number,
	apiKey: ApiKey,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	options: SummaryOptions | undefined,
): Promise<string> {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(previousSummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key =>
				requestRemoteCompaction(
					endpoint,
					{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, prompt: promptText, maxTokens },
					signal,
					{ fetch: options.fetch, model, apiKey: key },
				),
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_summary",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Summarization failed", response);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	return textContent;
}

export interface HandoffOptions {
	systemPrompt: string[];

	tools?: Tool[];
	customInstructions?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;

	telemetry?: AgentTelemetry;

	thinkingLevel?: ThinkingLevel;
}

export function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(handoffDocumentPrompt, {
		additionalFocus: customInstructions,
	});
}

export interface HandoffFromContextOptions {
	streamOptions: SimpleStreamOptions;

	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;

	telemetry?: AgentTelemetry;

	thinkingLevel?: ThinkingLevel;
}

export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const requestOptions = {
		...options.streamOptions,
		reasoning: resolveCompactionEffort(model, options.thinkingLevel),
		toolChoice: "none" as const,
	};
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind: "handoff",
		completeImpl: options.completeImpl,
		retry: {},
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl, retry: {} },
		);
	}

	if (response.stopReason === "error") {
		throw createSummarizationError("Handoff generation failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	return generateHandoffFromContext(
		{ systemPrompt: options.systemPrompt, messages: requestMessages, tools: options.tools },
		model,
		{
			streamOptions: {
				apiKey,
				signal,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
			},
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
		},
	);
}

async function generateShortSummary(
	recentMessages: AgentMessage[],
	historySummary: string | undefined,
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(512, Math.floor(0.2 * reserveTokens));
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(recentMessages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (historySummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(historySummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += SHORT_SUMMARY_PROMPT;

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key =>
				requestRemoteCompaction(
					endpoint,
					{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, prompt: promptText, maxTokens },
					signal,
					{ fetch: options?.fetch, model, apiKey: key },
				),
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT],
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
		},
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_short_summary",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Short summary failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

export interface CompactionPreparation {
	firstKeptEntryId: string;

	messagesToSummarize: AgentMessage[];

	turnPrefixMessages: AgentMessage[];

	recentMessages: AgentMessage[];

	isSplitTurn: boolean;
	tokensBefore: number;

	previousSummary?: string;

	previousPreserveData?: Record<string, unknown>;

	fileOps: FileOperations;

	settings: CompactionSettings;
}

export function remotePreserveReusable(
	preserveData: Record<string, unknown> | undefined,
	activeModel: Model,
	settings: CompactionSettings,
): boolean {
	const remote = getCompactionV2PreserveData(preserveData) ?? getPreservedOpenAiRemoteCompactionData(preserveData);
	if (!remote) return true;
	if (settings.remoteEnabled === false) return false;
	if (remote.provider !== activeModel.provider) return false;
	const v2Ok = settings.remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(activeModel);
	return v2Ok || shouldUseOpenAiRemoteCompaction(activeModel);
}

export function findReadableCompactionIndex(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	activeModel?: Model,
): number {
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type !== "compaction") continue;
		const entry = pathEntries[i] as CompactionEntry;
		if (activeModel && !remotePreserveReusable(entry.preserveData, activeModel, settings)) continue;
		return i;
	}
	return -1;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	activeModel?: Model,
	tokenizer: Tokenizer = new Tokenizer(activeModel),
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = findReadableCompactionIndex(pathEntries, settings, activeModel);

	let resetBoundaryIndex = -1;
	for (let i = pathEntries.length - 1; i > prevCompactionIndex; i--) {
		if (pathEntries[i].type === "reset_boundary") {
			resetBoundaryIndex = i;
			break;
		}
	}
	if (resetBoundaryIndex > prevCompactionIndex) {
		prevCompactionIndex = -1;
	}
	const boundaryStart = Math.max(prevCompactionIndex, resetBoundaryIndex) + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, tokenizer, boundaryStart, boundaryEnd);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, tokenizer, boundaryStart, boundaryEnd, keepRecentTokens);

	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined;
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) recentMessages.push(msg);
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	};
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(compactionTurnPrefixPrompt);

function openAiCompatSupportsImageDetailOriginal(model: Model): boolean {
	const compat = model.compat;
	return !!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === true;
}

function buildOpenAiResponsesCompactionInput(
	messages: Message[],
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	previousReplacementHistory: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
	const input = buildResponsesInput({
		model,
		context: { messages },
		strictResponsesPairing: model.compat.strictResponsesPairing,
		supportsImageDetailOriginal: openAiCompatSupportsImageDetailOriginal(model),
		nativeHistory: { replay: true, filterReasoning: false },
		includeThinkingSignatures: true,
		repairOrphanOutputs: true,
	});
	const nativeInput: Array<Record<string, unknown>> = [];
	for (const item of input) {
		if (!isRecord(item)) {
			throw new Error("OpenAI Responses compaction input contains a non-object item");
		}
		nativeInput.push(item);
	}
	return stripOpenAIResponsesOutputOnlyStatusesForReplay(
		previousReplacementHistory ? [...previousReplacementHistory, ...nativeInput] : nativeInput,
	);
}

function buildCompactionV2Reasoning(
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	thinkingLevel: ThinkingLevel | undefined,
): { effort: string; summary: string } | undefined {
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: resolveCompactionEffort(model, thinkingLevel),
	});
	const reasoning = policy.reasoning;
	if (!reasoning.modelSupported || reasoning.disabled || reasoning.omitReasoningEffort) return undefined;
	if (reasoning.requestedEffort === undefined) return undefined;
	return { effort: reasoning.wireEffort ?? reasoning.requestedEffort, summary: "auto" };
}

function selectNativeCompactionError(previousError: unknown, nextError: unknown): unknown {
	if (previousError === undefined) return nextError;
	return AIError.is(AIError.classify(previousError), AIError.Flag.AuthFailed) ? nextError : previousError;
}

export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const reserveTokens = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEnabled === false ? undefined : settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
		initiatorOverride: options?.initiatorOverride,
		metadata: options?.metadata,
		convertToLlm: options?.convertToLlm,
		telemetry: options?.telemetry,

		thinkingLevel: options?.thinkingLevel,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		providerSessionState: options?.providerSessionState,
		preferWebsockets: options?.preferWebsockets,
		codexCompaction: options?.codexCompaction,
		tools: options?.tools,
		fetch: options?.fetch,
		completeImpl: options?.completeImpl,
	};

	let preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, undefined);
	const remoteMessages: AgentMessage[] = [...messagesToSummarize, ...turnPrefixMessages, ...recentMessages];
	let usedRemoteCompaction = false;
	let nativeCompactionError: unknown;
	if (
		settings.remoteEnabled !== false &&
		settings.remoteStreamingV2Enabled !== false &&
		shouldUseCompactionV2Streaming(model)
	) {
		const previousRemoteCompaction = getCompactionV2PreserveData(previousPreserveData);
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: undefined;
		const remoteHistory = buildOpenAiResponsesCompactionInput(
			(summaryOptions.convertToLlm ?? defaultConvertToLlm)(remoteMessages),
			model,
			previousReplacementHistory,
		);
		if (remoteHistory.length > 0) {
			try {
				const instructions = summaryOptions.remoteInstructions ?? SUMMARIZATION_SYSTEM_PROMPT;
				const tools = summaryOptions.tools
					? convertTools(summaryOptions.tools, model.compat.supportsStrictMode, model)
					: undefined;
				const trimmed = trimRemoteCompactionInputToContextWindow(
					remoteHistory,
					new Tokenizer(model),
					model.contextWindow,
					instructions,
					tools,
				);
				if (trimmed.rewrittenOutputs > 0) {
					logger.info("Rewrote trailing tool outputs before OpenAI V2 remote compaction", {
						model: model.id,
						provider: model.provider,
						rewrittenOutputs: trimmed.rewrittenOutputs,
						estimatedTokensBefore: trimmed.estimatedTokensBefore,
						estimatedTokensAfter: trimmed.estimatedTokensAfter,
						contextWindow: model.contextWindow,
					});
				}
				const request = buildCompactionV2Request(model, trimmed.input, instructions, {
					tools,
					reasoning: buildCompactionV2Reasoning(model, summaryOptions.thinkingLevel),
					sessionId: summaryOptions.sessionId,
					promptCacheKey: summaryOptions.promptCacheKey,
					retainedMessageBudget: settings.v2RetainedMessageBudget,
				});
				const remote = await withAuth(
					apiKey,
					key =>
						requestCompactionV2Streaming(model, key, request, signal, {
							fetch: summaryOptions.fetch,
							providerSessionState: summaryOptions.providerSessionState,
							preferWebsockets: summaryOptions.preferWebsockets,
							codexCompaction: summaryOptions.codexCompaction,
						}),
					{ signal },
				);
				preserveData = { ...(preserveData ?? {}), ...storeCompactionV2PreserveData(remote, model) };
				usedRemoteCompaction = true;
			} catch (err) {
				if (signal?.aborted) throw err;
				nativeCompactionError = selectNativeCompactionError(nativeCompactionError, err);
				logger.warn("OpenAI V2 remote compaction failed, falling back to V1 remote compaction", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	if (!usedRemoteCompaction && settings.remoteEnabled !== false && shouldUseOpenAiRemoteCompaction(model)) {
		const previousRemoteCompaction = getPreservedOpenAiRemoteCompactionData(previousPreserveData);
		const previousV2Compaction = getCompactionV2PreserveData(previousPreserveData);
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: previousV2Compaction?.provider === model.provider
					? previousV2Compaction.replacementHistory
					: undefined;
		const remoteHistory = buildOpenAiNativeHistory(
			(summaryOptions.convertToLlm ?? defaultConvertToLlm)(remoteMessages),
			model,
			previousReplacementHistory,
		);
		if (remoteHistory.length > 0) {
			try {
				const remote = await withAuth(
					apiKey,
					key =>
						requestOpenAiRemoteCompaction(
							model,
							key,
							remoteHistory,
							summaryOptions.remoteInstructions ?? SUMMARIZATION_SYSTEM_PROMPT,
							signal,
							{
								fetch: summaryOptions.fetch,
								sessionId: summaryOptions.sessionId,
								providerSessionState: summaryOptions.providerSessionState,
								codexCompaction: summaryOptions.codexCompaction,
							},
						),
					{ signal },
				);
				preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, remote);
				usedRemoteCompaction = true;
			} catch (err) {
				if (signal?.aborted) throw err;
				nativeCompactionError = selectNativeCompactionError(nativeCompactionError, err);
				logger.warn("OpenAI remote compaction failed", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	if (!usedRemoteCompaction && nativeCompactionError !== undefined && !summaryOptions.remoteEndpoint) {
		throw new NativeCompactionError(nativeCompactionError);
	}

	let summary: string;

	if (usedRemoteCompaction) {
		const usedTokens = getCompactionV2PreserveData(preserveData)?.usedTokens ?? 0;
		summary =
			"Remote compaction preserved provider-native history for this session." +
			(usedTokens > 0 ? ` Retained ${usedTokens} tokens in the provider replay payload.` : "");
	} else if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummary
				? generateSummary(
						messagesToSummarize,
						model,
						reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummary,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, reserveTokens, apiKey, signal, summaryOptions),
		]);

		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummary,
			summaryOptions,
		);
	} else if (previousSummary) {
		summary = previousSummary;
	} else {
		summary = "No prior history.";
	}

	const shortSummary = usedRemoteCompaction
		? "Remote compaction"
		: await generateShortSummary(recentMessages, summary, model, reserveTokens, apiKey, signal, {
				...summaryOptions,
				extraContext: options?.extraContext,
				thinkingLevel: options?.thinkingLevel,
			});

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	return {
		summary,
		shortSummary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData,
	};
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), MAX_SUMMARY_TOKENS);

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_turn_prefix",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Turn prefix summarization failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
