import { isRecord } from "../utils";

export const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>";
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/anthropic`;
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/openai`;
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL = `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/compat`;

export interface CloudflareAiGatewayCredential {
	token: string;
	accountId?: string;
	gatewayId?: string;
}

// Accepts both the structured login payload and legacy plain gateway tokens.
export function parseCloudflareAiGatewayCredential(value: string): CloudflareAiGatewayCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) return null;
		if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
		if (parsed.accountId !== undefined && typeof parsed.accountId !== "string") return null;
		if (parsed.gatewayId !== undefined && typeof parsed.gatewayId !== "string") return null;
		const credential: CloudflareAiGatewayCredential = { token: parsed.token.trim() };
		const accountId = parsed.accountId?.trim();
		const gatewayId = parsed.gatewayId?.trim();
		if (accountId) credential.accountId = accountId;
		if (gatewayId) credential.gatewayId = gatewayId;
		return credential;
	} catch {
		return null;
	}
}

export function serializeCloudflareAiGatewayCredential(token: string, accountId: string, gatewayId: string): string {
	return JSON.stringify({ token: token.trim(), accountId: accountId.trim(), gatewayId: gatewayId.trim() });
}
