import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	ProviderSessionState,
	ServiceTier,
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveModelServiceTier, streamSimple } from "@oh-my-pi/pi-ai";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, getProjectDir, prompt, truncateHeadBytes } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { buildServiceTierByFamily, serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import cachePrefixTemplate from "../prompts/bench/cache-prefix.md" with { type: "text" };
import cachePrefixChunk from "../prompts/bench/cache-prefix-chunk.md" with { type: "text" };
import cacheSuffixTemplate from "../prompts/bench/cache-suffix.md" with { type: "text" };
import chatTemplate from "../prompts/bench/chat.md" with { type: "text" };
import generationTemplate from "../prompts/bench/generation.md" with { type: "text" };
import prefillInstruction from "../prompts/bench/prefill-instruction.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { createLiveBoard, type LiveBoardOutput } from "./live-board";

const DEFAULT_PAR = 4;
const DEFAULT_CACHE_MAX_TOKENS = 64;
const DEFAULT_CACHE_PREFIX_BYTES = 8_192;
const DEFAULT_CACHE_PAIRS = 1;
const DEFAULT_CACHE_CONCURRENCY = 1;
const DEFAULT_PREFILL_BYTES = 32_768;
const ERROR_WIDTH = 110;
const UTF8_ENCODER = new TextEncoder();
const CACHE_PREFIX_CHUNK = cachePrefixChunk;
const CACHE_PREFIX_PLACEHOLDER = "__PROTO_CACHE_BENCH_RAW_PREFIX__";
const CACHE_PREFIX_CHUNK_BYTES = UTF8_ENCODER.encode(CACHE_PREFIX_CHUNK).byteLength;
const RESPONSE_CACHE_STATUS_HEADERS = ["cf-aig-cache-status"] as const;

type BenchChallengeKind = "chat" | "prefill" | "generation";

type BenchProfile = "mix" | BenchChallengeKind;

const CHALLENGE_KINDS = ["chat", "prefill", "generation"] as const;

const CHALLENGE_MAX_TOKENS: Record<BenchChallengeKind, number> = { chat: 512, prefill: 64, generation: 2048 };

const PROFILE_DEFAULT_RUNS: Record<BenchProfile, number> = { mix: 9, chat: 10, prefill: 5, generation: 5 };

const CHAT_TOPICS = [
	"how a web browser turns an HTML payload into pixels on screen",
	"how a garbage collector reclaims memory in a managed runtime",
	"how TCP congestion control adapts to packet loss",
	"how a B-tree index accelerates database lookups",
	"how DNS resolves a hostname to an IP address",
	"how an operating system scheduler shares a CPU between processes",
	"how public-key cryptography secures a TLS handshake",
	"how a compiler lowers source code to optimized machine code",
	"how a CPU cache hierarchy hides memory latency",
	"how a distributed consensus protocol keeps replicas consistent",
] as const;

const GENERATION_TOPICS = [
	"the history of computing",
	"the history of aviation",
	"the history of astronomy",
	"the history of railways",
	"the history of medicine",
	"the history of telecommunications",
	"the history of cartography",
	"the history of shipbuilding",
] as const;

interface BenchCommandArgs {
	models: string[];
	flags: {
		runs?: number;
		maxTokens?: number;
		prompt?: string;

		serviceTier?: string;
		json?: boolean;
		par?: number;

		profile?: string;

		prefillBytes?: number;
		cache?: boolean;
		cachePrefixFile?: string;
		cachePrefixBytes?: number;
		cachePairs?: number;
		cacheConcurrency?: number;
	};
}

export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

interface BenchRunSuccess {
	ok: true;

	challenge?: BenchChallengeKind;

	ttftMs: number;

	generationMs: number;
	durationMs: number;

	inputTokens: number;
	outputTokens: number;

	tokensPerSecond: number;

	generationTps: number;

	prefillTps: number;

	cost: number;
}

interface BenchRunFailure {
	ok: false;

	challenge?: BenchChallengeKind;
	error: string;
}

type BenchRunResult = BenchRunSuccess | BenchRunFailure;

type CacheObservation =
	| "prompt_cache_read_observed"
	| "prompt_cache_write_observed"
	| "response_cache_hit_observed"
	| "no_provider_proof";

interface BenchCacheUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

interface BenchCacheRunReport {
	phase: "cold" | "warm";
	result: BenchRunResult;
	usage?: BenchCacheUsage;
	requestIdObserved: boolean;
	observations: CacheObservation[];
}

interface BenchCachePairReport {
	cold: BenchCacheRunReport;
	warm: BenchCacheRunReport;

	coldAlreadyWarm: boolean;

	stablePrefix: true;
	suffixChanged: true;
	promptCacheKeyStable: true;
	statefulResponsesDisabled: true;
	freshProviderSessionState: true;

	payloadStructureStable: boolean | "unavailable";
}

interface MetricStats {
	mean: number;
	min: number;

	p50: number;

	p95: number;
	max: number;
}

interface BenchStats {
	ttftMs: MetricStats;
	durationMs: MetricStats;
	tokensPerSecond: MetricStats;
	generationTps: MetricStats;
	prefillTps: MetricStats;

	inputTokens: number;

	outputTokens: number;

	cost: number;
}

interface BenchModelReport {
	selector: string;

	model: string;

	thinking?: ResolvedThinkingLevel;
	results: BenchRunResult[];

	stats: BenchStats | null;

	byChallenge: Partial<Record<BenchChallengeKind, BenchStats>>;
	cachePairs?: BenchCachePairReport[];
}

export interface BenchSummary {
	runs: number;

	maxTokens?: number;

	profile?: BenchProfile;
	models: BenchModelReport[];
	failures: number;

	serviceTierByFamily?: ServiceTierByFamily;
	cache?: {
		pairs: number;
		concurrency: number;
	};
}

type BenchStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface BenchDependencies {
	createRuntime?: () => Promise<BenchRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	streamSimple?: BenchStreamSimple;
	now?: () => number;

	random?: () => number;
	readTextFile?: (path: string, maxBytes: number) => Promise<string>;
	stdoutIsTTY?: boolean;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Expected --${name} to be a positive integer, got ${value}`);
	}
	return value;
}

function closeProviderSessionStates(providerSessionState: Map<string, ProviderSessionState>): void {
	for (const state of providerSessionState.values()) {
		state.close();
	}
	providerSessionState.clear();
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		default:
			return false;
	}
}

function hasVisibleFinalContent(message: AssistantMessage): boolean {
	return message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.length > 0;
			case "thinking":
				return block.thinking.length > 0;
			case "image":
			case "redactedThinking":
			case "toolCall":
				return true;
			default:
				return false;
		}
	});
}

interface CacheRequestCapture {
	payloadStructure?: string;
	requestIdObserved: boolean;
	responseCacheHit: boolean;
	usage?: BenchCacheUsage;
}

function payloadStructure(payload: unknown): string {
	if (payload === null) return "null";
	if (Array.isArray(payload)) return `[${payload.map(payloadStructure).join(",")}]`;
	if (typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${key}:${payloadStructure(record[key])}`)
			.join(",")}}`;
	}
	return typeof payload;
}

function asNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function metricStats(values: number[]): MetricStats {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number): number =>
		sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;
	return {
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		min: sorted[0]!,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted[sorted.length - 1]!,
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function captureUsage(message: AssistantMessage): BenchCacheUsage {
	const usage = message.usage;
	return {
		inputTokens: asNonNegativeNumber(usage.input),
		outputTokens: asNonNegativeNumber(usage.output),
		cacheReadTokens: asNonNegativeNumber(usage.cacheRead),
		cacheWriteTokens: asNonNegativeNumber(usage.cacheWrite),
		totalTokens: asNonNegativeNumber(usage.totalTokens),
		cost: asNonNegativeNumber(usage.cost?.total),
	};
}

function cacheObservations(capture: CacheRequestCapture): CacheObservation[] {
	const observations: CacheObservation[] = [];
	if ((capture.usage?.cacheReadTokens ?? 0) > 0) observations.push("prompt_cache_read_observed");
	if ((capture.usage?.cacheWriteTokens ?? 0) > 0) observations.push("prompt_cache_write_observed");
	if (capture.responseCacheHit) observations.push("response_cache_hit_observed");
	return observations.length > 0 ? observations : ["no_provider_proof"];
}

function cacheRunReport(
	phase: BenchCacheRunReport["phase"],
	result: BenchRunResult,
	capture: CacheRequestCapture,
): BenchCacheRunReport {
	return {
		phase,
		result,
		usage: capture.usage,
		requestIdObserved: capture.requestIdObserved,
		observations: cacheObservations(capture),
	};
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
	const bytes = new Uint8Array(await Bun.file(path).slice(0, maxBytes).arrayBuffer());
	return truncateHeadBytes(bytes, maxBytes).text;
}

function generatedCachePrefix(bytes: number): string {
	return truncateHeadBytes(CACHE_PREFIX_CHUNK.repeat(Math.ceil(bytes / CACHE_PREFIX_CHUNK_BYTES)), bytes).text;
}

function renderCacheBenchmarkPrefix(prefix: string, namespace: string): string {
	const rendered = prompt.render(cachePrefixTemplate, {
		prefix: CACHE_PREFIX_PLACEHOLDER,
		namespace,
	});
	if (!rendered.includes(CACHE_PREFIX_PLACEHOLDER)) {
		throw new Error("Cache benchmark prefix template is missing its raw prefix placeholder");
	}

	return rendered.replace(CACHE_PREFIX_PLACEHOLDER, () => prefix);
}

async function resolveCachePrefix(
	flags: BenchCommandArgs["flags"],
	readTextFile: (path: string, maxBytes: number) => Promise<string>,
): Promise<string> {
	const bytes = normalizePositiveInteger("cache-prefix-bytes", flags.cachePrefixBytes, DEFAULT_CACHE_PREFIX_BYTES);
	const prefix = flags.cachePrefixFile
		? await readTextFile(flags.cachePrefixFile, bytes)
		: generatedCachePrefix(bytes);
	return truncateHeadBytes(prefix, bytes).text;
}

function cacheBenchmarkMessages(stablePrefix: string, suffix: string): Context["messages"] {
	const timestamp = Date.now();
	return [
		{ role: "user", content: stablePrefix, timestamp, attribution: "user" },
		{ role: "user", content: suffix, timestamp, attribution: "user" },
	];
}

interface BenchChallenge {
	kind: BenchChallengeKind;
	maxTokens: number;
	messages: Context["messages"];
}

interface BenchChallengeOptions {
	promptOverride?: string;

	prefillBytes: number;

	nonce: string;

	random: () => number;

	maxTokensOverride?: number;
}

function buildBenchChallenge(kind: BenchChallengeKind, opts: BenchChallengeOptions): BenchChallenge {
	const maxTokens = opts.maxTokensOverride ?? CHALLENGE_MAX_TOKENS[kind];
	const pick = (topics: readonly string[]): string => topics[Math.floor(opts.random() * topics.length)] ?? topics[0]!;
	const user = (content: string): Context["messages"] => [
		{ role: "user", content, timestamp: Date.now(), attribution: "user" },
	];
	switch (kind) {
		case "chat":
			return {
				kind,
				maxTokens,
				messages: user(opts.promptOverride ?? prompt.render(chatTemplate, { topic: pick(CHAT_TOPICS) }).trim()),
			};
		case "generation":
			return {
				kind,
				maxTokens,
				messages: user(
					opts.promptOverride ?? prompt.render(generationTemplate, { topic: pick(GENERATION_TOPICS) }).trim(),
				),
			};
		case "prefill":
			return {
				kind,
				maxTokens,
				messages: user(
					`Benchmark run ${opts.nonce}.\n\n${generatedCachePrefix(opts.prefillBytes)}\n\n${opts.promptOverride ?? prefillInstruction.trim()}`,
				),
			};
	}
}

async function runWithConcurrency<T>(
	count: number,
	concurrency: number,
	run: (index: number) => Promise<T>,
): Promise<T[]> {
	const results = new Array<T>(count);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < count) {
			const index = next++;
			results[index] = await run(index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
	return results;
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function formatCachePairLine(pair: BenchCachePairReport, index: number, total: number): string {
	const formatPhase = (run: BenchCacheRunReport, alreadyWarm = false) => {
		if (!run.result.ok) {
			return `${run.phase} failed: ${truncateToWidth(replaceTabs(run.result.error), ERROR_WIDTH)}`;
		}
		const usage = run.usage;
		return `${run.phase}${alreadyWarm ? " (already warm)" : ""} ${run.observations.join(", ")} ${chalk.dim("input")} ${usage?.inputTokens ?? 0} ${chalk.dim("cache-read")} ${usage?.cacheReadTokens ?? 0} ${chalk.dim("cache-write")} ${usage?.cacheWriteTokens ?? 0} ${chalk.dim("output")} ${usage?.outputTokens ?? run.result.outputTokens} ${chalk.dim("total")} ${usage?.totalTokens ?? 0} ${chalk.dim("cost")} ${formatCost(usage?.cost ?? 0)} ${chalk.dim("TTFT")} ${formatMs(run.result.ttftMs)} ${chalk.dim("duration")} ${formatMs(run.result.durationMs)} ${chalk.dim("throughput")} ${run.result.tokensPerSecond.toFixed(1)}/s`;
	};
	return `  ${chalk.dim(`pair ${index + 1}/${total}`)} ${formatPhase(pair.cold, pair.coldAlreadyWarm)}; ${formatPhase(pair.warm)}`;
}

interface BenchRequestOptions {
	apiKey: ApiKeyResolver;
	sessionId: string;

	messages: Context["messages"];
	maxTokens: number;

	reasoning?: Effort;

	disableReasoning?: boolean;

	serviceTier?: ServiceTier;
	promptCacheKey?: string;
	statefulResponses?: false;
	cacheCapture?: CacheRequestCapture;
}

async function runBenchRequest(
	model: Model<Api>,
	options: BenchRequestOptions,
	streamFn: BenchStreamSimple,
	now: () => number,
): Promise<BenchRunResult> {
	const startedAt = now();
	let firstTokenAt: number | undefined;
	const providerSessionState = new Map<string, ProviderSessionState>();
	try {
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: options.messages,
		};
		const stream = streamFn(model, context, {
			apiKey: options.apiKey,
			sessionId: options.sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			reasoning: options.reasoning,
			promptCacheKey: options.promptCacheKey,
			statefulResponses: options.statefulResponses,
			onPayload: options.cacheCapture
				? payload => {
						options.cacheCapture!.payloadStructure = payloadStructure(payload);
						return undefined;
					}
				: undefined,
			onResponse: options.cacheCapture
				? response => {
						options.cacheCapture!.requestIdObserved = Boolean(response.requestId);
						options.cacheCapture!.responseCacheHit = RESPONSE_CACHE_STATUS_HEADERS.some(
							header => response.headers[header]?.trim().toLowerCase() === "hit",
						);
					}
				: undefined,
			disableReasoning: options.disableReasoning,
			serviceTier: options.serviceTier,
			providerSessionState,
			preferWebsockets: true,

			headers: model.provider === "openrouter" ? { "X-OpenRouter-Cache": "false" } : undefined,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (firstTokenAt === undefined && isFirstTokenEvent(event)) {
				firstTokenAt = now();
			}
			if (event.type === "error") {
				return { ok: false, error: event.error.errorMessage ?? "request failed" };
			}
			if (event.type === "done") {
				message = event.message;
			}
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { ok: false, error: message.errorMessage ?? "request failed" };
		}
		const rawDuration = message.duration ?? now() - startedAt;
		const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
		const rawTtft = message.ttft ?? (firstTokenAt === undefined ? durationMs : firstTokenAt - startedAt);
		const ttftMs = Number.isFinite(rawTtft) && rawTtft > 0 ? rawTtft : 0;
		const outputTokens = Number.isFinite(message.usage.output) && message.usage.output > 0 ? message.usage.output : 0;

		if (firstTokenAt === undefined && outputTokens === 0 && !hasVisibleFinalContent(message)) {
			return {
				ok: false,
				error: `provider returned no output (0 tokens, empty stream; stop reason: ${message.stopReason ?? "unknown"})`,
			};
		}
		if (options.cacheCapture) options.cacheCapture.usage = captureUsage(message);

		const inputTokens =
			asNonNegativeNumber(message.usage.input) +
			asNonNegativeNumber(message.usage.cacheRead) +
			asNonNegativeNumber(message.usage.cacheWrite);
		const generationMs = Math.max(0, durationMs - ttftMs);
		return {
			ok: true,
			ttftMs,
			generationMs,
			durationMs,
			inputTokens,
			outputTokens,

			tokensPerSecond: durationMs > 0 ? (outputTokens * 1000) / durationMs : 0,
			generationTps: generationMs > 0 ? (outputTokens * 1000) / generationMs : 0,
			prefillTps: ttftMs > 0 ? (inputTokens * 1000) / ttftMs : 0,
			cost: asNonNegativeNumber(message.usage.cost?.total),
		};
	} catch (error) {
		return { ok: false, error: getErrorMessage(error) };
	} finally {
		closeProviderSessionStates(providerSessionState);
	}
}

function buildModelReport(
	selector: string,
	model: Model<Api>,
	thinking: ResolvedThinkingLevel | undefined,
	results: BenchRunResult[],
): BenchModelReport {
	const successes = results.filter((result): result is BenchRunSuccess => result.ok);
	const byChallenge: BenchModelReport["byChallenge"] = {};
	for (const kind of CHALLENGE_KINDS) {
		const kindRuns = successes.filter(r => r.challenge === kind);
		if (kindRuns.length > 0) byChallenge[kind] = computeBenchStats(kindRuns);
	}
	return {
		selector,
		model: formatModelString(model),
		thinking,
		results,
		stats: successes.length === 0 ? null : computeBenchStats(successes),
		byChallenge,
	};
}
function computeBenchStats(successes: BenchRunSuccess[]): BenchStats {
	return {
		ttftMs: metricStats(successes.map(r => r.ttftMs)),
		durationMs: metricStats(successes.map(r => r.durationMs)),
		tokensPerSecond: metricStats(successes.map(r => r.tokensPerSecond)),
		generationTps: metricStats(successes.map(r => r.generationTps)),
		prefillTps: metricStats(successes.map(r => r.prefillTps)),
		inputTokens: mean(successes.map(r => r.inputTokens)),
		outputTokens: mean(successes.map(r => r.outputTokens)),
		cost: mean(successes.map(r => r.cost)),
	};
}

function formatBenchModelLabel(report: BenchModelReport): string {
	return formatModelSelectorValue(report.model, report.thinking);
}

function formatMs(ms: number): string {
	return formatDuration(Math.max(0, Math.round(ms)));
}

function formatRunLine(result: BenchRunResult, index: number, total: number): string {
	const prefix = chalk.dim(`run ${index + 1}/${total}`);
	const kind = result.challenge ? `${chalk.cyan(result.challenge.padEnd(10))} ` : "";
	if (result.ok) {
		const gen = result.generationTps > 0 ? `${result.generationTps.toFixed(1)}/s` : "-";
		return `  ${chalk.green("✓")} ${prefix} ${kind}${chalk.dim("TTFT")} ${formatMs(result.ttftMs)} ${chalk.dim("tok/s")} ${result.tokensPerSecond.toFixed(1)} ${chalk.dim("gen")} ${gen} ${chalk.dim("in")} ${formatNumber(result.inputTokens)} ${chalk.dim("out")} ${formatNumber(result.outputTokens)} ${chalk.dim("total")} ${formatMs(result.durationMs)}`;
	}
	return `  ${chalk.red("✗")} ${prefix} ${kind}${chalk.red(truncateToWidth(replaceTabs(result.error).replace(/\r?\n/g, " "), ERROR_WIDTH))}`;
}

interface BenchLiveProgress {
	label: string;
	unit: "runs" | "pairs";
	total: number;
	completed: number;
	failed: number;
	inFlight: number;
	okCount: number;
	ttftSumMs: number;
	tpsSum: number;
}

function renderBenchProgress(progress: BenchLiveProgress | undefined, spinner: string): string[] {
	if (!progress || progress.completed >= progress.total) return [];
	const parts = [`${progress.completed}/${progress.total} ${progress.unit}`];
	if (progress.inFlight > 0) parts.push(`${progress.inFlight} in flight`);
	if (progress.failed > 0) parts.push(chalk.red(`${progress.failed} failed`));
	if (progress.okCount > 0) {
		parts.push(`TTFT ~${formatMs(progress.ttftSumMs / progress.okCount)}`);
		parts.push(`~${(progress.tpsSum / progress.okCount).toFixed(1)} tok/s`);
	}
	return [
		`  ${chalk.yellow(spinner)} ${chalk.bold(progress.label)}${chalk.dim(" · ")}${parts.join(chalk.dim(" · "))}`,
	];
}

interface BenchTableColumn {
	header: string;
	value(report: BenchModelReport): string;
}

function benchTableColumns(models: BenchModelReport[]): BenchTableColumn[] {
	const has = (kind: BenchChallengeKind): boolean => models.some(report => report.byChallenge[kind] !== undefined);

	const ttft = (report: BenchModelReport): MetricStats | undefined =>
		(report.byChallenge.chat ?? report.stats ?? undefined)?.ttftMs;
	const columns: BenchTableColumn[] = [
		{ header: "model", value: formatBenchModelLabel },
		{ header: "TTFT p50", value: r => (ttft(r) ? formatMs(ttft(r)!.p50) : "-") },
		{ header: "p95", value: r => (ttft(r) ? formatMs(ttft(r)!.p95) : "-") },
	];
	if (has("chat")) {
		columns.push({
			header: "tok/s",
			value: r => (r.byChallenge.chat ? r.byChallenge.chat.tokensPerSecond.p50.toFixed(1) : "-"),
		});
	}
	if (has("generation")) {
		columns.push({
			header: "decode",
			value: r => (r.byChallenge.generation ? r.byChallenge.generation.tokensPerSecond.p50.toFixed(1) : "-"),
		});
	}
	if (has("prefill")) {
		columns.push({
			header: "prefill",
			value: r => (r.byChallenge.prefill ? r.byChallenge.prefill.prefillTps.p50.toFixed(0) : "-"),
		});
	}
	columns.push({ header: "cost/run", value: r => (r.stats && r.stats.cost > 0 ? formatCost(r.stats.cost) : "-") });
	return columns;
}

function formatBenchTable(summary: BenchSummary): string {
	const rank = (report: BenchModelReport): number =>
		report.byChallenge.chat?.tokensPerSecond.p50 ??
		report.byChallenge.generation?.tokensPerSecond.p50 ??
		report.byChallenge.prefill?.prefillTps.p50 ??
		report.stats?.tokensPerSecond.p50 ??
		Number.NEGATIVE_INFINITY;
	const ranked = [...summary.models].sort((a, b) => rank(b) - rank(a));
	const columns = benchTableColumns(summary.models);
	const rows = ranked.map(report => ({
		cells: columns.map(column => column.value(report)),
		failed: report.results.filter(result => !result.ok).length,
		hasStats: report.stats !== null,
	}));
	const widths = columns.map((column, index) =>
		Math.max(column.header.length, ...rows.map(row => row.cells[index]!.length)),
	);
	const lines = [
		chalk.dim(
			columns
				.map((column, i) => column.header.padEnd(widths[i]!))
				.join("  ")
				.trimEnd(),
		),
	];
	let winnerMarked = false;
	for (const row of rows) {
		const cells = row.cells.map((cell, i) => cell.padEnd(widths[i]!));
		if (!winnerMarked && row.hasStats) {
			cells[0] = chalk.green(cells[0]!);
			winnerMarked = true;
		}
		const failedSuffix = row.failed > 0 ? `  ${chalk.red(`(${row.failed} failed)`)}` : "";
		lines.push(cells.join("  ").trimEnd() + failedSuffix);
	}
	return `${lines.join("\n")}\n`;
}

async function createDefaultRuntime(): Promise<BenchRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((a, b) => {
		const aRank = priority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = priority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return aRank - bRank;
	})[0];
}

function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;

	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};

	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

function resolveBenchModels(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): BenchTarget[] {
	const preferences = getModelMatchPreferences(settings);
	const resolved: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			availableModels: modelRegistry.getAll(),
			settings,
			preferences,
		});
		if (result.error) {
			errors.push(`${selector}: ${result.error}`);
			continue;
		}
		if (!result.model) {
			errors.push(`${selector}: model not found`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`Warning: ${result.warning}`)}\n`);
		let model = result.model;
		const authSelector = result.configuredPatterns?.[result.configuredPatternIndex ?? 0] ?? selector;
		const authenticated = resolveAuthenticatedAlternative(
			authSelector,
			model,
			modelRegistry,
			preferences.providerOrder,
		);
		if (authenticated) {
			writeStderr(
				`${chalk.yellow(
					`Warning: no credentials for "${model.provider}"; benchmarking ${formatModelString(authenticated)} instead. Pin "${formatModelString(model)}" to force it.`,
				)}\n`,
			);
			model = authenticated;
		}
		resolved.push({
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, result.thinkingLevel),
		});
	}
	if (errors.length > 0) {
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	}
	return resolved;
}
function assertCacheModeSupported(targets: BenchTarget[]): void {
	if (targets.some(({ model }) => model.api === "openai-codex-responses")) {
		throw new Error(
			"--cache is not supported for openai-codex-responses because Codex WebSocket chaining cannot produce independent prompt-cache pairs",
		);
	}
}

