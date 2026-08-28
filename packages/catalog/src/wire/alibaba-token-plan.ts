export const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export const ALIBABA_TOKEN_PLAN_CN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

export interface AlibabaTokenPlanCredential {
	token: string;
	cookie?: string;

	baseUrl?: string;
}

const TOKEN_PATTERN = /^sk-[A-Za-z0-9._~+/-]+={0,2}$/;

export function parseAlibabaTokenPlanCredential(value: string): AlibabaTokenPlanCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return TOKEN_PATTERN.test(trimmed) ? { token: trimmed } : null;
	try {
		const parsed = JSON.parse(trimmed) as { token?: unknown; cookie?: unknown; baseUrl?: unknown };
		if (typeof parsed.token !== "string" || !TOKEN_PATTERN.test(parsed.token.trim())) return null;
		if (parsed.cookie !== undefined && typeof parsed.cookie !== "string") return null;
		if (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string") return null;
		const token = parsed.token.trim();
		const cookie = parsed.cookie?.trim();
		const baseUrl = parsed.baseUrl?.trim();
		const credential: AlibabaTokenPlanCredential = { token };
		if (cookie) credential.cookie = cookie;
		if (baseUrl) credential.baseUrl = baseUrl;
		return credential;
	} catch {
		return null;
	}
}

export function serializeAlibabaTokenPlanCredential(token: string, cookie: string, baseUrl?: string): string {
	const trimmedCookie = cookie.trim();
	const trimmedBaseUrl = baseUrl?.trim();
	if (!trimmedCookie && !trimmedBaseUrl) return token;
	const payload: { token: string; cookie?: string; baseUrl?: string } = { token };
	if (trimmedCookie) payload.cookie = trimmedCookie;
	if (trimmedBaseUrl) payload.baseUrl = trimmedBaseUrl;
	return JSON.stringify(payload);
}
