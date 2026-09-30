import { describe, expect, it } from "bun:test";
import type { Api } from "./types";
import { getPriorityPremiumRequests, realizesPriorityServiceTier, shouldSendServiceTier } from "./types";

const openai = { provider: "openai", api: "openai-responses" as Api, id: "gpt-5" };
const codex = { provider: "openai-codex", api: "openai-codex-responses" as Api, id: "gpt-5.5" };
const gemini = { provider: "google", api: "google-generative-ai" as Api, id: "gemini-3-flash" };
const customOpenAI = { provider: "custom-relay", api: "openai-completions" as Api, id: "gpt-5.5" };
const customCodex = { provider: "custom-relay", api: "openai-codex-responses" as Api, id: "gpt-5.5" };
const orOpenAI = { provider: "openrouter", api: "openai-responses" as Api, id: "openai/gpt-5.5" };

describe("shouldSendServiceTier", () => {
	it("sends ultrafast to OpenAI, and to Codex only when discovery advertises it", () => {
		expect(shouldSendServiceTier("ultrafast", openai)).toBe(true);
		expect(shouldSendServiceTier("ultrafast", codex)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", { ...codex, serviceTiers: ["priority"] })).toBe(false);
		expect(shouldSendServiceTier("ultrafast", { ...codex, serviceTiers: ["priority", "ultrafast"] })).toBe(true);
		// The advertised list, not the provider id, gates Codex-backend models; without it no relay gets ultrafast.
		expect(shouldSendServiceTier("ultrafast", { ...customCodex, serviceTiers: ["ultrafast"] })).toBe(true);
		expect(shouldSendServiceTier("ultrafast", customCodex)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", customOpenAI)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", orOpenAI)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", gemini)).toBe(false);
		expect(realizesPriorityServiceTier("ultrafast", openai)).toBe(false);
	});

	it("gates Codex priority/scale only on a non-empty discovered tier list", () => {
		const unlisted = { ...codex, serviceTiers: ["ultrafast"] };
		expect(shouldSendServiceTier("priority", unlisted)).toBe(false);
		expect(realizesPriorityServiceTier("priority", unlisted)).toBe(false);
		expect(getPriorityPremiumRequests("priority", unlisted)).toBe(0);
		expect(shouldSendServiceTier("scale", unlisted)).toBe(false);
		expect(shouldSendServiceTier("priority", { ...codex, serviceTiers: ["priority"] })).toBe(true);
		// An empty list means "not reported" (free-plan accounts list [] for every model): Fast stays available.
		const unreported = { ...codex, serviceTiers: [] };
		expect(shouldSendServiceTier("priority", unreported)).toBe(true);
		expect(realizesPriorityServiceTier("priority", unreported)).toBe(true);
		expect(shouldSendServiceTier("ultrafast", unreported)).toBe(false);
		// Flex is always an accepted request option; `default` is out of this gate's scope.
		expect(shouldSendServiceTier("flex", unlisted)).toBe(true);
		expect(shouldSendServiceTier("default", unlisted)).toBe(true);
		// No discovered list (bundled/custom rows): the provider-level answer stands.
		expect(shouldSendServiceTier("priority", codex)).toBe(true);
		expect(shouldSendServiceTier("priority", customCodex)).toBe(true);
	});
});
