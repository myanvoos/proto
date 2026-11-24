import { expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "./settings";

test("setProviderDisabled toggles one bare id and keeps path-scoped entries as written", () => {
	const settings = Settings.isolated();
	const elsewhere = { path: path.join(settings.getCwd(), "..", "proto-elsewhere"), providers: ["anthropic"] };
	settings.set("disabledProviders", ["ollama", elsewhere] as never);

	expect(settings.setProviderDisabled("graylinglabs", true)).toBe(true);
	expect(settings.getLayerSettings("global").disabledProviders).toEqual(["ollama", elsewhere, "graylinglabs"]);
	expect(settings.get("disabledProviders")).toEqual(["ollama", "graylinglabs"]);

	expect(settings.setProviderDisabled("ollama", false)).toBe(true);
	expect(settings.getLayerSettings("global").disabledProviders).toEqual([elsewhere, "graylinglabs"]);
	// Already in the requested state: no write.
	expect(settings.setProviderDisabled("ollama", false)).toBe(true);
	expect(settings.getLayerSettings("global").disabledProviders).toEqual([elsewhere, "graylinglabs"]);
});

test("setProviderDisabled reports when a higher layer or a scoped entry decides the effective list", () => {
	const shadowed = Settings.isolated({ disabledProviders: ["groq"] });
	expect(shadowed.setProviderDisabled("openai", true)).toBe(false);
	expect(shadowed.get("disabledProviders")).toEqual(["groq"]);

	const scoped = Settings.isolated();
	scoped.set("disabledProviders", [{ path: scoped.getCwd(), providers: ["anthropic"] }] as never);
	expect(scoped.get("disabledProviders")).toEqual(["anthropic"]);
	expect(scoped.setProviderDisabled("anthropic", false)).toBe(false);
});
