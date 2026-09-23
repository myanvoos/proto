import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "../error";
import type { FetchImpl } from "../types";
import { charmHyperUsageProvider } from "./charm-hyper";

function creditsFetch(response: () => Response): {
	urls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const urls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input, init) => {
		urls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return response();
	};
	return { urls, authorizations, fetch };
}

function fetchUsage(fetch: FetchImpl, baseUrl?: string) {
	return charmHyperUsageProvider.fetchUsage(
		{ provider: "charm-hyper", credential: { type: "api_key", apiKey: "sk-hyper-test" }, baseUrl },
		{ fetch },
	);
}

describe("Charm Hyper credit balance", () => {
	it("reports the balance as one remaining-only, account-wide credit pool", async () => {
		const probe = creditsFetch(() => Response.json({ balance: 94.784 }));
		const report = await fetchUsage(probe.fetch);
		expect(probe.urls).toEqual(["https://hyper.charm.land/v1/credits"]);
		expect(probe.authorizations).toEqual(["Bearer sk-hyper-test"]);
		expect(report?.limits).toEqual([
			{
				id: "charm-hyper:credits",
				label: "Credit balance",
				scope: { provider: "charm-hyper", windowId: "balance", shared: true },
				amount: { remaining: 94.784, unit: "credits" },
			},
		]);
	});

	it("probes a configured proxy's /v1 surface instead of sending the key to the canonical host", async () => {
		for (const baseUrl of ["https://proxy.example/v1", "https://proxy.example", "https://proxy.example/v1/"]) {
			const probe = creditsFetch(() => Response.json({ balance: 1 }));
			await fetchUsage(probe.fetch, baseUrl);
			expect(probe.urls).toEqual(["https://proxy.example/v1/credits"]);
		}
		const blank = creditsFetch(() => Response.json({ balance: 1 }));
		await fetchUsage(blank.fetch, "  ");
		expect(blank.urls).toEqual(["https://hyper.charm.land/v1/credits"]);
	});

	it("throws on a rejected key so the cached balance is purged, and treats other failures as transient", async () => {
		const rejected = creditsFetch(() => Response.json({ error: "authentication failed" }, { status: 401 }));
		await expect(fetchUsage(rejected.fetch)).rejects.toBeInstanceOf(ProviderHttpError);

		expect(await fetchUsage(creditsFetch(() => new Response("busy", { status: 503 })).fetch)).toBeNull();
		expect(await fetchUsage(creditsFetch(() => Response.json({ balance: "lots" })).fetch)).toBeNull();
	});
});
