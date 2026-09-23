import { afterEach, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { generateSessionTitle } from "./title-generator";

const smol = getBundledModel("anthropic", "claude-opus-4-8")!;
const fallback = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const registry = {
	getAvailable: () => [smol, fallback],
	getApiKey: async () => "test-key",
	resolver: () => async () => "test-key",
} as unknown as ModelRegistry;

function settings(): Settings {
	const result = Settings.isolated({
		"providers.tinyModel": "online",
		"retry.fallbackChains": { smol: [`${fallback.provider}/${fallback.id}`] },
	});
	result.setModelRole("smol", `${smol.provider}/${smol.id}`);
	return result;
}

afterEach(() => {
	vi.restoreAllMocks();
});

it("walks retry.fallbackChains when the title model returns a provider error", async () => {
	const complete = vi
		.spyOn(ai, "completeSimple")
		.mockImplementation(async model =>
			model.id === smol.id
				? ({ stopReason: "error", errorStatus: 400, errorMessage: "model unavailable", content: [] } as never)
				: ({ stopReason: "stop", content: [{ type: "text", text: "<title>Recovered Title</title>" }] } as never),
		);

	expect(await generateSessionTitle("Investigate the resolver", registry, settings())).toBe("Recovered Title");
	expect(complete.mock.calls.map(call => call[0].id)).toEqual([smol.id, fallback.id]);
});

it("stops walking fallbacks once the session signal aborts", async () => {
	const controller = new AbortController();
	const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
		controller.abort();
		return { stopReason: "aborted", content: [] } as never;
	});

	const title = await generateSessionTitle(
		"Investigate the resolver",
		registry,
		settings(),
		undefined,
		undefined,
		undefined,
		undefined,
		controller.signal,
	);
	expect(title).toBeNull();
	expect(complete).toHaveBeenCalledTimes(1);
});
