import { hostMatchesUrl } from "../hosts";
import type { Model } from "../types";

/**
 * Rule-owned capability, independent of the per-model compat snapshot: the
 * standard Responses WebSocket endpoint is only the official OpenAI one (or a
 * custom model pointed at it). Codex keeps its independent transport policy.
 */
function catalogSupportsResponsesWebSockets(model: Model): boolean {
	if (model.api !== "openai-responses") return false;
	if (model.provider === "openai") return true;
	return hostMatchesUrl(model.baseUrl, "openai");
}

/**
 * Capability is catalog-owned; callers must opt in. Either explicit false vetoes
 * the other preference, including a per-request true for a disabled model.
 */
export function resolveResponsesWebSocketPreference(model: Model, requestPreference?: boolean): boolean {
	if (!catalogSupportsResponsesWebSockets(model)) return false;
	if (requestPreference === false || model.preferWebsockets === false) return false;
	return requestPreference === true || model.preferWebsockets === true;
}
