import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";

export function normalizeCodexBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return CODEX_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return CODEX_BASE_URL;
	}
	const host = parsed.host.toLowerCase();
	if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;

	return `${parsed.origin}/backend-api`;
}
