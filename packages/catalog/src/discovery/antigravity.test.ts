import { describe, expect, it } from "bun:test";
import { getAntigravityModelWireProfile } from "../wire/gemini-headers";
import { fetchAntigravityDiscoveryModels } from "./antigravity";

describe("Antigravity account roster", () => {
	it("drops disabled and retired routes and retains live SKU wire constants", async () => {
		let headers = new Headers();
		let body: unknown;
		const models = await fetchAntigravityDiscoveryModels({
			token: "fixture",
			projectId: "project-fixture",
			userAgent: "fixture-client",
			endpoint: "https://fixture.test",
			fetcher: async (_input, init) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body));
				return Response.json({
					models: {
						"gemini-4-argon-disabled": { disabled: true },
						"gemini-3-flash-agent": { supportsThinking: true },
						"live-fixture": {
							model: "MODEL_FIXTURE",
							maxOutputTokens: 16384,
							thinkingLevel: 2,
							thinkingBudget: 8192,
						},
					},
				});
			},
		});
		expect(models?.map(model => model.id)).toEqual(["live-fixture"]);
		expect(getAntigravityModelWireProfile("live-fixture", models?.[0]?.antigravityWireProfiles)).toEqual({
			modelEnum: "MODEL_FIXTURE",
			maxOutputTokens: 16384,
			thinkingLevel: "MEDIUM",
			thinkingBudget: 8192,
		});
		expect(body).toEqual({ project: "project-fixture" });
		expect(headers.get("accept-encoding")).toBe("gzip");
	});
});
