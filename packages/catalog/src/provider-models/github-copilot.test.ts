import { describe, expect, it } from "bun:test";
import { resolveProviderModels } from "../model-manager";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, FetchImpl, Model, ModelSpec } from "../types";
import { githubCopilotModelManagerOptions, routeGitHubCopilotModelSpec } from "./openai-compat";

function copilotModelsFetch(ids: readonly string[]): FetchImpl {
	const impl = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url === "https://api.github.com/copilot_internal/user") return new Response("{}", { status: 404 });
		if (url === "https://api.githubcopilot.com/models") {
			return Response.json({
				data: ids.map(id => ({
					id,
					name: id,
					capabilities: {
						type: "chat",
						limits: { max_context_window_tokens: 400_000, max_output_tokens: 128_000 },
					},
				})),
			});
		}
		throw new Error(`Unexpected URL: ${url}`);
	};
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

async function discover(ids: readonly string[], staticModels: readonly ModelSpec<Api>[] = []): Promise<Model<Api>[]> {
	const options = githubCopilotModelManagerOptions({ apiKey: "gho_test", fetch: copilotModelsFetch(ids) });
	const result = await resolveProviderModels({ ...options, staticModels, cacheDbPath: ":memory:" }, "online");
	return result.models;
}

const COMPLETIONS_ROW: ModelSpec<Api> = {
	id: "grok-4.7",
	name: "Grok 4.7",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 64_000,
	compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
};

describe("GitHub Copilot discovery routing", () => {
	it("routes GPT-6 and every Grok 4.x id through Responses while grok-code-fast stays on completions", async () => {
		const models = await discover(["gpt-6-astra", "grok-4.7", "grok-4.9", "grok-code-fast-1"]);
		const apiById = Object.fromEntries(models.map(model => [model.id, model.api]));

		expect(apiById).toMatchObject({
			"gpt-6-astra": "openai-responses",
			"grok-4.7": "openai-responses",
			"grok-4.9": "openai-responses",
			"grok-code-fast-1": "openai-completions",
		});
	});

	it("does not let a static chat-completions row strip the effort dial from a re-routed id", async () => {
		const models = await discover(["grok-4.7"], [COMPLETIONS_ROW]);
		const grok = models.find(model => model.id === "grok-4.7");

		expect(grok?.api).toBe("openai-responses");
		expect(grok?.compat).toMatchObject({ supportsReasoningEffort: true });
	});

	it("moves stale bundled rows onto the Responses route without their completions compat", () => {
		const routed = routeGitHubCopilotModelSpec(COMPLETIONS_ROW);
		expect(routed.api).toBe("openai-responses");
		expect(routed.compat).toBeUndefined();

		const chatRow = { ...COMPLETIONS_ROW, id: "gpt-4.1" };
		expect(routeGitHubCopilotModelSpec(chatRow)).toBe(chatRow);
	});

	it("drops another provider's wire routing from an enterprise-only id without mutating the shared reference", async () => {
		const copilotIds = new Set(getBundledModels("github-copilot").map(model => model.id));
		const routedReference = getBundledProviders()
			.filter(provider => provider !== "github-copilot")
			.flatMap(provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]))
			.find(
				model =>
					!copilotIds.has(model.id) &&
					(model.requestModelId !== undefined || model.thinking?.effortRouting !== undefined),
			);
		expect(routedReference).toBeDefined();
		if (!routedReference) return;
		const referenceRouting = structuredClone(routedReference.thinking?.effortRouting);

		const models = await discover([routedReference.id]);
		const discovered = models.find(model => model.id === routedReference.id);

		expect(discovered?.requestModelId).toBeUndefined();
		expect(discovered?.thinking?.effortRouting).toBeUndefined();
		expect(routedReference.thinking?.effortRouting).toEqual(referenceRouting);
	});
});
