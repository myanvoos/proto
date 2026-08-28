import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

const env = (key: string): string | undefined => {
	const value = process.env[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

const CLIENT_ID = env("ZAI_OAUTH_CLIENT_ID") ?? "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = env("ZAI_OAUTH_AUTHORIZE_URL") ?? "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = env("ZAI_OAUTH_TOKEN_URL") ?? "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = env("ZAI_BIZ_BASE") ?? "https://api.z.ai";

const BUSINESS_LOGIN_URL = env("ZAI_BUSINESS_LOGIN_URL") ?? "https://api.z.ai/api/auth/z/login";

const KEY_NAME = "oh-my-pi";
const CALLBACK_PORT = 54548;
const CALLBACK_PATH = "/callback";

const NEVER_EXPIRES = 8.64e15;

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isSuccessCode(code: unknown): boolean {
	if (code == null) return true;
	if (typeof code === "number") return code === 0 || code === 200;
	if (typeof code === "string") return code === "0" || code === "200";
	return false;
}

function unwrapEnvelope(body: unknown, operation: string): unknown {
	if (body && typeof body === "object" && ("code" in body || "success" in body)) {
		const envelope = body as { code?: unknown; msg?: string; data?: unknown; success?: unknown };
		if (envelope.success === false || !isSuccessCode(envelope.code)) {
			throw new AIError.OAuthError(`Z.ai ${operation} failed: ${envelope.msg ?? `code ${String(envelope.code)}`}`, {
				kind: "token-exchange",
				provider: "zai",
			});
		}
		return "data" in envelope ? envelope.data : envelope;
	}
	return body;
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<unknown> {
	const response = await fetchImpl(url, {
		method: "GET",
		headers,
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	return responseBody.length > 0 ? JSON.parse(responseBody) : undefined;
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	headers: Record<string, string>,
	fetchImpl: FetchImpl,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	return responseBody.length > 0 ? JSON.parse(responseBody) : undefined;
}

function asKeyArray(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const field of ["list", "keys", "apiKeys", "records"]) {
			if (Array.isArray(record[field])) return record[field] as Array<Record<string, unknown>>;
		}
	}
	return [];
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function businessLogin(oauthAccessToken: string, fetchImpl: FetchImpl): Promise<string> {
	const data = unwrapEnvelope(
		await postJson(BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, fetchImpl),
		"business login",
	) as { access_token?: unknown; accessToken?: unknown } | undefined;
	const bizToken = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken);
	if (!bizToken) {
		throw new AIError.OAuthError("Z.ai business login returned no access token", {
			kind: "token-exchange",
			provider: "zai",
		});
	}
	return bizToken;
}

interface ZaiProject {
	projectId?: unknown;
	isDefault?: unknown;
}
interface ZaiOrganization {
	organizationId?: unknown;
	isDefault?: unknown;
	projects?: ZaiProject[];
}

async function mintZaiApiKey(oauthAccessToken: string, fetchImpl: FetchImpl): Promise<string> {
	const bizToken = await businessLogin(oauthAccessToken, fetchImpl);
	const auth = { Authorization: `Bearer ${bizToken}` };

	const customer = unwrapEnvelope(
		await getJson(`${BIZ_BASE}/api/biz/customer/getCustomerInfo`, auth, fetchImpl),
		"customer lookup",
	) as { organizations?: ZaiOrganization[] } | undefined;
	const orgs = Array.isArray(customer?.organizations) ? customer.organizations : [];
	const org = orgs.find(o => o?.isDefault) ?? orgs[0];
	const projects = Array.isArray(org?.projects) ? org.projects : [];
	const project = projects.find(p => p?.isDefault) ?? projects[0];
	const organizationId = trimmedString(org?.organizationId);
	const projectId = trimmedString(project?.projectId);
	if (!organizationId || !projectId) {
		throw new AIError.OAuthError("Z.ai key provisioning failed: no organization/project on account", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const existing = asKeyArray(unwrapEnvelope(await getJson(keysUrl, auth, fetchImpl), "api key list")).find(
		key => key.name === KEY_NAME,
	);
	const keyRecord =
		existing ??
		(unwrapEnvelope(await postJson(keysUrl, { name: KEY_NAME }, auth, fetchImpl), "api key create") as
			| Record<string, unknown>
			| undefined);

	const apiKey = trimmedString(keyRecord?.apiKey);
	if (!apiKey) {
		throw new AIError.OAuthError("Z.ai key provisioning returned no apiKey", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	const copied = unwrapEnvelope(
		await getJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, auth, fetchImpl),
		"api key copy",
	) as { secretKey?: unknown } | undefined;
	const secretKey = trimmedString(copied?.secretKey);
	if (!secretKey) {
		throw new AIError.OAuthError("Z.ai key provisioning returned no secretKey", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	return `${apiKey}.${secretKey}`;
}

export class ZaiOAuthFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			redirect_uri: redirectUri,
			response_type: "code",
			client_id: CLIENT_ID,
			state,
		});
		return {
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete Z.ai login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		if (this.ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal.reason}`);
		}

		let body: unknown;
		try {
			body = await postJson(TOKEN_URL, { provider: "zai", code, redirect_uri: redirectUri, state }, {}, this.#fetch);
		} catch (error) {
			throw new AIError.OAuthError(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; details=${formatErrorDetails(error)}`,
				{ kind: "token-exchange", provider: "zai", cause: error },
			);
		}

		const data = unwrapEnvelope(body, "token exchange") as
			| { zai?: { access_token?: unknown }; user?: { email?: unknown; id?: unknown } }
			| undefined;
		const oauthAccessToken = trimmedString(data?.zai?.access_token);
		if (!oauthAccessToken) {
			throw new AIError.OAuthError("Z.ai token response missing access token", {
				kind: "validation",
				provider: "zai",
			});
		}

		const mintedKey = await mintZaiApiKey(oauthAccessToken, this.#fetch);

		return {
			access: mintedKey,
			refresh: "",
			expires: NEVER_EXPIRES,
			email: typeof data?.user?.email === "string" ? data.user.email : undefined,
			accountId:
				typeof data?.user?.id === "string" || typeof data?.user?.id === "number" ? String(data.user.id) : undefined,
		};
	}
}

export async function loginZaiOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new ZaiOAuthFlow(ctrl);
	return flow.login();
}
