import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "../../types";
import { loginZaiOAuth } from "./zai";

const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Z.ai sign-in", () => {
	it("advertises the ZCode desktop-scheme redirect, binds no callback server, and accepts the pasted zcode:// URL", async () => {
		const serveSpy = vi.spyOn(Bun, "serve");
		let authUrl = "";
		const tokenBodies: unknown[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === TOKEN_URL) {
				tokenBodies.push(JSON.parse(String(init?.body)));
				// Stop after the exchange: key provisioning is outside this contract.
				return Response.json({ code: 1, msg: "stop" });
			}
			throw new Error(`unexpected request ${url}`);
		};

		const error = await loginZaiOAuth({
			fetch: fetchImpl,
			onAuth: info => {
				authUrl = info.url;
			},
			onManualCodeInput: async () =>
				`zcode://zai-auth/callback?code=pasted-code&state=${new URL(authUrl).searchParams.get("state")}`,
		}).catch((caught: unknown) => caught);

		expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe("zcode://zai-auth/callback");
		expect(serveSpy).not.toHaveBeenCalled();
		expect(tokenBodies).toEqual([
			expect.objectContaining({ code: "pasted-code", redirect_uri: "zcode://zai-auth/callback" }),
		]);
		expect(String(error)).toContain("stop");
	});
});
