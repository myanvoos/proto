import { expect, test } from "bun:test";
import { defineCapability, loadCapability, registerProvider } from ".";
import type { SourceMeta } from "./types";

interface Item {
	name: string;
	alias: string;
	_source: SourceMeta;
	_shadowed?: boolean;
}

function item(name: string, alias: string, provider: string): Item {
	return { name, alias, _source: { provider, providerName: provider, path: `/${name}`, level: "project" } };
}

// Providers load in priority order: `high` items come first and normally win their key.
function defineTwoProviderCapability(id: string, high: Item, low: Item): void {
	defineCapability<Item>({
		id,
		displayName: id,
		description: id,
		key: entry => entry.name,
		equivalent: (left, right) => left.alias === right.alias,
		toExtensionId: entry => `${id}:${entry.name}:${entry._source.provider}`,
	});
	registerProvider<Item>(id, {
		id: `${id}-high`,
		displayName: "high",
		description: "",
		priority: 20,
		load: async () => ({ items: [high] }),
	});
	registerProvider<Item>(id, {
		id: `${id}-low`,
		displayName: "low",
		description: "",
		priority: 10,
		load: async () => ({ items: [low] }),
	});
}

test("a disabled higher-priority item never shadows the enabled item that wins at runtime", async () => {
	const id = "test-disabled-winner";
	defineTwoProviderCapability(id, item("same", "a", `${id}-high`), item("same", "b", `${id}-low`));
	const disabledExtensions = [`${id}:same:${id}-high`];

	const runtime = await loadCapability<Item>(id, { disabledExtensions });
	expect(runtime.items.map(entry => entry._source.provider)).toEqual([`${id}-low`]);

	const dashboard = await loadCapability<Item>(id, { disabledExtensions, includeDisabled: true });
	const enabled = dashboard.all.find(entry => entry._source.provider === `${id}-low`);
	expect(enabled?._shadowed).toBeUndefined();
	expect(dashboard.items).toContain(enabled!);
});

test("a disabled item never wins an equivalence class over an enabled alias", async () => {
	const id = "test-disabled-alias";
	defineTwoProviderCapability(id, item("first", "same", `${id}-high`), item("second", "same", `${id}-low`));
	const disabledExtensions = [`${id}:first:${id}-high`];

	const dashboard = await loadCapability<Item>(id, { disabledExtensions, includeDisabled: true });
	expect(dashboard.all.find(entry => entry.name === "second")?._shadowed).toBeUndefined();
});

test("a disabled lower-priority item behind an enabled owner is reported as shadowed", async () => {
	const id = "test-disabled-loser";
	defineTwoProviderCapability(id, item("same", "a", `${id}-high`), item("same", "b", `${id}-low`));
	const disabledExtensions = [`${id}:same:${id}-low`];

	const dashboard = await loadCapability<Item>(id, { disabledExtensions, includeDisabled: true });
	expect(dashboard.all.find(entry => entry._source.provider === `${id}-high`)?._shadowed).toBeUndefined();
	expect(dashboard.all.find(entry => entry._source.provider === `${id}-low`)?._shadowed).toBe(true);
});
