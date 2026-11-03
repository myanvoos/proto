import type { Api, ModelSpec } from "../types";

const BEDROCK_MANTLE_OPENAI_MODEL_IDS: Readonly<Record<string, true>> = {
	"openai.gpt-5.4": true,
	"openai.gpt-5.5": true,
	"openai.gpt-5.6-luna": true,
	"openai.gpt-5.6-sol": true,
	"openai.gpt-5.6-terra": true,
};

/**
 * Remove models.dev rows proto cannot route. Generation and the runtime shared-catalog refresh share
 * this policy so a live catalog cannot reintroduce selectors excluded from the bundled catalog.
 */
export function filterModelsDevCatalogRows<TApi extends Api>(models: readonly ModelSpec<TApi>[]): ModelSpec<TApi>[] {
	return models.filter(model => {
		if (model.provider === "anthropic") {
			const retired = ["claude-3-5-haiku", "claude-3-5-sonnet", "claude-3-7-sonnet", "claude-opus-4-1"];
			return (
				!retired.some(prefix => model.id.startsWith(prefix)) &&
				![
					"claude-3-haiku-20240307",
					"claude-3-opus-20240229",
					"claude-3-sonnet-20240229",
					"claude-opus-4-0",
					"claude-opus-4-20250514",
					"claude-sonnet-4-0",
					"claude-sonnet-4-20250514",
				].includes(model.id)
			);
		}
		if (model.provider === "google-antigravity" && ["gemini-3-flash", "gemini-3.5-flash"].includes(model.id))
			return false;
		if (
			(model.provider === "minimax-code" || model.provider === "minimax-code-cn") &&
			model.id === "MiniMax-M3.1-Flash-Preview"
		)
			return false;
		if (model.provider === "amazon-bedrock") {
			// AWS documents no jp. Opus 5 profile; the openai.gpt-5.x rows are Responses-only Mantle ids.
			return model.id !== "jp.anthropic.claude-opus-5" && !BEDROCK_MANTLE_OPENAI_MODEL_IDS[model.id];
		}
		if (model.provider === "zai") {
			// [1m] is a Claude Code selector convention, not an inference id.
			return !model.id.endsWith("[1m]");
		}
		if (model.provider === "fireworks" || model.provider === "firepass") {
			// Control-plane resource ids are not accepted by the inference API.
			return !model.id.startsWith("accounts/fireworks/");
		}
		if (model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-")) {
			// Text-chat transports cannot serve Xiaomi's audio-only models.
			return !model.id.includes("-tts") && !model.id.includes("-asr");
		}
		return true;
	});
}
