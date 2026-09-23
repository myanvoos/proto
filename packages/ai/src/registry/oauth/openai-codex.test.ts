import { afterEach, expect, test, vi } from "bun:test";
import { loginOpenAICodexDevice } from "./openai-codex";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithPayload(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

function mockDeviceLogin(access: string): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
				if (url.endsWith("/api/accounts/deviceauth/usercode")) {
					return Response.json({ device_auth_id: "device-auth", user_code: "USER-CODE", interval: -3 });
				}
				if (url.endsWith("/api/accounts/deviceauth/token")) {
					return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" });
				}
				if (url.endsWith("/oauth/token")) {
					return Response.json({ access_token: access, refresh_token: "refresh-token", expires_in: 3600 });
				}
				throw new Error(`Unexpected request: ${url}`);
			},
			{ preconnect: fetch.preconnect },
		),
	);
}

test("completes Codex device login when the token has an email but no workspace claim", async () => {
	mockDeviceLogin(
		jwtWithPayload({
			sub: "user-fixture",
			"https://api.openai.com/auth": { user_id: "user-fixture", poid: "org-fixture" },
			"https://api.openai.com/profile": { email: "Fixture@Example.com" },
		}),
	);

	const credentials = await loginOpenAICodexDevice({});

	expect(credentials.email).toBe("fixture@example.com");
	expect(credentials.accountId).toBeUndefined();
	expect(credentials.orgId).toBeUndefined();
});

test("rejects Codex device login tokens without a workspace or email identity", async () => {
	mockDeviceLogin(jwtWithPayload({ sub: "user-fixture" }));

	await expect(loginOpenAICodexDevice({})).rejects.toMatchObject({ kind: "validation" });
});
