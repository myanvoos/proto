import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";
import { opencodeGoUsageProvider } from "./opencode-go";

afterEach(() => vi.restoreAllMocks());

describe("OpenCode Go usage polling", () => {
	it("maps first-party inference URLs to Zen account usage without rewriting custom gateways", async () => {
		for (const [baseUrl, expected] of [
			["https://opencode.ai/inference/go/v1/", "https://opencode.ai/zen/go/v1/usage"],
			["https://gateway.example/prefix/inference/go/v1", "https://gateway.example/prefix/inference/go/v1/usage"],
		]) {
			let requested = "";
			await opencodeGoUsageProvider.fetchUsage(
				{ provider: "opencode-go", baseUrl, credential: { type: "api_key", apiKey: "key" } },
				{
					fetch: async input => {
						requested = String(input);
						return Response.json({ usage: {} });
					},
				},
			);
			expect(requested).toBe(expected);
		}
	});

	it("attributes background usage requests with the client and install session", async () => {
		spyOn(utils, "getInstallId").mockReturnValue("test-install-id");
		let requestHeaders = new Headers();
		const fetchUsage: FetchImpl = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return Response.json({
				usage: {
					rolling: { status: "ok", percent: 1, resetsAt: "2026-09-09T05:00:00.000Z" },
					weekly: { status: "ok", percent: 2, resetsAt: "2026-09-14T00:00:00.000Z" },
					monthly: { status: "ok", percent: 3, resetsAt: "2026-10-01T00:00:00.000Z" },
				},
			});
		};

		await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fetchUsage },
		);

		expect(requestHeaders.get("User-Agent")).toBe(utils.USER_AGENT);
		expect(requestHeaders.get("x-opencode-session")).toBe("test-install-id");
	});
});
