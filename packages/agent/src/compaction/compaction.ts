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
import {
	type ConvertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
} from "./messages";
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
import compactionSelfSummaryPrompt from "./prompts/compaction-self-summary.md" with { type: "text" };
import compactionSummaryPrompt from "./prompts/compaction-summary.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "./prompts/compaction-update-summary.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };
import nativeCompactionPrompt from "./prompts/native-compaction.md" with { type: "text" };

import {
	computeFileLists,
	createFileOps,
	escapeSummaryBoundaryTags,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	TOOL_RESULT_MAX_CHARS,
	TOOL_RESULT_MIN_CHARS,
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
const SUMMARY_PROMPT_SAFETY_TOKENS = 64;

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

/**
 * How full a context window may get before maintenance runs, by window size.
 *
 * The fraction falls as windows grow, because the two costs it balances move in opposite
 * directions: a small window has to run nearly full to fit any work at all, while re-sending 40%
 * of a million-token window already costs more every turn than folding it does once. Anchors are
 * interpolated piecewise-linearly and held constant outside the range.
 */
export const COMPACTION_THRESHOLD_ANCHORS: readonly { window: number; ratio: number }[] = [
	{ window: 32_768, ratio: 0.9 },
	{ window: 131_072, ratio: 0.8 },
	{ window: 262_144, ratio: 0.7 },
	{ window: 1_048_576, ratio: 0.4 },
];

/** Fraction of `contextWindow` the default threshold allows, read off the anchor curve. */
export function compactionThresholdRatio(contextWindow: number): number {
	const first = COMPACTION_THRESHOLD_ANCHORS[0];
	const last = COMPACTION_THRESHOLD_ANCHORS[COMPACTION_THRESHOLD_ANCHORS.length - 1];
	if (contextWindow <= first.window) return first.ratio;
	if (contextWindow >= last.window) return last.ratio;
	for (let i = 1; i < COMPACTION_THRESHOLD_ANCHORS.length; i++) {
		const previous = COMPACTION_THRESHOLD_ANCHORS[i - 1];
		const next = COMPACTION_THRESHOLD_ANCHORS[i];
		if (contextWindow > next.window) continue;
		const span = next.window - previous.window;
		const progress = span > 0 ? (contextWindow - previous.window) / span : 0;
		return previous.ratio + (next.ratio - previous.ratio) * progress;
	}
	return last.ratio;
}

function windowThresholdCeiling(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(0, Math.min(contextWindow - 1, contextWindow - resolveBudgetReserveTokens(contextWindow, settings)));
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent === "number" && Number.isFinite(thresholdPercent) && thresholdPercent > 0) {
		const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
		return Math.floor(contextWindow * (clampedThresholdPercent / 100));
	}

	// Unconfigured: the window's own shape decides, bounded by the room a compaction needs to run.
	const ceiling = windowThresholdCeiling(contextWindow, settings);
	return Math.min(ceiling, Math.floor(contextWindow * compactionThresholdRatio(contextWindow)));
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

const SELF_SUMMARY_PROMPT = prompt.render(compactionSelfSummaryPrompt);

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

function requireNonEmptySummary(text: string, operation: string): string {
	if (text.trim().length === 0) {
		throw new Error(`${operation}: provider returned an empty summary`);
	}
	return text;
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

function middleTruncateText(text: string, keep: number): string {
	if (keep >= text.length) return text;
	const headLength = Math.ceil(keep / 2);
	const tailLength = Math.floor(keep / 2);
	return `${text.slice(0, headLength)}\n\n[... ${text.length - keep} characters truncated from middle ...]\n\n${text.slice(-tailLength)}`;
}

function clampTextToTokenBudget(text: string, budgetTokens: number, tokenizer: Tokenizer): string {
	if (text.length === 0 || budgetTokens <= 0) return "";

	const upperboundTokens = tokenizer.countTokens(text, "upperbound");
	if (upperboundTokens <= budgetTokens) return text;
	let keep = Math.min(text.length, Math.floor((text.length * budgetTokens * 0.9) / Math.max(1, upperboundTokens)));
	for (let attempt = 0; attempt < 12 && keep > 0; attempt++) {
		const candidate = middleTruncateText(text, keep);
		if (tokenizer.checkTokenBudget(candidate, budgetTokens).fits) return candidate;
		keep = Math.floor(keep * 0.75);
	}
	return "";
}

interface BoundedSummaryPromptParts {
	conversationText: string;
	previousSummaryText?: string;
}

function boundSummaryPromptParts(
	conversationText: string,
	previousSummary: string | undefined,
	model: Model,
	maxTokens: number,
	promptSuffix: string,
	forceConversationBudget: boolean,
): BoundedSummaryPromptParts {
	const tokenizer = new Tokenizer(model);
	const totalBudget = Math.max(0, summaryInputBudgetTokens(model, maxTokens) - SUMMARY_PROMPT_SAFETY_TOKENS);
	const staticTokens = tokenizer.countTokens(`<conversation>\n\n</conversation>\n\n${promptSuffix}`, "strict");
	const escapedPrevious = previousSummary ? escapeSummaryBoundaryTags(previousSummary) : undefined;
	const previousWrapperTokens = escapedPrevious
		? tokenizer.countTokens(`<previous-summary>\n\n</previous-summary>\n\n`, "strict")
		: 0;
	let available = Math.max(0, totalBudget - staticTokens - previousWrapperTokens);
	const originalConversationTokens = tokenizer.countTokens(conversationText, "strict");
	const previousTokens = escapedPrevious ? tokenizer.countTokens(escapedPrevious, "strict") : 0;
	if (!forceConversationBudget) {
		const previousBudget = Math.max(
			0,
			totalBudget - staticTokens - previousWrapperTokens - originalConversationTokens,
		);
		return {
			conversationText,
			previousSummaryText: escapedPrevious
				? clampTextToTokenBudget(escapedPrevious, Math.min(previousTokens, previousBudget), tokenizer)
				: undefined,
		};
	}

	const reservedPreviousTokens = escapedPrevious ? Math.min(previousTokens, Math.floor(available * 0.25)) : 0;
	const conversationBudget = Math.max(0, available - reservedPreviousTokens);
	const boundedConversation = clampTextToTokenBudget(conversationText, conversationBudget, tokenizer);
	const boundedConversationTokens = tokenizer.countTokens(boundedConversation, "strict");
	available = Math.max(0, available - boundedConversationTokens);
	const boundedPrevious = escapedPrevious
		? clampTextToTokenBudget(escapedPrevious, Math.min(previousTokens, available), tokenizer)
		: undefined;
	return { conversationText: boundedConversation, previousSummaryText: boundedPrevious };
}

const TOOL_RESULT_CAP_PROBES = 4;

const TOOL_RESULT_CAP_GRANULARITY = 2_000;

interface FittedConversation {
	toolResultMaxChars: number;

	text: string;
}

/**
 * Tool results are clipped before the summarizer ever sees them, so the clip width decides how much
 * detail a compaction can possibly retain. Spend the summarizer's spare input budget on wider tool
 * results instead of leaving it unused: find the widest clip whose whole-transcript serialization
 * still fits one window, which also avoids the multi-window carry-forward that compounds detail loss.
 */
function fitConversationToBudget(
	messages: Message[],
	tokenizer: Tokenizer,
	dialect: Dialect | undefined,
	budgetTokens: number,
): FittedConversation | undefined {
	const serializeFitting = (toolResultMaxChars: number): string | undefined => {
		const text = serializeConversationForSummary(messages, dialect, { toolResultMaxChars });
		return tokenizer.checkTokenBudget(text, budgetTokens).fits ? text : undefined;
	};

	const baseText = serializeFitting(TOOL_RESULT_MIN_CHARS);
	if (baseText === undefined) return undefined;

	const clipped = messages.some(
		message =>
			message.role === "toolResult" &&
			message.content.some(block => block.type === "text" && block.text.length > TOOL_RESULT_MIN_CHARS),
	);
	if (!clipped) return { toolResultMaxChars: TOOL_RESULT_MIN_CHARS, text: baseText };

	const richText = serializeFitting(TOOL_RESULT_MAX_CHARS);
	if (richText !== undefined) return { toolResultMaxChars: TOOL_RESULT_MAX_CHARS, text: richText };

	let best: FittedConversation = { toolResultMaxChars: TOOL_RESULT_MIN_CHARS, text: baseText };
	let low = TOOL_RESULT_MIN_CHARS;
	let high = TOOL_RESULT_MAX_CHARS;
	for (let probe = 0; probe < TOOL_RESULT_CAP_PROBES && high - low > TOOL_RESULT_CAP_GRANULARITY; probe++) {
		const candidate = low + Math.floor((high - low) / 2);
		const text = serializeFitting(candidate);
		if (text === undefined) {
			high = candidate;
			continue;
		}
		best = { toolResultMaxChars: candidate, text };
		low = candidate;
	}
	return best;
}

/**
 * Remote compaction against a configured OpenAI-compatible endpoint: the serialized transcript is
 * summarized off-box. This is the fallback when provider-native compaction is unavailable but an
 * endpoint is configured; there is no local summarizer anymore.
 */
async function summarizeViaRemoteEndpoint(args: {
	endpoint: string;
	messages: AgentMessage[];
	previousSummary: string | undefined;
	model: Model;
	reserveTokens: number;
	apiKey: ApiKey;
	customInstructions: string | undefined;
	options: SummaryOptions | undefined;
	signal: AbortSignal | undefined;
}): Promise<string> {
	const { endpoint, messages, previousSummary, model, reserveTokens, apiKey, customInstructions, options, signal } =
		args;
	const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), MAX_SUMMARY_TOKENS);
	const dialect = preferredDialect(model.id);
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const tokenizer = new Tokenizer(model);
	const fitted = fitConversationToBudget(llmMessages, tokenizer, dialect, summaryInputBudgetTokens(model, maxTokens));
	const conversationText =
		fitted?.text ??
		serializeConversationForSummary(llmMessages, dialect, { toolResultMaxChars: TOOL_RESULT_MIN_CHARS });

	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const promptSuffix = `${formatAdditionalContext(options?.extraContext)}${basePrompt}`;
	const bounded = boundSummaryPromptParts(conversationText, previousSummary, model, maxTokens, promptSuffix, true);
	let promptText = `<conversation>\n${bounded.conversationText}\n</conversation>\n\n`;
	if (bounded.previousSummaryText) {
		promptText += `<previous-summary>\n${bounded.previousSummaryText}\n</previous-summary>\n\n`;
	}
	promptText += promptSuffix;

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
	return requireNonEmptySummary(remote.summary, "Remote compaction failed");
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

	maxTokens?: number;

	fetch?: FetchImpl;

	sessionId?: string;

	promptCacheKey?: string;

	providerSessionState?: Map<string, ProviderSessionState>;

	preferWebsockets?: boolean;

	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
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

	oneshotKind?: string;
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
	const oneshotKind = options.oneshotKind ?? "handoff";
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind,
		completeImpl: options.completeImpl,
		retry: {},
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind, completeImpl: options.completeImpl, retry: {} },
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

