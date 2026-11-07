import type { Usage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

const MIN_CACHE_FOOTPRINT = 2048;

export interface CacheInvalidation {
	reprocessedTokens: number;
}

/**
 * A prompt-cache miss is worth a marker only when the cache demonstrably broke.
 *
 * The provider reports a warm prefix as `cacheRead`; a model/thinking/tool/
 * system-prompt change, a history rewrite or an expired entry breaks the
 * prefix, so the next request re-pays for the prompt past the break. We flag
 * only the transition where a demonstrably warm cache goes cold: the previous
 * turn must have actually READ a meaningful prefix back, and this turn read
 * back less than half of it while it still reprocessed a non-trivial prompt.
 *
 * A collapse need not reach zero: the leading system/tool block is shared with
 * every concurrent session on the same prompt, which keeps it warm while this
 * session's history expires, so a cold turn still reads that block (~15k
 * tokens) back while re-writing hundreds of thousands behind it.
 *
 * Requiring a prior warm read is deliberate. A turn that merely WROTE the prefix
 * (`cacheRead` 0) has not proven the cache is live — that is the session's first
 * request, whose follow-up may miss only because the first tool call outlived
 * the TTL. Flagging there would put a "cache miss" right under the opening
 * message. It also collapses a run of consecutive cold turns to the single
 * marker at the moment the cache actually broke, instead of repeating the
 * banner on every turn while it re-warms. Measuring the loss against what the
 * predecessor READ (not what it wrote) keeps both guarantees when only the
 * shared block was warm: nothing proven live was lost.
 *
 * Returns `undefined` (no marker) for the first turn, turns whose predecessor
 * never read a warm prefix, tiny contexts, turns that read back at least half
 * of the predecessor's warm prefix, and — crucially — turns on providers with
 * *implicit* best-effort caching. Only an explicit, prefix-controlled cache
 * (Anthropic / Bedrock `cache_control`) re-creates the prefix on a cold turn
 * (`cacheWrite > 0`); implicit caches (Google / OpenAI / Fireworks) report
 * `cacheWrite: 0` and drop `cacheRead` to zero intermittently without the prefix
 * changing.
 */
export function detectCacheInvalidation(prev: Usage | undefined, current: Usage): CacheInvalidation | undefined {
	if (!prev) return undefined;

	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;

	// The prefix survived when this turn read back at least half of what the
	// previous one did; normal turns read all of it plus the previous write.
	if (current.cacheRead * 2 >= prev.cacheRead) return undefined;

	if (current.cacheWrite <= 0) return undefined;
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}

const CACHE_INVALIDATION_RULE_WIDTH = 10;

export class CacheInvalidationMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: CacheInvalidation) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const icon = theme.icon.cacheMiss;
		const head = icon ? `${icon} cache miss` : "cache miss";
		const tokens = this.info.reprocessedTokens;
		const label = tokens > 0 ? `${head} ${theme.sep.dot.trim()} ${formatNumber(tokens)} tokens` : head;
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(CACHE_INVALIDATION_RULE_WIDTH, width - labelWidth - 1);
		if (ruleWidth < 1) {
			return theme.fg("muted", label);
		}
		return `${theme.fg("dim", theme.tree.horizontal.repeat(ruleWidth))} ${theme.fg("muted", label)}`;
	}
}
