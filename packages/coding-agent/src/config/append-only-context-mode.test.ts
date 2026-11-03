import { expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "./append-only-context-mode";

test.each(["google", "google-vertex", "google-gemini-cli"])(
	"%s preserves cache prefixes automatically but honors an explicit opt-out",
	provider => {
		const model = { provider, baseUrl: "https://generativelanguage.googleapis.com" };
		expect(shouldEnableAppendOnlyContext("auto", model)).toBe(true);
		expect(shouldEnableAppendOnlyContext("off", model)).toBe(false);
	},
);
