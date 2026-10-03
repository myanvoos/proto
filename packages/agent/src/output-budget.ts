import type { Context, Model, Tool } from "@oh-my-pi/pi-ai";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import { findRequestUsageAnchor } from "./compaction/transcript-tokens";
import type { Tokenizer } from "./tokenizer";

/** Smallest output cap {@link fitOutputTokensToContextWindow} will request. */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Local counts are padded by 1/this: the provider's tokenizer can disagree with ours by a few percent, and
 * undercounting reproduces the overflow this guards against. Provider-reported usage is exact and is not padded.
 */
const PROMPT_ESTIMATE_MARGIN_DIVISOR = 10;

/**
 * Absolute headway subtracted from the remaining room: a host can count a few tokens more than any local estimate
 * sees (chat-template framing, reasoning wrappers). Fitted caps measured +11 to +42 tokens over a 262,144-token host.
 */
export const OUTPUT_FIT_HEADWAY_TOKENS = 64;

/**
 * Output cap for a request, so prompt plus output stays inside the model's context window.
 *
 * Chat Completions-style providers reject a request whose prompt plus `max_tokens` exceeds the window. Every request
 * asks for `model.maxTokens` by default, so a large output cap (DeepSeek V4: ~384k of a ~1M window) fails every
 * request once the prompt passes window minus cap, long before compaction, and side turns have no overflow recovery.
 *
 * The prompt is sized from the provider's newest trustworthy usage report plus a local count of only the messages
 * after it; the whole context is counted locally only when nothing anchors. Returns `maxTokens` unchanged when the
 * cap already fits, the model declares no window, or nothing would be requested (including an OpenRouter-hosted
 * model with no caller cap: the transport omits the catalog default so each upstream self-caps). Otherwise returns
 * the remaining room minus {@link OUTPUT_FIT_HEADWAY_TOKENS}, never below {@link MIN_FITTED_OUTPUT_TOKENS}; a prompt
 * that fills the window still overflows and is left to compaction.
 */
export function fitOutputTokensToContextWindow(
	model: Model,
	context: Context,
	maxTokens: number | undefined,
	tokenizer: Tokenizer,
): number | undefined {
	if (maxTokens === undefined && omitsDefaultOutputCap(model.compat)) return undefined;
	const requested = maxTokens ?? model.maxTokens;
	const contextWindow = model.contextWindow;
	if (!requested || !contextWindow || contextWindow <= 0) return maxTokens;

	const room = contextWindow - countPromptTokens(context, tokenizer) - OUTPUT_FIT_HEADWAY_TOKENS;
	if (room >= requested) return maxTokens;
	return Math.max(MIN_FITTED_OUTPUT_TOKENS, room);
}

function omitsDefaultOutputCap(compat: Model["compat"] | undefined): boolean {
	return (
		compat !== undefined && "isOpenRouterHost" in compat && compat.isOpenRouterHost && !compat.alwaysSendMaxTokens
	);
}

/** System prompt and tool definitions keep their identity for a turn; memoize their counts per array. */
const framingCounts = new WeakMap<readonly unknown[], { tokenizer: Tokenizer; length: number; tokens: number }>();

function countFraming(items: readonly unknown[] | undefined, tokenizer: Tokenizer, fragments: () => string[]): number {
	if (!items || items.length === 0) return 0;
	const cached = framingCounts.get(items);
	if (cached && cached.tokenizer === tokenizer && cached.length === items.length) return cached.tokens;
	const tokens = tokenizer.countTokens(fragments());
	framingCounts.set(items, { tokenizer, length: items.length, tokens });
	return tokens;
}

function toolFragments(tools: readonly Tool[]): string[] {
	const fragments: string[] = [];
	for (const tool of tools) fragments.push(tool.name, tool.description, stringifyJson(tool.parameters) ?? "");
	return fragments;
}

function withMargin(localTokens: number): number {
	return localTokens + Math.ceil(localTokens / PROMPT_ESTIMATE_MARGIN_DIVISOR);
}

function countPromptTokens(context: Context, tokenizer: Tokenizer): number {
	const { messages, systemPrompt, tools } = context;
	const anchor = findRequestUsageAnchor(messages);
	if (!anchor) {
		return withMargin(
			countFraming(systemPrompt, tokenizer, () => [...(systemPrompt ?? [])]) +
				countFraming(tools, tokenizer, () => toolFragments(tools ?? [])) +
				tokenizer.countMessages(messages),
		);
	}
	let tail = 0;
	for (let index = anchor.index + 1; index < messages.length; index++) tail += tokenizer.countMessage(messages[index]);
	return anchor.tokens + withMargin(tail);
}
