import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../config/settings";
import { initThemeSync } from "../theme/theme";
import { ModelBrowser, type ModelBrowserItem } from "./model-browser";

initThemeSync();

type ItemMetadata = { int?: number; tps?: number } & Pick<Model, "description" | "isNew" | "isBeta" | "isRecommended">;

function item(id: string, metrics: ItemMetadata): ModelBrowserItem {
	const model = buildModel({
		id,
		name: id,
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...metrics,
	}) as Model;
	return { provider: "openai", id, model, selector: `openai/${id}` };
}

function renderedRow(browser: ModelBrowser, id: string): string {
	const line = browser
		.render(140)
		.map(row => Bun.stripANSI(row))
		.find(row => row.includes(id));
	if (!line) throw new Error(`row for ${id} not rendered`);
	return line;
}

test("rows show catalog intelligence and estimated speed until a measurement replaces the estimate", () => {
	const browser = new ModelBrowser(Settings.isolated(), { showProvider: false });
	browser.setItems([item("scored-model", { int: 60.9, tps: 70.4 }), item("unscored-model", {})]);

	expect(renderedRow(browser, "scored-model")).toContain("IQ 61  ~70t/s");
	expect(renderedRow(browser, "unscored-model")).not.toContain("IQ");

	browser.setPerfStats(new Map([["openai/scored-model", { samples: 3, tps: 118, ttftMs: 900 }]]));
	const measured = renderedRow(browser, "scored-model");
	expect(measured).toContain("0.9s 118t/s");
	expect(measured).not.toContain("~70t/s");
});

test("detail line badges discovery flags and appends the provider blurb as one row", () => {
	const browser = new ModelBrowser(Settings.isolated(), { showProvider: false });
	browser.setItems([
		item("swe-2", { description: "Fast\tagentic\ncoder", isNew: true, isBeta: true, isRecommended: true }),
	]);
	const detail = browser
		.render(200)
		.map(row => Bun.stripANSI(row))
		.find(row => row.includes("swe-2 · "));

	expect(detail).toContain("swe-2 · new · beta · recommended · 200k ctx");
	expect(detail).toMatch(/per M · Fast {2,}agentic coder$/);
});

function priced(provider: string, id: string, input: number, output: number): ModelBrowserItem {
	const model = item(id, {}).model;
	model.cost.input = input;
	model.cost.output = output;
	return { provider, id, model, selector: `${provider}/${id}` };
}

test("price column keeps tiny rates as decimals and marks invalid legs", () => {
	const browser = new ModelBrowser(Settings.isolated(), { showProvider: false });
	browser.setItems([
		priced("fixture", "tiny", 0.0000005, 0.00005),
		priced("fixture", "zero", 0, 0),
		priced("fixture", "negative", -1, 0),
		priced("fixture", "invalid", Number.NaN, Number.POSITIVE_INFINITY),
	]);
	expect(renderedRow(browser, "tiny")).toContain("$0.0000005/0.00005");
	expect(renderedRow(browser, "zero")).toContain("free");
	expect(renderedRow(browser, "negative")).toContain("$?/0");
	expect(renderedRow(browser, "invalid")).toContain("$?/?");
});

test("typing free finds zero-cost models whose id never says free, but not invalid negative rates", () => {
	const browser = new ModelBrowser(Settings.isolated(), { showProvider: true });
	browser.setItems([
		priced("nvidia", "nemotron-3-nano", 0, 0),
		priced("anthropic", "claude-sonnet-4-5", 3, 15),
		priced("fixture", "negative", -1, 0),
	]);
	browser.setQuery("free");
	const rows = browser.render(140).map(row => Bun.stripANSI(row));
	expect(browser.getSelected()?.selector).toBe("nvidia/nemotron-3-nano");
	expect(rows.some(row => row.includes("claude-sonnet-4-5"))).toBe(false);
	expect(rows.some(row => row.includes("negative"))).toBe(false);
});
