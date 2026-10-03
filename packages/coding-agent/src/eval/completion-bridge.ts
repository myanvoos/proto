import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, Tool, UserContent } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveModelFromString,
	resolveModelOverride,
	resolveProviderModelReference,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";
import { Semaphore } from "../task/parallel";
import { shouldDisableReasoning, type ThinkingLevel, toReasoningEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import { MAX_EVAL_COMPLETION_TEXT_BYTES, resolveEvalCompletionContent } from "./completion-content";

export * from "./completion-content";

import type { JsStatusEvent } from "./js/shared/types";
import type { LiteralCompletionArgs, StreamedCompletionLanguage } from "./speculation";

export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

const STRUCTURED_TOOL_NAME = "respond";

/**
 * Process-wide ceiling on completion requests in flight. A cell fanning out hundreds of `completion()` calls would
 * otherwise open them all at once and, once the primary rejects, flood every fallback in the role chain.
 */
const EVAL_COMPLETION_CONCURRENCY = 32;
const completionSlots = new Semaphore(EVAL_COMPLETION_CONCURRENCY);
export type CompletionTier = "tiny" | "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	tiny: "@tiny",
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const TIER_LIST = Object.keys(TIER_TO_PATTERN)
	.map(tier => `"${tier}"`)
	.join(", ");

function asCompletionTier(value: string): CompletionTier | undefined {
	return Object.hasOwn(TIER_TO_PATTERN, value) ? (value as CompletionTier) : undefined;
}

const completionArgsSchema = type({
	prompt: "unknown",
	"model?": "string>0",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionInvocationContext {
	toolCallId: string;
	generation: number;
	language: StreamedCompletionLanguage;
	/** Fingerprints in source order, indexed by the runtime's completion ordinal. */
	candidateFingerprints: readonly string[];
}

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	completionContext?: EvalCompletionInvocationContext;
	completionInvocationId?: string;
	/** Internal: speculative calls never emit model-visible status events. */
	suppressStatus?: boolean;
}

export interface EvalCompletionResult {
	text: string;
	details: { model: string; selector: string; tier?: CompletionTier; structured: boolean };
}

interface ResolvedCompletionRequest {
	content: UserContent[];
	parsed: {
		prompt: unknown;
		model?: string;
		system?: string;
		schema?: Record<string, unknown>;
	};
	/** Selector exactly as requested: a tier name or a model reference. Identity for speculation claims. */
	selector: string;
	/** Set only when the selector named a role tier. */
	tier?: CompletionTier;
	/** The resolved model first, then a tier's retry-fallback chain in the order session recovery walks it. */
	candidates: CompletionCandidate[];
	registry: CompletionRegistry;
}

type CompletionRegistry = NonNullable<ToolSession["modelRegistry"]>;

interface CompletionCandidate {
	model: Model<Api>;
	reasoning: Effort | undefined;
	disableReasoning: boolean;
}

type CandidateReasoning = Pick<CompletionCandidate, "reasoning" | "disableReasoning">;

interface SpeculativeCompletion {
	key: string;
	toolCallId: string;
	generation: number;
	invocationId: string;
	fingerprint: string;
	args: LiteralCompletionArgs;
	controller: AbortController;
	promise: Promise<EvalCompletionResult>;
}

const speculationBySession = new WeakMap<object, Map<string, SpeculativeCompletion>>();

function sessionSpeculation(session: ToolSession): Map<string, SpeculativeCompletion> {
	let entries = speculationBySession.get(session);
	if (!entries) {
		entries = new Map();
		speculationBySession.set(session, entries);
	}
	return entries;
}

function resolvedArgsFingerprint(
	language: StreamedCompletionLanguage,
	args: {
		prompt: string;
		model?: string;
		system?: string;
		schema?: Record<string, unknown>;
	},
): string {
	return JSON.stringify({
		language,
		args: {
			prompt: args.prompt,
			model: args.model ?? "default",
			...(args.system !== undefined ? { system: args.system } : {}),
			...(args.schema !== undefined ? { schema: args.schema } : {}),
		},
	});
}

function invocationKey(context: EvalCompletionInvocationContext, invocationId: string, fingerprint: string): string {
	return `${context.toolCallId}\0${context.generation}\0${invocationId}\0${fingerprint}`;
}

async function resolveCompletionRequest(
	args: unknown,
	session: ToolSession,
	signal?: AbortSignal,
): Promise<ResolvedCompletionRequest> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const selector = parsed.model ?? "default";
	const tier = asCompletionTier(selector);
	let candidates: CompletionCandidate[];
	if (tier) {
		candidates = resolveTierCandidates(tier, session);
		if (candidates.length === 0) {
			throw new ToolError(
				`completion() could not resolve a model for the "${tier}" tier. Configure modelRoles.${tier} or ensure a provider is available.`,
			);
		}
	} else {
		candidates = [{ model: resolveRequestedModel(selector, session), reasoning: undefined, disableReasoning: false }];
	}
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("completion() has no model registry.");
	const content = await resolveEvalCompletionContent(parsed.prompt, { session, model: candidates[0].model, signal });
	if (parsed.system && Buffer.byteLength(parsed.system) > MAX_EVAL_COMPLETION_TEXT_BYTES)
		throw new ToolError(`Completion system text exceeds ${MAX_EVAL_COMPLETION_TEXT_BYTES} byte limit`);
	return { parsed, content, selector, tier, candidates, registry };
}

/** Pool entries whose id contains the requested one, so a typo names its neighbours. */
function suggestModelReferences(reference: string, available: readonly Model<Api>[]): string[] {
	const needle = reference.slice(reference.indexOf("/") + 1).toLowerCase();
	const suggestions: string[] = [];
	for (const model of available) {
		if (!model.id.toLowerCase().includes(needle)) continue;
		suggestions.push(formatModelString(model));
		if (suggestions.length === 5) break;
	}
	return suggestions;
}

function unknownModelError(reference: string, available: readonly Model<Api>[]): ToolError {
	const suggestions = suggestModelReferences(reference, available);
	const hint = suggestions.length > 0 ? ` Closest available: ${suggestions.join(", ")}.` : "";
	return new ToolError(
		`completion() model "${reference}" is not in the model pool. Pass a tier (${TIER_LIST}) or an available model id.${hint}`,
	);
}

/**
 * Resolve a caller-supplied model reference against the session's pool. A bare id is accepted
 * only when a single provider offers it; when several do, the call fails and asks for an explicit
 * `provider/id` rather than silently landing on whichever provider sorts first.
 */
function resolveRequestedModel(reference: string, session: ToolSession): Model<Api> {
	const available = session.modelRegistry?.getAvailable() ?? [];
	if (available.length === 0) {
		throw new ToolError(
			`completion() has no models available; configure a provider before requesting "${reference}".`,
		);
	}
	const slashIndex = reference.indexOf("/");
	if (slashIndex > 0) {
		const match = resolveProviderModelReference(
			reference.slice(0, slashIndex),
			reference.slice(slashIndex + 1),
			available,
		);
		if (!match) throw unknownModelError(reference, available);
		return match;
	}
	const lowerReference = reference.toLowerCase();
	const matches = available.filter(model => model.id.toLowerCase() === lowerReference);
	const first = matches[0];
	if (!first) throw unknownModelError(reference, available);
	const providers = [...new Set(matches.map(model => model.provider))].sort();
	if (providers.length > 1) {
		throw new ToolError(
			`completion() model "${reference}" is ambiguous: ${providers.join(", ")} all provide it. Qualify it as ${providers.map(provider => `"${provider}/${first.id}"`).join(" or ")}.`,
		);
	}
	return first;
}

function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

/**
 * Effort for one candidate: an explicit `:level` suffix wins; a bare nested fallback inherits the effort of the
 * candidate it replaces; a bare root candidate gets the tier default.
 */
function reasoningForCandidate(
	tier: CompletionTier,
	model: Model<Api>,
	level?: ThinkingLevel,
	parent?: CandidateReasoning,
): CandidateReasoning {
	if (shouldDisableReasoning(level)) return { reasoning: undefined, disableReasoning: true };
	const explicit = toReasoningEffort(level);
	if (explicit !== undefined)
		return { reasoning: clampThinkingLevelForModel(model, explicit), disableReasoning: false };
	if (parent?.disableReasoning) return { reasoning: undefined, disableReasoning: true };
	const requested = parent ? parent.reasoning : reasoningForTier(tier, model);
	return { reasoning: clampThinkingLevelForModel(model, requested), disableReasoning: false };
}

function effortKey(reasoning: CandidateReasoning): string {
	return reasoning.disableReasoning ? "off" : (reasoning.reasoning ?? "inherit");
}

// A chain may retry the same model at another effort, so identity folds in the effective reasoning.
function candidateIdentity(model: Model<Api>, reasoning: CandidateReasoning): string {
	return `${formatModelStringWithRouting(model)}|${effortKey(reasoning)}`;
}

interface FallbackExpansion {
	context: RetryFallbackResolutionContext;
	registry: CompletionRegistry;
	settings: Settings;
	tier: CompletionTier;
	disabledProviders: Set<string>;
	seen: Set<string>;
	expanded: Set<string>;
	out: CompletionCandidate[];
}

/**
 * Appends the chain that applies to `selector`, depth-first walking each appended candidate's own chain the way
 * session recovery does. `roleHint` (the tier) applies to the root only, so a nested leaf cannot jump back into the
 * tier chain and reorder its siblings; visits are keyed by selector and inherited effort.
 */
function appendFallbackCandidates(
	deps: FallbackExpansion,
	selector: string,
	model: Model<Api>,
	parent: CandidateReasoning | undefined,
	roleHint: string | undefined,
): void {
	const visit = parent ? `${selector}|${effortKey(parent)}` : selector;
	if (deps.expanded.has(visit)) return;
	deps.expanded.add(visit);
	const chainKey = resolveRetryFallbackChainKey(deps.context, selector, model, roleHint);
	if (!chainKey) return;
	for (const entry of findRetryFallbackCandidates(deps.context, chainKey, selector, model, {
		allowMissingPrimary: true,
	})) {
		const candidate = resolveModelOverride([entry.raw], deps.registry, deps.settings).model;
		if (!candidate || deps.disabledProviders.has(candidate.provider)) continue;
		const reasoning = reasoningForCandidate(deps.tier, candidate, entry.thinkingLevel, parent);
		const identity = candidateIdentity(candidate, reasoning);
		if (deps.seen.has(identity)) continue;
		deps.seen.add(identity);
		deps.out.push({ model: candidate, ...reasoning });
		appendFallbackCandidates(deps, entry.raw, candidate, reasoning, undefined);
	}
}

/** A tier's model (`default` prefers the session's active model) followed by its configured retry fallbacks. */
function resolveTierCandidates(tier: CompletionTier, session: ToolSession): CompletionCandidate[] {
	const registry = session.modelRegistry;
	if (!registry) return [];
	const available = registry.getAvailable();
	if (available.length === 0) return [];

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): { model: Model<Api>; selector: string } | undefined => {
		if (!pattern) return undefined;
		const selector = expandRoleAlias(pattern, session.settings);
		const model = resolveModelFromString(selector, available, matchPreferences);
		return model ? { model, selector } : undefined;
	};
	const primary =
		tier === "default"
			? (resolve(session.getActiveModelString?.() ?? session.getModelString?.()) ?? resolve(TIER_TO_PATTERN.default))
			: resolve(TIER_TO_PATTERN[tier]);
	if (!primary) return [];

	const root: CompletionCandidate = { model: primary.model, ...reasoningForCandidate(tier, primary.model) };
	const candidates = [root];
	if (!session.settings.get("retry.enabled") || !session.settings.get("retry.modelFallback")) return candidates;
	appendFallbackCandidates(
		{
			context: {
				chains: getRetryFallbackChains(session.settings),
				getModelRole: role => session.settings.getModelRole(role),
				modelLookup: registry,
			},
			registry,
			settings: session.settings,
			tier,
			disabledProviders: new Set(session.settings.get("disabledProviders")),
			seen: new Set([candidateIdentity(root.model, root)]),
			expanded: new Set(),
			out: candidates,
		},
		primary.selector,
		primary.model,
		undefined,
		tier,
	);
	return candidates;
}

