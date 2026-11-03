import { describe, expect, it } from "bun:test";
import type { OAuthLoginCallbacks } from "./oauth/types";
import { getProviderDefinition } from "./registry";

describe("new provider key validation", () => {
	it("loads the new login providers and rejects keys denied by their authenticated model endpoint", async () => {
		for (const [id, endpoint] of [
			["coralbricks", "https://inference.coralbricks.ai/v1/models"],
			["sambanova", "https://api.sambanova.ai/v1/models"],
			["modular", "https://api.modular.com/v1/models"],
		] as const) {
			let requested = "";
			const callbacks: OAuthLoginCallbacks = {
				onAuth: () => {},
				onPrompt: async () => "invalid-key",
				fetch: async (input, init) => {
					requested = String(input);
					expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer invalid-key");
					return Response.json({ error: "invalid key" }, { status: 401 });
				},
			};
			const provider = getProviderDefinition(id);
			if (!provider?.login) throw Error(`Provider ${id} cannot log in`);
			await expect(provider.login(callbacks)).rejects.toThrow("401");
			expect(requested).toBe(endpoint);
		}
	});

	it("validates Inception through inference because its public model list accepts invalid keys", async () => {
		let requested = "";
		let body: Record<string, unknown> = {};
		const provider = getProviderDefinition("inception");
		if (!provider?.login) throw Error("Inception cannot log in");
		await expect(
			provider.login({
				onAuth: () => {},
				onPrompt: async () => "inception-key",
				fetch: async (input, init) => {
					requested = String(input);
					body = JSON.parse(String(init?.body));
					return Response.json({ error: "invalid key" }, { status: 401 });
				},
			}),
		).rejects.toThrow("401");
		expect(requested).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
		expect(body).toMatchObject({ model: "mercury-3", max_completion_tokens: 1 });
		expect(body.max_tokens).toBeUndefined();
	});

	it("strips a pasted Bearer prefix before validating and storing a Scaleway secret key", async () => {
		const provider = getProviderDefinition("scaleway");
		if (!provider?.login) throw Error("Scaleway cannot log in");
		const result = await provider.login({
			onAuth: () => {},
			onPrompt: async () => "Bearer fixture-secret",
			fetch: async (input, init) => {
				expect(String(input)).toBe("https://api.scaleway.ai/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-secret");
				return Response.json({ data: [] });
			},
		});
		expect(result).toBe("fixture-secret");
	});
});
