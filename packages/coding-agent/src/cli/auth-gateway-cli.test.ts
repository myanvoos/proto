import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { createSerializedRebuilder, indexModelsByRequestId, resolveGatewayModel } from "./auth-gateway-cli";

function gatedRun() {
	const calls: boolean[] = [];
	const gates: PromiseWithResolvers<void>[] = [];
	const run = (force: boolean): Promise<void> => {
		calls.push(force);
		const gate = Promise.withResolvers<void>();
		gates.push(gate);
		return gate.promise;
	};
	return { calls, gates, run };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("createSerializedRebuilder", () => {
	test("credential-triggered forced rebuild during a cached pass runs its own forced pass", async () => {
		const { calls, gates, run } = gatedRun();
		const rebuild = createSerializedRebuilder(run);
		let forcedSettled = false;

		void rebuild(false);
		const forced = rebuild(true).then(() => {
			forcedSettled = true;
		});
		expect(calls).toEqual([false]);

		gates[0]!.resolve();
		await flush();
		expect(calls).toEqual([false, true]);
		expect(forcedSettled).toBe(false);

		gates[1]!.resolve();
		await forced;
		expect(calls).toEqual([false, true]);
	});

	test("periodic rebuild during an in-flight pass coalesces without an extra refresh", async () => {
		const { calls, gates, run } = gatedRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		const second = rebuild(false);
		gates[0]!.resolve();
		await Promise.all([first, second]);
		expect(calls).toEqual([false]);

		void rebuild(false);
		expect(calls).toEqual([false, false]);
		gates[1]!.resolve();
	});
});

test("gateway OpenRouter variants preserve the routing suffix and require a routable base model", () => {
	const base = getBundledModels("openrouter")[0];
	if (!base) throw new Error("OpenRouter fixture unavailable");
	const index = indexModelsByRequestId([base], new Set(["openrouter"]));
	const variant = `${base.id}:floor`;
	expect(resolveGatewayModel(`openrouter/${variant}`, index)?.id).toBe(variant);
	expect(resolveGatewayModel(`openrouter/${variant}`, indexModelsByRequestId([], new Set()))).toBeUndefined();
	expect(resolveGatewayModel(`other/${variant}`, index)).toBeUndefined();
});

test("gateway bare ids prefer configured credentialed providers and route-native APIs within a priority tier", () => {
	const base = getBundledModels("openai")[0];
	if (!base) throw new Error("OpenAI fixture unavailable");
	const native: Model<Api> = { ...base, id: "shared", provider: "openai", api: "openai-responses" };
	const alternate: Model<Api> = { ...base, id: "shared", provider: "custom", api: "openai-completions" };
	const hidden: Model<Api> = { ...base, id: "shared", provider: "uncredentialed" };
	const models = [hidden, native, alternate];
	const credentials = new Set(["openai", "custom"]);
	const configured = indexModelsByRequestId(models, credentials, ["custom", "openai"]);
	expect(resolveGatewayModel("shared", configured, { api: "openai-responses" })?.provider).toBe("custom");
	expect(
		resolveGatewayModel("shared", configured, { accepts: candidate => candidate.provider !== "custom" })?.provider,
	).toBe("openai");
	expect(resolveGatewayModel("uncredentialed/shared", configured)).toBeUndefined();
	const tied = indexModelsByRequestId(
		[{ ...native, provider: "custom-z" }, alternate],
		new Set(["custom-z", "custom"]),
	);
	expect(resolveGatewayModel("shared", tied, { api: "openai-responses" })?.provider).toBe("custom-z");
	expect(resolveGatewayModel("shared", tied, { api: "openai-completions" })?.provider).toBe("custom");
	expect(
		resolveGatewayModel("custom/shared", tied, { accepts: candidate => candidate.provider !== "custom" }),
	).toBeUndefined();
});