function isCurrentContextCandidate(
	options: EvalCompletionBridgeOptions,
	fingerprint: string,
): { key: string; invocationId: string } | undefined {
	const context = options.completionContext;
	const invocationId = options.completionInvocationId;
	if (!context || invocationId === undefined || !/^\d+$/u.test(invocationId)) return undefined;
	const index = Number(invocationId);
	if (!Number.isSafeInteger(index) || context.candidateFingerprints[index] !== fingerprint) return undefined;
	return { key: invocationKey(context, invocationId, fingerprint), invocationId };
}

/**
 * Start one network completion without executing the surrounding partial cell.
 * The future is retained under the exact outer call/generation/ordinal/source key;
 * errors are intentionally swallowed until a matching final invocation claims it.
 */
export async function startEvalCompletionSpeculation(options: {
	session: ToolSession;
	toolCallId: string;
	generation: number;
	invocationId: string;
	fingerprint: string;
	args: LiteralCompletionArgs;
	language: StreamedCompletionLanguage;
	candidateFingerprints?: readonly string[];
}): Promise<void> {
	if (options.session.settings.get("kernel.speculation.enabled") !== true) return;
	const entries = sessionSpeculation(options.session);
	const context: EvalCompletionInvocationContext = {
		toolCallId: options.toolCallId,
		generation: options.generation,
		language: options.language,
		candidateFingerprints: options.candidateFingerprints ?? [options.fingerprint],
	};
	const key = invocationKey(context, options.invocationId, options.fingerprint);
	if (entries.has(key)) return;
	const controller = new AbortController();
	const promise = runEvalCompletion(options.args, {
		session: options.session,
		signal: controller.signal,
		suppressStatus: true,
	}).then(result => result);
	const entry: SpeculativeCompletion = {
		key,
		toolCallId: options.toolCallId,
		generation: options.generation,
		invocationId: options.invocationId,
		fingerprint: options.fingerprint,
		args: options.args,
		controller,
		promise,
	};
	entries.set(key, entry);
	void promise
		.catch(() => undefined)
		.finally(() => {
			// Keep a settled successful future available for the final call to claim;
			// failed futures are removed so a normal final request can retry.
			if (entries.get(key) === entry) {
				void promise.then(
					() => undefined,
					() => entries.delete(key),
				);
			}
		});
}

