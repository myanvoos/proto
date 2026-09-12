import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { createExtensionModelQuery } from "./model-api";

function model(provider: string, id: string): Model {
	return { provider, id } as Model;
}

function query(current: Model, smol: Model, tiny: Model) {
	const available = [current, smol, tiny];
	const registry = { getAvailable: () => available } as ModelRegistry;
	const settings = Settings.isolated({
		modelRoles: { smol: `${smol.provider}/${smol.id}`, tiny: `${tiny.provider}/${tiny.id}` },
	});
	return createExtensionModelQuery(registry, settings, () => current);
}

test("role candidates prefer smol then tiny before an unrelated active model", () => {
	const current = model("active-provider", "large");
	const smol = model("fast-provider", "small");
	const tiny = model("local-provider", "tiny");

	expect(query(current, smol, tiny).roleCandidates(["smol", "tiny"])).toEqual([smol, tiny, current]);
});

test("role candidates keep an active smol or tiny model first", () => {
	const smol = model("fast-provider", "small");
	const tiny = model("local-provider", "tiny");

	expect(query(tiny, smol, tiny).roleCandidates(["smol", "tiny"])).toEqual([tiny, smol]);
});
