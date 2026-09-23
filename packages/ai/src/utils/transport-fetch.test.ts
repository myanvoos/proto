import { expect, it } from "bun:test";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type { Api, FetchImpl, Model } from "../types";
import { transportFetch } from "./transport-fetch";

const model = { provider: "test-provider", api: "openai-completions" } as Model<Api>;

function recordingFetch(): { fetch: FetchImpl; inits: (RequestInit | undefined)[] } {
	const inits: (RequestInit | undefined)[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		inits.push(init);
		return new Response("ok");
	};
	return { fetch, inits };
}

it("re-entering the transport reuses the built fetch instead of layering another wrapper", () => {
	const { fetch } = recordingFetch();
	const built = transportFetch(model, fetch);
	expect(transportFetch(model, built)).toBe(built);
});

it("defaults the User-Agent on plain-object headers without replacing an explicit one", async () => {
	const { fetch, inits } = recordingFetch();
	const built = transportFetch(model, fetch);

	await built("https://api.example/v1", { headers: { authorization: "Bearer x" } });
	await built("https://api.example/v1", { headers: { "user-agent": "client-fingerprint/1" } });

	expect(inits[0]?.headers).toEqual({ authorization: "Bearer x", "User-Agent": USER_AGENT });
	expect(inits[1]?.headers).toEqual({ "user-agent": "client-fingerprint/1" });
});
