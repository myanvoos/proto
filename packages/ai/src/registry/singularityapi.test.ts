import { describe, expect, it } from "bun:test";
import { getEnvApiKey } from "../stream";
import { getProviderDefinition } from "./registry";

function recordingFetch(status: number): {
	calls: { url: string; authorization: string | null }[];
	fetch: typeof fetch;
} {
	const calls: { url: string; authorization: string | null }[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return status === 200
			? Response.json({ object: "list", data: [] })
			: Response.json({ error: { message: "Invalid API key." } }, { status });
	};
	return { calls, fetch: impl as typeof fetch };
}

describe("SingularityAPI logins", () => {
	for (const [providerId, name, authUrl, modelsUrl, envVar] of [
		[
			"singularityapi-dev",
			"SingularityAPI",
			"https://app.singularityapi.dev",
			"https://api.singularityapi.dev/v1/models",
			"SINGULARITYAPI_DEV_API_KEY",
		],
		[
			"singularityapi-tech",
			"SingularityAPI Reserved Lanes",
			"https://app.singularityapi.tech/compute/billing",
			"https://api.singularityapi.tech/v1/models",
			"SINGULARITYAPI_TECH_API_KEY",
		],
	] as const) {
		it(`${providerId}: strips a pasted Bearer prefix and validates against its own models endpoint`, async () => {
			const definition = getProviderDefinition(providerId);
			expect(definition?.name).toBe(name);
			const { calls, fetch } = recordingFetch(200);
			const authUrls: string[] = [];
			const key = await definition?.login?.({
				onAuth: info => authUrls.push(info.url),
				onPrompt: async () => "  Bearer sk-test  ",
				fetch,
			});
			expect(key).toBe("sk-test");
			expect(authUrls).toEqual([authUrl]);
			expect(calls).toEqual([{ url: modelsUrl, authorization: "Bearer sk-test" }]);
		});

		it(`${providerId}: rejects a key the models endpoint refuses`, async () => {
			const { fetch } = recordingFetch(401);
			await expect(
				getProviderDefinition(providerId)!.login!({ onAuth: () => {}, onPrompt: async () => "sk-bogus", fetch }),
			).rejects.toThrow();
		});

		it(`${providerId}: rejects a bare Bearer prefix`, async () => {
			const { calls, fetch } = recordingFetch(200);
			await expect(
				getProviderDefinition(providerId)!.login!({ onAuth: () => {}, onPrompt: async () => "Bearer ", fetch }),
			).rejects.toThrow("empty after stripping Bearer prefix");
			expect(calls).toEqual([]);
		});

		it(`${providerId}: resolves ${envVar}`, () => {
			const previous = Bun.env[envVar];
			try {
				Bun.env[envVar] = "sk-env";
				expect(getEnvApiKey(providerId)).toBe("sk-env");
			} finally {
				if (previous === undefined) delete Bun.env[envVar];
				else Bun.env[envVar] = previous;
			}
		});
	}
});
