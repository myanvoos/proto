import { expect, test } from "bun:test";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "./cli/args";
import { Settings } from "./config/settings";
import { rebuildScopedModels } from "./main";

test("extension models discovered after session creation join the explicit CLI model scope before another background refresh", async () => {
	const base = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!base) throw new Error("Missing model fixture");
	const extension: Model = { ...base, provider: "scope-extension", id: "new-model" };
	let available: Model[] = [base];
	let scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];
	const session = {
		isDisposed: false,
		get scopedModels() {
			return scopedModels;
		},
		setScopedModels: (models: typeof scopedModels) => {
			scopedModels = models;
		},
	};
	const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });
	const args = parseArgs(["--models", "scope-extension/*"]);
	available = [base, extension];
	const rebuilt = await rebuildScopedModels(session, args, { getAvailable: () => available }, settings);
	expect(rebuilt?.map(item => item.model.provider)).toEqual(["scope-extension"]);
	expect(scopedModels.map(item => item.model.id)).toEqual(["new-model"]);
	session.isDisposed = true;
	available = [{ ...extension, id: "later-model" }];
	await rebuildScopedModels(session, args, { getAvailable: () => available }, settings);
	expect(scopedModels.map(item => item.model.id)).toEqual(["new-model"]);
});
