import { afterEach, describe, expect, test, vi } from "bun:test";
import type { FetchImpl } from "../../types";
import { getProviderDefinition } from "../registry";
import { attachMuseCodeApiKey, parseMuseCodeCredential } from "./muse-code";

const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const KEY_URL = "https://api.meta.ai/muse-code/key";

const DEVICE_AUTHORIZATION = {
	device_code: "device-code",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.meta.com/device",
	verification_uri_complete: "https://auth.meta.com/device?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 0.001,
};
const ACCOUNT_TOKEN = { access_token: "meta-account-access", refresh_token: "meta-refresh" };
const SUBSCRIPTION_KEY = {
	api_key: "LLM|subscription-key",
	user_email: "Muse@Example.com",
	user_id: "meta-account-1",
	is_subs_active: true,
	action_url: null,
};

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

interface JsonResponse {
	body: unknown;
	status?: number;
}

function jsonFetch(respond: (url: string) => Response): { fetch: FetchImpl; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			requests.push({ url, init });
			return respond(url);
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl, requests };
}

function museLoginFetch(options: { device?: JsonResponse; tokens?: readonly JsonResponse[]; key?: JsonResponse } = {}) {
	let tokenIndex = 0;
	return jsonFetch(url => {
		const response =
			url === DEVICE_URL
				? (options.device ?? { body: DEVICE_AUTHORIZATION })
				: url === TOKEN_URL
					? (options.tokens?.[tokenIndex++] ?? { body: ACCOUNT_TOKEN })
					: url === KEY_URL
						? (options.key ?? { body: SUBSCRIPTION_KEY })
						: undefined;
		if (!response) throw new Error(`unexpected URL: ${url}`);
		return Response.json(response.body, { status: response.status ?? 200 });
	});
}

function keyExchange(response: Response): FetchImpl {
	return jsonFetch(() => response).fetch;
}

async function loginMuse(fetchImpl: FetchImpl, onAuth: (url: string, instructions: string) => void = () => {}) {
	const provider = getProviderDefinition("muse-code");
	if (!provider?.login) throw new Error("Muse Code login is not registered");
	const credentials = await provider.login({
		fetch: fetchImpl,
		onAuth: info => onAuth(info.url, info.instructions ?? ""),
		onPrompt: async () => "",
	});
	if (typeof credentials === "string") throw new Error("expected OAuth credentials");
	return credentials;
}

const ACCOUNT_CREDENTIALS = { access: "meta-account-access", refresh: "meta-refresh", expires: Date.now() + 3_600_000 };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Muse Code device login", () => {
	test("stores the minted subscription key as a durable credential", async () => {
		const { fetch: fetchImpl, requests } = museLoginFetch();
		const authEvents: Array<{ url: string; instructions: string }> = [];
		const credentials = await loginMuse(fetchImpl, (url, instructions) => authEvents.push({ url, instructions }));

		expect(authEvents).toEqual([
			{ url: "https://auth.meta.com/device?user_code=ABCD-EFGH", instructions: "Enter code: ABCD-EFGH" },
		]);
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL, KEY_URL]);
		const [device, poll, mint] = requests as [RecordedRequest, RecordedRequest, RecordedRequest];
		for (const request of [device, poll]) {
			expect(new Headers(request.init?.headers).get("x-api-version")).toBe("1.0.0");
		}
		expect(new URLSearchParams(String(device.init?.body)).get("client_id")).toBe("1031625952748946");
		const pollBody = new URLSearchParams(String(poll.init?.body));
		expect(pollBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(pollBody.get("device_code")).toBe("device-code");
		expect(new Headers(mint.init?.headers).get("Authorization")).toBe("Bearer meta-account-access");
		expect(JSON.parse(String(mint.init?.body))).toEqual({ onboard: true });

		expect(credentials).toMatchObject({
			refresh: "meta-refresh",
			accountId: "meta-account-1",
			email: "muse@example.com",
		});
		expect(credentials.expires).toBe(8.64e15);
		expect(parseMuseCodeCredential(credentials.access)).toEqual({
			oauthAccessToken: "meta-account-access",
			apiKey: "LLM|subscription-key",
		});
	});

	test("keeps polling through pending and slow-down responses", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const { fetch: fetchImpl, requests } = museLoginFetch({
			tokens: [
				{ body: { error: "authorization_pending" }, status: 400 },
				{ body: { error: "slow_down" }, status: 400 },
				{ body: ACCOUNT_TOKEN },
			],
		});
		const credentials = await loginMuse(fetchImpl);
		expect(requests.filter(request => request.url === TOKEN_URL)).toHaveLength(3);
		expect(parseMuseCodeCredential(credentials.access).apiKey).toBe("LLM|subscription-key");
	});

	test.each([
		["denied", "access_denied", "muse-code device authorization was denied"],
		["expired", "expired_token", "muse-code device code expired; restart the login"],
	])("stops on a terminal %s device response", async (_case, error, message) => {
		const { fetch: fetchImpl, requests } = museLoginFetch({ tokens: [{ body: { error }, status: 400 }] });
		await expect(loginMuse(fetchImpl)).rejects.toThrow(message);
		expect(requests.map(request => request.url)).toEqual([DEVICE_URL, TOKEN_URL]);
	});
});

describe("Muse Code key exchange", () => {
	test("classifies a subscription payment action as an entitlement failure", async () => {
		const fetchImpl = keyExchange(
			Response.json({ require_payment: true, require_payment_action_url: "https://www.meta.ai/subscribe" }),
		);
		await expect(attachMuseCodeApiKey(ACCOUNT_CREDENTIALS, { fetch: fetchImpl })).rejects.toMatchObject({
			kind: "entitlement",
			provider: "muse-code",
			message: expect.stringContaining("https://www.meta.ai/subscribe"),
		});
	});

	test("accepts null subscription tier fields for accounts without an assigned tier", async () => {
		const fetchImpl = keyExchange(Response.json({ ...SUBSCRIPTION_KEY, subs_tier_id: null, subs_tier_name: null }));
		const result = await attachMuseCodeApiKey(ACCOUNT_CREDENTIALS, { fetch: fetchImpl });
		expect(result).toMatchObject({ accountId: "meta-account-1", email: "muse@example.com" });
	});

	test("rejects an inactive subscription instead of exposing a Model API credential", async () => {
		const fetchImpl = keyExchange(Response.json({ is_subs_active: false }));
		await expect(attachMuseCodeApiKey(ACCOUNT_CREDENTIALS, { fetch: fetchImpl })).rejects.toMatchObject({
			provider: "muse-code",
			status: 403,
		});
	});

	test("surfaces the status and body excerpt of a non-JSON upstream failure", async () => {
		const fetchImpl = keyExchange(
			new Response("<html><title>502 Bad Gateway</title></html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			}),
		);
		await expect(attachMuseCodeApiKey(ACCOUNT_CREDENTIALS, { fetch: fetchImpl })).rejects.toMatchObject({
			kind: "token-exchange",
			status: 502,
			message: expect.stringContaining("502 <html><title>502 Bad Gateway</title>"),
		});
	});
});