/**
 * The model writes in its own voice only when it is asked in its own context: the transcript is
 * replayed at full fidelity, in provider message form, under the caller's system prompt and tools.
 * That request is a prefix of the live session, so it reads the session's warm prompt cache.
 */
async function generateSelfAuthored(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	instruction: string,
	oneshotKind: string,
	options: HandoffOptions,
	signal: AbortSignal | undefined,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: instruction }],
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
				maxTokens: options.maxTokens,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
				fetch: options.fetch,
				sessionId: options.sessionId,
				promptCacheKey: options.promptCacheKey,
				providerSessionState: options.providerSessionState,
				preferWebsockets: options.preferWebsockets,
			},
			completeImpl: options.completeImpl,
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
			oneshotKind,
		},
	);
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	return generateSelfAuthored(
		messages,
		model,
		apiKey,
		renderHandoffPrompt(options.customInstructions),
		"handoff",
		options,
		signal,
	);
}

/**
 * The structured summary is written by a summarizer that only ever sees a serialized transcript.
 * This note is written by the session's own model, from the context it is about to lose, and is
 * appended to whatever summary the compaction produced — including one supplied by an extension.
 * The previous summary leads the replay: it is the only surviving record of history already folded.
 */
export async function generateSelfSummary(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const messages: AgentMessage[] = [];
	if (preparation.previousSummary) {
		messages.push(
			createCompactionSummaryMessage(
				preparation.previousSummary,
				preparation.tokensBefore,
				new Date().toISOString(),
			) as AgentMessage,
		);
	}
	messages.push(...preparation.messagesToSummarize, ...preparation.turnPrefixMessages);
	return generateSelfAuthored(messages, model, apiKey, SELF_SUMMARY_PROMPT, "self-summary", options, signal);
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
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	// The compaction threshold already holds `effectiveReserveTokens` back for the summary; budgeting
	// the summary against the raw default instead left that headroom unused and truncated detail.
	const reserveTokens =
		model.contextWindow && model.contextWindow > 0
			? effectiveReserveTokens(model.contextWindow, settings)
			: DEFAULT_RESERVE_TOKENS;

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
				const instructions = summaryOptions.remoteInstructions ?? nativeCompactionPrompt;
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
							summaryOptions.remoteInstructions ?? nativeCompactionPrompt,
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
	} else if (summaryOptions.remoteEndpoint) {
		summary = await summarizeViaRemoteEndpoint({
			endpoint: summaryOptions.remoteEndpoint,
			messages: [...messagesToSummarize, ...turnPrefixMessages],
			previousSummary,
			model,
			reserveTokens,
			apiKey,
			customInstructions,
			options: summaryOptions,
			signal,
		});
	} else {
		throw new NativeCompactionError(
			nativeCompactionError ?? new Error("Remote compaction is not available for this model"),
		);
	}

	const shortSummary = "Remote compaction";

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
