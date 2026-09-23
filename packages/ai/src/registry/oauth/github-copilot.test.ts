import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../../types";
import { loginGitHubCopilot } from "./github-copilot";

const OPENCODE_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const COPILOT_CLI_CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;

interface OAuthCall {
	url: string;
	body: Record<string, string>;
	contentType: string | null;
}

function githubFetch(domain: string, policy: Handler = () => Response.json({})) {
	const oauthCalls: OAuthCall[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url === `https://${domain}/login/device/code` || url === `https://${domain}/login/oauth/access_token`) {
			if (!(init?.body instanceof URLSearchParams)) throw new Error(`expected a form body for ${url}`);
			oauthCalls.push({
				url,
				body: Object.fromEntries(init.body),
				contentType: new Headers(init.headers).get("Content-Type"),
			});
			return url.endsWith("/device/code")
				? Response.json({
						device_code: "dc_test",
						user_code: "ABCD-1234",
						verification_uri: `https://${domain}/login/device`,
						interval: 0,
						expires_in: 300,
					})
				: Response.json({ access_token: "ghu_test", token_type: "bearer", scope: "read:user" });
		}
		if (url === "https://api.github.com/copilot_internal/user") return new Response("{}", { status: 404 });
		const response = url.endsWith("/policy") ? policy(url, init) : undefined;
		if (response) return response;
		throw new Error(`Unexpected URL: ${url}`);
	};
	const fetchImpl: FetchImpl = Object.assign(impl, { preconnect: fetch.preconnect });
	return { fetchImpl, oauthCalls };
}

function login(domainInput: string, fetchImpl: FetchImpl) {
	return loginGitHubCopilot({
		onAuth: () => {},
		onPrompt: async () => domainInput,
		fetch: fetchImpl,
		pollIntervalFloorMs: 0,
		pollIntervalScaleMs: 1,
	});
}

describe("GitHub Copilot device login", () => {
	it("signs in on github.com with the minimal-grant OpenCode app and read:user only", async () => {
		const { fetchImpl, oauthCalls } = githubFetch("github.com");
		const credentials = await login("", fetchImpl);

		expect(credentials.access).toBe("ghu_test");
		expect(oauthCalls).toEqual([
			{
				url: "https://github.com/login/device/code",
				body: { client_id: OPENCODE_CLIENT_ID, scope: "read:user" },
				contentType: "application/x-www-form-urlencoded",
			},
			{
				url: "https://github.com/login/oauth/access_token",
				body: {
					client_id: OPENCODE_CLIENT_ID,
					device_code: "dc_test",
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				},
				contentType: "application/x-www-form-urlencoded",
			},
		]);
	});

	it("keeps the GitHub-owned Copilot CLI app on Enterprise domains", async () => {
		const { fetchImpl, oauthCalls } = githubFetch("company.ghe.com");
		const credentials = await login("https://company.ghe.com", fetchImpl);

		expect(credentials.enterpriseUrl).toBe("company.ghe.com");
		expect(oauthCalls.map(call => call.body.client_id)).toEqual([COPILOT_CLI_CLIENT_ID, COPILOT_CLI_CLIENT_ID]);
	});

	it("enables models as copilot-chat and retries a denied policy post once as the Copilot CLI", async () => {
		const identitiesByUrl = new Map<string, (string | null)[]>();
		const { fetchImpl } = githubFetch("github.com", (url, init) => {
			const identity = new Headers(init?.headers).get("Copilot-Integration-Id");
			identitiesByUrl.set(url, [...(identitiesByUrl.get(url) ?? []), identity]);
			return identity === "copilot-developer-cli" ? Response.json({}) : new Response("forbidden", { status: 403 });
		});
		await login("", fetchImpl);

		expect(identitiesByUrl.size).toBeGreaterThan(0);
		for (const identities of identitiesByUrl.values()) {
			expect(identities).toEqual(["copilot-chat", "copilot-developer-cli"]);
		}
	});
});
