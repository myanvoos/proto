/**
 * The model judge behind `llm:` rule conditions.
 *
 * A judge answers one yes/no question about one buffer on a small model — the
 * `tiny` role, falling back to `smol` — so a rule can express the conditions no
 * regex or AST pattern can: "is this `Set` built from a fixed literal list?",
 * "does this commit message describe something the diff does not do?".
 *
 * Judgements are budgeted. Every verdict is cached by question, role chain, and
 * buffer hash, the session is capped, and the matcher only asks once every
 * cheaper condition in the rule has already matched.
 */

import type { Api, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { JudgeFn, JudgeRequest } from "../export/ttsr-matcher";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import ttsrJudgePrompt from "../prompts/system/ttsr-judge.md" with { type: "text" };
import { truncateMiddle } from "./streaming-output";

/** Judged buffers are rule-sized, not file-sized; the middle of a huge one carries no verdict. */
const MAX_CONTENT_BYTES = 6000;
const MAX_CONTENT_LINES = 200;

/** Reasoning models ignore `disableReasoning` on some providers; leave room for the tokens they spend anyway. */
const ANSWER_MAX_TOKENS = 2048;

/** Per-session ceiling, so a pathological rule cannot turn every turn into a model call. */
const MAX_JUDGEMENTS = 64;

/** A judge sits between the model and the tool it is about to run; it may not stall that. */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * The model that answers. Configured roles win; otherwise the smallest
 * available model does, so a rule with an `llm:` condition is not silently
 * inert on a session that never assigned a `tiny` or `smol` role.
 */
function selectJudgeModel(roles: readonly string[], deps: TtsrJudgeDeps): Model<Api> | undefined {
	const available = deps.registry.getAvailable();
	if (available.length === 0) return undefined;
	const resolved = resolveRoleSelection(roles, deps.settings, available);
	if (resolved) return resolved.model;
	for (const pattern of MODEL_PRIO.smol) {
		const needle = pattern.toLowerCase();
		const match =
			available.find(model => model.id.toLowerCase() === needle) ??
			available.find(model => model.id.toLowerCase().includes(needle));
		if (match) return match;
	}
	return undefined;
}

export interface TtsrJudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId(): string;
}

/**
 * The last verdict word wins. A model that obeys the prompt answers with the
 * bare word; one that explains itself first still lands on its conclusion last.
 */
export function parseJudgeVerdict(text: string): boolean | undefined {
	const last = text
		.toLowerCase()
		.match(/\b(?:yes|no)\b/g)
		?.at(-1);
	if (last === "yes") return true;
	if (last === "no") return false;
	return undefined;
}

function describeOrigin(request: JudgeRequest): string | undefined {
	if (request.source === "text") return "assistant message";
	if (request.source === "thinking") return "assistant reasoning";
	const parts: string[] = [];
	if (request.toolName) parts.push(`${request.toolName} tool call`);
	const filePath = request.filePaths?.[0];
	if (filePath) parts.push(filePath);
	return parts.length > 0 ? parts.join(" — ") : "tool call";
}

function renderPrompt(request: JudgeRequest): string {
	const content = truncateMiddle(request.text, { maxBytes: MAX_CONTENT_BYTES, maxLines: MAX_CONTENT_LINES }).content;
	return prompt.render(ttsrJudgePrompt, {
		question: request.question,
		origin: describeOrigin(request),
		content,
	});
}

/** Build the judge a `TtsrManager` hands to `llm:` conditions. */
export function createTtsrJudge(deps: TtsrJudgeDeps): JudgeFn {
	const verdicts = new Map<string, boolean>();
	let spent = 0;

	return async (request: JudgeRequest, signal?: AbortSignal): Promise<boolean | undefined> => {
		const key = `${request.roles.join(",")}\u0000${request.question}\u0000${Bun.hash(request.text)}`;
		const cached = verdicts.get(key);
		if (cached !== undefined) return cached;
		if (spent >= MAX_JUDGEMENTS) {
			logger.debug("TTSR judge budget exhausted, skipping condition", { question: request.question, spent });
			return undefined;
		}

		const model = selectJudgeModel(request.roles, deps);
		if (!model) {
			logger.debug("TTSR judge has no model available", { roles: request.roles });
			return undefined;
		}
		const sessionId = deps.sessionId();
		if (!(await deps.registry.getApiKey(model, sessionId))) {
			logger.debug("TTSR judge has no credentials for the resolved model", {
				model: `${model.provider}/${model.id}`,
			});
			return undefined;
		}

		spent++;
		const deadline = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
		const judgeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
		const response = await retryTransientCompletion(
			() =>
				completeSimple(
					model,
					{ messages: [{ role: "user", content: renderPrompt(request), timestamp: Date.now() }] },
					{
						apiKey: deps.registry.resolver(model, sessionId),
						maxTokens: ANSWER_MAX_TOKENS,
						disableReasoning: true,
						signal: judgeSignal,
					},
				),
			{ signal: judgeSignal },
		);
		if (response.stopReason === "error") {
			logger.debug("TTSR judge completion failed", { error: response.errorMessage });
			return undefined;
		}

		const answer = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		const verdict = parseJudgeVerdict(answer);
		if (verdict === undefined) {
			logger.debug("TTSR judge returned no verdict", { answer: answer.slice(0, 120) });
			return undefined;
		}
		verdicts.set(key, verdict);
		logger.debug("TTSR judge verdict", {
			question: request.question,
			model: `${model.provider}/${model.id}`,
			verdict,
		});
		return verdict;
	};
}
