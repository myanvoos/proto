import { expect, test } from "bun:test";
import { buildHotkeysMarkdown } from "./hotkeys-markdown";

const bindings = {
	keybindings: {
		getDisplayString: (action: string) =>
			action === "app.agents.fleet" ? "Alt+A" : action === "app.session.observe" ? "Ctrl+S" : action,
	},
};

function rowFor(markdown: string, match: string): string {
	const row = markdown.split("\n").find(line => line.includes(match));
	expect(row).toBeDefined();
	return row ?? "";
}

test("the fleet hotkeys row does not claim the double-tap gestures open the fleet", () => {
	const markdown = buildHotkeysMarkdown(bindings);
	const fleetRow = rowFor(markdown, "Open the agent fleet");

	expect(fleetRow).toContain("`Alt+A`");
	expect(fleetRow).toContain("`Ctrl+S`");
	expect(fleetRow).not.toContain("double-tap");
});

test("the double-tap arrow gestures are documented as the views they actually open", () => {
	const markdown = buildHotkeysMarkdown(bindings);

	expect(rowFor(markdown, "double-tap `←`")).toContain("session switcher");
	expect(rowFor(markdown, "double-tap `→`")).toContain("subagents");
});
