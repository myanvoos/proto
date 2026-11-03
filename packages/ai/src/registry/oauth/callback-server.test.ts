import { expect, test } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "./types";

class CallbackProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL("https://provider.example/authorize");
		url.searchParams.set("state", state);
		url.searchParams.set("redirect_uri", redirectUri);
		return { url: url.href };
	}
	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

test("callback result page keeps provider markup inert and preserves replacement metacharacters", async () => {
	const auth = Promise.withResolvers<OAuthAuthInfo>();
	const abort = new AbortController();
	const flow = new CallbackProbeFlow({ onAuth: auth.resolve, signal: abort.signal }, { preferredPort: 0 });
	const login = flow.login();
	void login.catch(() => undefined);
	try {
		const info = await auth.promise;
		const authUrl = new URL(info.url);
		const redirect = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirect || !state) throw new Error("Missing callback parameters");
		const malicious = "</ScRiPt><script id=injected>globalThis.callbackInjected=1</script> $& $' $$";
		const denied = new URL(redirect);
		denied.searchParams.set("error", "access_denied");
		denied.searchParams.set("error_description", malicious);
		const response = await fetch(denied);
		expect(response.status).toBe(500);
		const page = parseHTML(await response.text()).document;
		expect(page.getElementById("injected")).toBeNull();
		expect(JSON.parse(page.getElementById("server-state")?.textContent ?? "null")).toEqual({
			ok: false,
			error: `Authorization failed: ${malicious}`,
		});
		const success = new URL(redirect);
		success.searchParams.set("code", malicious);
		success.searchParams.set("state", state);
		const result = await fetch(success);
		expect((await login).access).toBe(malicious);
		const resultPage = parseHTML(await result.text()).document;
		expect(resultPage.getElementById("injected")).toBeNull();
		expect(JSON.parse(resultPage.getElementById("server-state")?.textContent ?? "null")).toEqual({
			ok: true,
			code: malicious,
			state,
		});
	} finally {
		abort.abort();
		await login.catch(() => undefined);
	}
});
