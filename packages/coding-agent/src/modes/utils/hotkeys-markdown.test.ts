import { expect, test } from "bun:test";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { buildHotkeysMarkdown } from "./hotkeys-markdown";

function bindingsWith(exitKeys: KeyId[], deleteCharForwardKeys: readonly string[] = ["ctrl+d"]) {
	return {
		keybindings: {
			getDisplayString: (action: string) =>
				action === "app.agents.fleet" ? "Alt+A" : action === "app.session.observe" ? "Ctrl+S" : action,
			getKeys: (action: string): KeyId[] => (action === "app.exit" ? exitKeys : []),
			matchesCanonical: (canonical: string | undefined, action: string) =>
				action === "tui.editor.deleteCharForward" &&
				canonical !== undefined &&
				deleteCharForwardKeys.includes(canonical),
		},
	};
}

const bindings = bindingsWith(["ctrl+d"]);

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

test("exit hotkey rows describe each key by the role it actually has", () => {
	const exitRows = (markdown: string) =>
		markdown.split("\n").filter(line => /\| (Exit|Delete char forward)/.test(line));

	expect(exitRows(buildHotkeysMarkdown(bindingsWith(["ctrl+d"])))).toEqual([
		"| `Ctrl+D` | Delete char forward (with draft) / exit (empty prompt) |",
	]);
	expect(exitRows(buildHotkeysMarkdown(bindingsWith(["ctrl+q"])))).toEqual(["| `Ctrl+Q` | Exit |"]);
	expect(exitRows(buildHotkeysMarkdown(bindingsWith(["ctrl+d", "ctrl+q"])))).toEqual([
		"| `Ctrl+D` | Delete char forward (with draft) / exit (empty prompt) |",
		"| `Ctrl+Q` | Exit |",
	]);
	expect(exitRows(buildHotkeysMarkdown(bindingsWith([])))).toEqual(["| `Disabled` | Exit |"]);
});
