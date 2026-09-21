import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "../tools";
import { runEvalCompletion } from "./completion-bridge";

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions", reasoning: false } as unknown as Model<Api>;
}

/**
 * Resolution runs before any network call, and the missing-credential branch names the model it
 * settled on — so every assertion below observes the selected model without issuing a request.
 */
function stubSession(available: Model<Api>[], roles: Record<string, string> = {}): ToolSession {
	return {
		settings: { get: () => undefined, getModelRole: (role: string) => roles[role] },
		modelRegistry: { getAvailable: () => available, getApiKey: async () => undefined },
	} as unknown as ToolSession;
}

async function completionError(session: ToolSession, selector: string): Promise<string> {
	try {
		await runEvalCompletion({ prompt: "hi", model: selector }, { session });
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`expected completion(model: ${selector}) to reject`);
}

const AMBIGUOUS = [model("vendor-a", "shared-model"), model("vendor-b", "shared-model")];

test("a bare model id offered by several providers is rejected with qualified alternatives", async () => {
	expect(await completionError(stubSession(AMBIGUOUS), "shared-model")).toBe(
		'completion() model "shared-model" is ambiguous: vendor-a, vendor-b all provide it. Qualify it as "vendor-a/shared-model" or "vendor-b/shared-model".',
	);
});

test("a bare model id offered by one provider resolves to that provider", async () => {
	const session = stubSession([model("vendor-a", "solo-model"), model("vendor-b", "other-model")]);
	expect(await completionError(session, "solo-model")).toStartWith(
		"completion() has no API key for vendor-a/solo-model.",
	);
});

test("a provider-qualified reference picks that provider out of an ambiguous pool", async () => {
	expect(await completionError(stubSession(AMBIGUOUS), "vendor-b/shared-model")).toStartWith(
		"completion() has no API key for vendor-b/shared-model.",
	);
});

test("an id missing from the pool reports the pool's near matches", async () => {
	const session = stubSession([model("vendor-a", "claude-opus-5"), model("vendor-b", "gpt-6")]);
	expect(await completionError(session, "opus")).toBe(
		'completion() model "opus" is not in the model pool. Pass a tier ("smol", "default", "slow") or an available model id. Closest available: vendor-a/claude-opus-5.',
	);
});

test("tier names still route through modelRoles instead of the model pool", async () => {
	const session = stubSession([model("vendor-a", "tiny-model"), model("vendor-b", "big-model")], {
		smol: "vendor-a/tiny-model",
	});
	expect(await completionError(session, "smol")).toStartWith("completion() has no API key for vendor-a/tiny-model.");
});