export function cancelEvalCompletionSpeculation(toolCallId?: string, generation?: number, session?: ToolSession): void {
	const sessions = session ? [session] : [];
	for (const owner of sessions) {
		const entries = speculationBySession.get(owner);
		if (!entries) continue;
		for (const [key, entry] of entries) {
			if (toolCallId !== undefined && entry.toolCallId !== toolCallId) continue;
			if (generation !== undefined && entry.generation !== generation) continue;
			entries.delete(key);
			entry.controller.abort();
		}
		if (entries.size === 0) speculationBySession.delete(owner);
	}
}

export function cancelAllEvalCompletionSpeculation(session: ToolSession): void {
	cancelEvalCompletionSpeculation(undefined, undefined, session);
}

async function claimEvalCompletion(
	request: ResolvedCompletionRequest,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult | undefined> {
	const context = options.completionContext;
	if (!context || typeof request.parsed.prompt !== "string") return undefined;
	const fingerprint = resolvedArgsFingerprint(context.language, { ...request.parsed, prompt: request.parsed.prompt });
	const current = isCurrentContextCandidate(options, fingerprint);
	if (!current) return undefined;
	const entries = speculationBySession.get(options.session);
	const entry = entries?.get(current.key);
	if (!entry) return undefined;
	// The model and all options are resolved again at final execution time. A
	// role switch, credential change, or schema mismatch cannot consume stale work.
	if (
		entry.fingerprint !== fingerprint ||
		entry.args.prompt !== request.parsed.prompt ||
		(entry.args.model ?? "default") !== request.selector ||
		(entry.args.system ?? undefined) !== request.parsed.system ||
		JSON.stringify(entry.args.schema ?? undefined) !== JSON.stringify(request.parsed.schema ?? undefined)
	) {
		entries?.delete(current.key);
		entry.controller.abort();
		return undefined;
	}
	let removeAbortListener: (() => void) | undefined;
	if (options.signal) {
		if (options.signal.aborted) {
			entry.controller.abort(options.signal.reason);
			return undefined;
		}
		const onAbort = () => entry.controller.abort(options.signal?.reason);
		options.signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
	}
	try {
		const result = options.signal ? await untilAborted(options.signal, entry.promise) : await entry.promise;
		if (entries?.get(current.key) === entry) entries.delete(current.key);
		if (
			result.details.selector !== request.selector ||
			!request.candidates.some(candidate => formatModelString(candidate.model) === result.details.model)
		)
			return undefined;
		return result;
	} catch {
		if (entries?.get(current.key) === entry) entries.delete(current.key);
		return undefined;
	} finally {
		removeAbortListener?.();
	}
}

export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const request = await resolveCompletionRequest(args, options.session, options.signal);
	const claimed = await claimEvalCompletion(request, options);
	if (claimed) {
		if (!options.suppressStatus) {
			options.emitStatus?.({
				op: "completion",
				model: claimed.details.model,
				tier: claimed.details.tier,
				chars: claimed.text.length,
			});
		}
		return claimed;
	}
	const { parsed, content, selector, tier, candidates, registry } = request;
	const { system, schema } = parsed;
	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;
	const telemetry = resolveTelemetry(options.session.getTelemetry?.(), options.session.getSessionId?.() ?? undefined);
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];
	const sessionId = options.session.getSessionId?.() ?? undefined;
	// Like session recovery, each fallback that reaches the provider spends one retry; keyless candidates are
	// skipped for free so a usable later fallback is still tried.
	const maxRetries = Math.max(0, options.session.settings.get("retry.maxRetries") ?? 0);
	let response: AssistantMessage | undefined;
	let model: Model<Api> | undefined;
	let lastError: unknown;
	let retriesUsed = 0;
	for (const [index, candidate] of candidates.entries()) {
		if (index > 0 && retriesUsed >= maxRetries) break;
		if (!(await registry.getApiKey(candidate.model, sessionId, { signal: options.signal }))) {
			lastError = new ToolError(
				`completion() has no API key for ${formatModelString(candidate.model)}. Configure credentials for this provider or choose another model.`,
			);
			continue;
		}
		if (index > 0) retriesUsed += 1;
		let attempt: AssistantMessage;
		try {
			attempt = await withBridgeTimeoutPause(options.emitStatus, async () => {
				await completionSlots.acquire(options.signal);
				try {
					return await instrumentedCompleteSimple(
						candidate.model,
						{
							systemPrompt,
							messages: [{ role: "user", content, timestamp: Date.now() }],
							tools,
						},
						{
							apiKey: registry.resolver(candidate.model, sessionId),
							fetch: options.session.fetch,
							signal: options.signal,
							reasoning: candidate.reasoning,
							disableReasoning: candidate.disableReasoning,
							toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
						},
						{ telemetry, oneshotKind: "eval_completion" },
					);
				} finally {
					completionSlots.release();
				}
			});
		} catch (error) {
			if (options.signal?.aborted) throw error;
			lastError = error;
			continue;
		}
		if (attempt.stopReason === "aborted") throw new ToolError("completion() request aborted.");
		if (attempt.stopReason === "error") {
			lastError = new ToolError(attempt.errorMessage ?? "completion() request failed.");
			if (options.signal?.aborted) throw lastError;
			continue;
		}
		response = attempt;
		model = candidate.model;
		break;
	}
	if (!response || !model)
		throw lastError instanceof Error ? lastError : new ToolError("completion() request failed.");
	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) value = call.arguments;
		else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("completion() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("completion() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("completion() returned no text output.");
	}
	if (!options.suppressStatus) {
		options.emitStatus?.({
			op: "completion",
			model: formatModelString(model),
			tier,
			chars: resultText.length,
		});
	}
	return {
		text: resultText,
		details: { model: formatModelString(model), selector, tier, structured: Boolean(schema) },
	};
}
