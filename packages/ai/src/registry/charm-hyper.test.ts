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
			? Response.json({ balance: 100 })
			: Response.json({ error: "authentication failed" }, { status });
	};
	return { calls, fetch: impl as typeof fetch };
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
	const previous = Object.fromEntries(Object.keys(values).map(name => [name, Bun.env[name]]));
	try {
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
		run();
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	}
}

describe("Charm Hyper login", () => {
	// `/v1/models` is public and answers 200 for any key, so only `/v1/credits` can reject a bad one.
	it("strips a pasted Bearer prefix and validates against the authenticated credits endpoint", async () => {
		const definition = getProviderDefinition("charm-hyper");
		expect(definition?.name).toBe("Charm Hyper");
		const { calls, fetch } = recordingFetch(200);
		const key = await definition?.login?.({
			onAuth: () => {},
			onPrompt: async () => "  Bearer sk-hyper-test  ",
			fetch,
		});
		expect(key).toBe("sk-hyper-test");
		expect(calls).toEqual([{ url: "https://hyper.charm.land/v1/credits", authorization: "Bearer sk-hyper-test" }]);
	});

	it("rejects a key the credits endpoint refuses", async () => {
		const { fetch } = recordingFetch(401);
		await expect(
			getProviderDefinition("charm-hyper")!.login!({ onAuth: () => {}, onPrompt: async () => "sk-bogus", fetch }),
		).rejects.toThrow();
	});

	it("prefers CHARM_HYPER_API_KEY and falls back to HYPER_API_KEY", () => {
		withEnv({ CHARM_HYPER_API_KEY: "sk-primary", HYPER_API_KEY: "sk-fallback" }, () => {
			expect(getEnvApiKey("charm-hyper")).toBe("sk-primary");
		});
		withEnv({ CHARM_HYPER_API_KEY: undefined, HYPER_API_KEY: "sk-fallback" }, () => {
			expect(getEnvApiKey("charm-hyper")).toBe("sk-fallback");
		});
	});
});
