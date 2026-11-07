import { expect, test } from "bun:test";
import type { PromptCacheStatus } from "../../../session/prompt-cache-status";
import { initThemeSync } from "../../theme/theme";
import { SEGMENTS } from "./segments";

initThemeSync();

function renderCache(status: PromptCacheStatus | undefined): { content: string; visible: boolean } {
	const rendered = SEGMENTS.cache.render({
		session: { state: {}, modelRegistry: { isUsingOAuth: () => false } },
		width: 120,
		options: {},
		compactThinkingLevel: false,
		prewalk: null,
		activeRepo: null,
		promptCache: status,
	} as never);
	return { content: Bun.stripANSI(rendered.content), visible: rendered.visible };
}

function status(overrides: Partial<PromptCacheStatus>): PromptCacheStatus {
	return {
		state: "warm",
		inferred: false,
		tier: "short",
		touchedAt: 0,
		ttlMs: 300_000,
		cachedTokens: 50_000,
		nextTokens: 60_000,
		...overrides,
	};
}

test("the cache chip reads cached while the next message reads the prompt cache", () => {
	expect(renderCache(status({}))).toEqual({ content: "cached", visible: true });
});

test("the cache chip turns into a warning when the next message re-sends the prefix", () => {
	expect(renderCache(status({ state: "cold", reason: { kind: "expired", at: 0 } }))).toEqual({
		content: "⊘ not cached",
		visible: true,
	});
});

test("the cache chip hides when the session reports no cache status", () => {
	expect(renderCache(undefined)).toEqual({ content: "", visible: false });
});
