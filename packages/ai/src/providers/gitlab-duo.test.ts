import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Context, FetchImpl, Model } from "../types";
import { clearGitLabDuoDirectAccessCache, getGitLabDuoModels, streamGitLabDuo } from "./gitlab-duo";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function gitLabModel(): Model {
	const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-sonnet-4-6");
	if (!model) throw new Error("GitLab Duo test model is missing");
	return model;
}

describe("GitLab Duo direct access", () => {
	it("passes the caller AbortSignal to the token exchange fetch", async () => {
		clearGitLabDuoDirectAccessCache();
		const caller = new AbortController();
		const { promise: response, reject: rejectResponse } = Promise.withResolvers<Response>();
		const { promise: fetchStarted, resolve: resolveFetchStarted } = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | null | undefined;
		const fetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requestSignal = init?.signal;
				requestSignal?.addEventListener("abort", () => rejectResponse(requestSignal?.reason), { once: true });
				resolveFetchStarted();
				return response;
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;

		const resultPromise = streamGitLabDuo(gitLabModel(), context, {
			apiKey: "gitlab-token",
			fetch: fetchImpl,
			signal: caller.signal,
		}).result();
		await fetchStarted;
		caller.abort();
		if (!requestSignal) rejectResponse(new Error("Token exchange fetch ignored the caller signal"));
		const result = await resultPromise;

		expect(requestSignal).toBe(caller.signal);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/abort/i);
	});
});

describe("GitLab Duo reasoning-off dispatch", () => {
	it("turns reasoning explicitly off on the Responses route instead of dropping to the server default", async () => {
		clearGitLabDuoDirectAccessCache();
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-codex");
		if (!model) throw new Error("GitLab Duo Responses model is missing");
		let payload: { reasoning?: { effort?: string } } | undefined;
		const fetchImpl = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				if (String(input).includes("/direct_access")) return Response.json({ token: "direct-token", headers: {} });
				throw new Error("the payload hook stops the proxy request before fetch");
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;

		await streamGitLabDuo(model, context, {
			apiKey: "gitlab-token",
			reasoning: Effort.Medium,
			forceReasoningOff: true,
			fetch: fetchImpl,
			onPayload: body => {
				payload = body as typeof payload;
				throw new Error("stop after payload capture");
			},
		}).result();

		expect(payload?.reasoning?.effort).toBe("none");
	});
});
