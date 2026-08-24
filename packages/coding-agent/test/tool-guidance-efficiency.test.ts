import { describe, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import bashPrompt from "../src/prompts/tools/bash.md" with { type: "text" };

const bash = prompt.render(bashPrompt, {
	asyncEnabled: true,
	autoBackgroundEnabled: true,
	autoBackgroundThresholdSeconds: 60,
	hasEval: true,
	hasLaunch: true,
	hasRead: true,
	hasShellBuiltins: true,
	isWindows: false,
});

describe("tool guidance efficiency", () => {
	test("keeps the corrected guidance smaller than the previous prompt set", () => {
		expect(bash.length).toBeLessThan(1_500);
	});
});
