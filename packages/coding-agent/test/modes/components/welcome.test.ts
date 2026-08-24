import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the hero wordmark and truncates an overlong model meta line", () => {
		const modelName = "DeepSeek V4 Flash (2x usage)";
		const strip = (width: number) =>
			new WelcomeComponent("17.3.4", modelName, "opencode-go")
				.render(width)
				.map(line => Bun.stripANSI(line))
				.join("\n");

		const wide = strip(80);
		expect(wide).toContain("p r o t o");
		expect(wide).toContain(`v17.3.4 · ${modelName} · opencode-go`);

		const narrow = strip(45);
		expect(narrow.split("\n").filter(line => line.includes("v17.3.4"))).toHaveLength(1);
		expect(narrow).toContain("DeepSeek V4");
		expect(narrow).toContain("…");
		expect(narrow).not.toContain("opencode-go");
		expect(narrow).not.toContain("│");
	});
});