export async function runBenchCommand(command: BenchCommandArgs, deps: BenchDependencies = {}): Promise<BenchSummary> {
	const cacheMode = command.flags.cache === true;
	const cacheFlagsUsed =
		command.flags.cachePrefixFile !== undefined ||
		command.flags.cachePrefixBytes !== undefined ||
		command.flags.cachePairs !== undefined ||
		command.flags.cacheConcurrency !== undefined;
	if (!cacheMode && cacheFlagsUsed) throw new Error("Cache flags require --cache");
	if (cacheMode && command.flags.runs !== undefined)
		throw new Error("Use --cache-pairs instead of --runs with --cache");
	if (cacheMode && command.flags.prompt !== undefined) throw new Error("--cache builds its own stable-prefix prompts");
	if (cacheMode && command.flags.profile !== undefined) throw new Error("--profile cannot be combined with --cache");
	if (cacheMode && (command.flags.par ?? 1) > 1) {
		throw new Error("--par cannot parallelize cold/warm pairs; use --cache-concurrency instead");
	}
	const profileFlag = command.flags.profile;
	if (
		profileFlag !== undefined &&
		profileFlag !== "mix" &&
		profileFlag !== "chat" &&
		profileFlag !== "prefill" &&
		profileFlag !== "generation"
	) {
		throw new Error(`Unknown --profile "${profileFlag}" (expected mix, chat, prefill, or generation)`);
	}
	const profile: BenchProfile = profileFlag ?? "mix";
	if (!cacheMode && command.flags.prompt !== undefined && profile !== "chat" && profile !== "generation") {
		throw new Error("--prompt requires --profile chat or generation");
	}
	if (command.flags.prefillBytes !== undefined && (cacheMode || (profile !== "mix" && profile !== "prefill"))) {
		throw new Error("--prefill-bytes requires prefill challenges (--profile mix or prefill)");
	}

	const cachePairs = cacheMode
		? normalizePositiveInteger("cache-pairs", command.flags.cachePairs, DEFAULT_CACHE_PAIRS)
		: undefined;
	const cacheConcurrency = cacheMode
		? normalizePositiveInteger("cache-concurrency", command.flags.cacheConcurrency, DEFAULT_CACHE_CONCURRENCY)
		: undefined;
	const runs = cacheMode
		? cachePairs! * 2
		: normalizePositiveInteger("runs", command.flags.runs, PROFILE_DEFAULT_RUNS[profile]);
	const maxTokensOverride =
		command.flags.maxTokens !== undefined
			? normalizePositiveInteger("max-tokens", command.flags.maxTokens, 1)
			: undefined;
	const cacheMaxTokens = cacheMode ? (maxTokensOverride ?? DEFAULT_CACHE_MAX_TOKENS) : undefined;
	const par =
		command.flags.par !== undefined ? normalizePositiveInteger("par", command.flags.par, DEFAULT_PAR) : DEFAULT_PAR;
	const promptOverride = command.flags.prompt?.trim() || undefined;
	const prefillBytes = normalizePositiveInteger("prefill-bytes", command.flags.prefillBytes, DEFAULT_PREFILL_BYTES);
	const kinds: readonly BenchChallengeKind[] = profile === "mix" ? CHALLENGE_KINDS : [profile];
	const random = deps.random ?? Math.random;
	const json = command.flags.json === true;
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const readTextFile = deps.readTextFile ?? readBoundedUtf8File;
	const cachePrefix = cacheMode ? await resolveCachePrefix(command.flags, readTextFile) : undefined;
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const streamFn = deps.streamSimple ?? streamSimple;
	const now = deps.now ?? (() => performance.now());
	const interactive = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (command.models.length === 0) {
		throw new Error("Pass at least one model selector, e.g. `proto bench opus gpt-5.2`");
	}
	let progress: BenchLiveProgress | undefined;
	const board = json
		? undefined
		: createLiveBoard(spinner => renderBenchProgress(progress, spinner), {
				isTTY: interactive,
				get columns() {
					return process.stdout.columns;
				},
				get rows() {
					return process.stdout.rows;
				},
				write(text: string): boolean {
					writeStdout(text);
					return true;
				},
			} satisfies LiveBoardOutput);
	const print = (text: string): void => {
		if (board) board.log(text);
		else writeStdout(`${text}\n`);
	};

	const runtime = await (deps.createRuntime ?? createDefaultRuntime)();
	try {
		const targets = resolveBenchModels(command.models, runtime.modelRegistry, runtime.settings, writeStderr);
		if (cacheMode) assertCacheModeSupported(targets);

		const flagTier = command.flags.serviceTier ? serviceTierSettingToTier(command.flags.serviceTier) : undefined;
		const serviceTierByFamily = command.flags.serviceTier
			? serviceTierForAllFamilies(flagTier)
			: buildServiceTierByFamily(
					runtime.settings?.get("tier.openai") ?? "none",
					runtime.settings?.get("tier.anthropic") ?? "none",
					runtime.settings?.get("tier.google") ?? "none",
				);
		if (!json && flagTier) print(chalk.dim(`service tier: ${flagTier}`));
		const reports: BenchModelReport[] = [];
		for (const { selector, model, thinking } of targets) {
			if (!json) {
				const resolvedModel = formatModelSelectorValue(formatModelString(model), thinking);
				const resolvedNote = selector === resolvedModel ? "" : chalk.dim(` (${selector})`);
				print(`${chalk.bold(resolvedModel)}${resolvedNote}`);
				progress = {
					label: resolvedModel,
					unit: cacheMode ? "pairs" : "runs",
					total: cacheMode ? cachePairs! : runs,
					completed: 0,
					failed: 0,
					inFlight: 0,
					okCount: 0,
					ttftSumMs: 0,
					tpsSum: 0,
				};
				board?.repaint();
			}
			const results: BenchRunResult[] = [];

			const testSessionId = randomSessionId();
			const preflightKey = await runtime.modelRegistry.getApiKey(model, testSessionId);
			if (!preflightKey) {
				const failure: BenchRunFailure = {
					ok: false,
					error: `No credentials for provider "${model.provider}". Run \`proto\` and use /login, or set the provider API key.`,
				};
				results.push(failure);
				if (!json) print(formatRunLine(failure, 0, runs));
				progress = undefined;
				board?.repaint();
				const report = buildModelReport(selector, model, thinking, results);
				if (cacheMode) report.cachePairs = [];
				reports.push(report);
				continue;
			}

			const serviceTier = resolveModelServiceTier(serviceTierByFamily, model);
			if (cacheMode) {
				const pairs = await runWithConcurrency(
					cachePairs!,
					cacheConcurrency!,
					async (pairIndex): Promise<BenchCachePairReport> => {
						const cacheNamespace = randomSessionId();
						if (progress) {
							progress.inFlight++;
							board?.repaint();
						}
						const promptCacheKey = `bench-cache:${cacheNamespace}`;
						const stablePrefix = renderCacheBenchmarkPrefix(cachePrefix!, cacheNamespace);
						const coldSuffix = prompt.render(cacheSuffixTemplate, { variant: "A" }).trim();
						const warmSuffix = prompt.render(cacheSuffixTemplate, { variant: "B" }).trim();
						const coldCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};

						const credentialAffinitySessionId = pairIndex === 0 ? testSessionId : randomSessionId();
						const credentialResolver = runtime.modelRegistry.resolver(model, credentialAffinitySessionId);
						const coldResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								messages: cacheBenchmarkMessages(stablePrefix, coldSuffix),
								maxTokens: cacheMaxTokens!,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: coldCapture,
							},
							streamFn,
							now,
						);
						const warmCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};
						const warmResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								messages: cacheBenchmarkMessages(stablePrefix, warmSuffix),
								maxTokens: cacheMaxTokens!,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: warmCapture,
							},
							streamFn,
							now,
						);
						if (progress) {
							progress.inFlight--;
							progress.completed++;
							for (const result of [coldResult, warmResult]) {
								if (result.ok) {
									progress.okCount++;
									progress.ttftSumMs += result.ttftMs;
									progress.tpsSum += result.tokensPerSecond;
								} else {
									progress.failed++;
								}
							}
							board?.repaint();
						}
						return {
							cold: cacheRunReport("cold", coldResult, coldCapture),
							warm: cacheRunReport("warm", warmResult, warmCapture),
							coldAlreadyWarm: (coldCapture.usage?.cacheReadTokens ?? 0) > 0 || coldCapture.responseCacheHit,
							stablePrefix: true,
							suffixChanged: true,
							promptCacheKeyStable: true,
							statefulResponsesDisabled: true,
							freshProviderSessionState: true,
							payloadStructureStable:
								coldCapture.payloadStructure === undefined || warmCapture.payloadStructure === undefined
									? "unavailable"
									: coldCapture.payloadStructure === warmCapture.payloadStructure,
						};
					},
				);
				for (const pair of pairs) results.push(pair.cold.result, pair.warm.result);
				const report = buildModelReport(selector, model, thinking, results);
				report.cachePairs = pairs;
				reports.push(report);
				if (!json) {
					for (const [index, pair] of pairs.entries()) {
						print(formatCachePairLine(pair, index, pairs.length));
					}
				}
				continue;
			}

			let nextToPrint = 0;
			const runWorker = async (index: number) => {
				const sessionId = index === 0 ? testSessionId : randomSessionId();
				const challenge = buildBenchChallenge(kinds[index % kinds.length]!, {
					promptOverride,
					prefillBytes,
					nonce: randomSessionId(),
					random,
					maxTokensOverride,
				});
				const result = await runBenchRequest(
					model,
					{
						apiKey: runtime.modelRegistry.resolver(model, sessionId),
						sessionId,
						messages: challenge.messages,
						maxTokens: challenge.maxTokens,
						reasoning: toReasoningEffort(thinking),
						disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
						serviceTier,
					},
					streamFn,
					now,
				);
				results[index] = { ...result, challenge: challenge.kind };
			};
			const queue = Array.from({ length: runs }, (_, i) => i);
			const activeWorkers: Promise<void>[] = [];
			const processNext = async (): Promise<void> => {
				if (queue.length === 0) return;
				const index = queue.shift()!;
				if (progress) {
					progress.inFlight++;
					board?.repaint();
				}
				await runWorker(index);
				if (progress) {
					progress.inFlight--;
					progress.completed++;
					const result = results[index]!;
					if (result.ok) {
						progress.okCount++;
						progress.ttftSumMs += result.ttftMs;
						progress.tpsSum += result.tokensPerSecond;
					} else {
						progress.failed++;
					}
					board?.repaint();
				}
				if (!json) {
					while (nextToPrint < runs && results[nextToPrint] !== undefined) {
						print(formatRunLine(results[nextToPrint], nextToPrint, runs));
						nextToPrint++;
					}
				}
				await processNext();
			};
			for (let worker = 0; worker < Math.min(par, runs); worker++) activeWorkers.push(processNext());
			await Promise.all(activeWorkers);
			reports.push(buildModelReport(selector, model, thinking, results));
		}
		const failures = reports.reduce((sum, report) => sum + report.results.filter(result => !result.ok).length, 0);
		const summary: BenchSummary = {
			runs,
			...(cacheMode
				? { maxTokens: cacheMaxTokens }
				: maxTokensOverride !== undefined
					? { maxTokens: maxTokensOverride }
					: {}),
			models: reports,
			failures,
			serviceTierByFamily,
			...(cacheMode ? { cache: { pairs: cachePairs!, concurrency: cacheConcurrency! } } : { profile }),
		};
		progress = undefined;
		if (json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else if (!cacheMode && (reports.length > 1 || runs > 1)) {
			print(`\n${formatBenchTable(summary)}`.trimEnd());
		}
		if (failures > 0) setExitCode(1);
		return summary;
	} finally {
		board?.close();
		runtime.close?.();
	}
}
