import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import type { LiteralCompletionArgs, StreamedCompletionLanguage } from "./speculation";

export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

const STRUCTURED_TOOL_NAME = "respond";
export type CompletionTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const completionArgsSchema = type({
	prompt: "string>0",
	"model?": "'smol'|'default'|'slow'",
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
	details: { model: string; tier: CompletionTier; structured: boolean };
}

interface ResolvedCompletionRequest {
	parsed: {
		prompt: string;
		model?: CompletionTier;
		system?: string;
		schema?: Record<string, unknown>;
	};
	finalTier: CompletionTier;
	model: Model<Api>;
	registry: NonNullable<ToolSession["modelRegistry"]>;
}

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
		model?: CompletionTier;
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

async function resolveCompletionRequest(args: unknown, session: ToolSession): Promise<ResolvedCompletionRequest> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const finalTier: CompletionTier = parsed.model ?? "default";
	const model = resolveTierModel(finalTier, session);
	if (!model) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}
	const registry = session.modelRegistry;
	const apiKey = await registry?.getApiKey(model);
	if (!registry || !apiKey) {
		throw new ToolError(
			`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
		);
	}
	return { parsed, finalTier, model, registry };
}

function resolveTierModel(tier: CompletionTier, session: ToolSession): Model<Api> | undefined {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return undefined;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, available, matchPreferences);
	};

	if (tier === "default") {
		const activePattern = session.getActiveModelString?.() ?? session.getModelString?.();
		return resolve(activePattern) ?? resolve(TIER_TO_PATTERN.default);
	}
	return resolve(TIER_TO_PATTERN[tier]);
}

function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
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
	if (!context) return undefined;
	const fingerprint = resolvedArgsFingerprint(context.language, request.parsed);
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
		(entry.args.model ?? "default") !== request.finalTier ||
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
		if (result.details.model !== formatModelString(request.model) || result.details.tier !== request.finalTier)
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
	const request = await resolveCompletionRequest(args, options.session);
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
	const { parsed, finalTier, model, registry } = request;
	const { prompt, system, schema } = parsed;
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
	const response = await withBridgeTimeoutPause(options.emitStatus, () =>
		instrumentedCompleteSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: registry.resolver(model, options.session.getSessionId?.() ?? undefined),
				fetch: options.session.fetch,
				signal: options.signal,
				reasoning: reasoningForTier(finalTier, model),
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
			},
			{ telemetry, oneshotKind: "eval_completion" },
		),
	);
	if (response.stopReason === "error") throw new ToolError(response.errorMessage ?? "completion() request failed.");
	if (response.stopReason === "aborted") throw new ToolError("completion() request aborted.");
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
			tier: finalTier,
			chars: resultText.length,
		});
	}
	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema) },
	};
}
