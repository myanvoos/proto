import { expect, test } from "bun:test";
import { initThemeSync } from "../../theme/theme";
import { ExtensionList } from "./extension-list";
import type { Extension } from "./types";

initThemeSync();

function mcpRow(overrides: Partial<Extension>): Extension {
	return {
		id: "mcp:github",
		kind: "mcp",
		name: "github",
		displayName: "github",
		path: "/home/user/.proto/mcp.json",
		source: { provider: "native", providerName: "Native", level: "user" },
		state: "active",
		raw: {},
		...overrides,
	};
}

test("multi-line names and triggers render as one physical row", () => {
	const list = new ExtensionList([
		mcpRow({
			id: "rule:dirty",
			kind: "rule",
			name: "dirty",
			displayName: "dirty\nname",
			trigger: "src/**/*.ts\nextra",
		}),
	]);
	const lines = list.render(80);
	expect(lines.some(line => line.includes("\n") || line.includes("\r"))).toBe(false);
	expect(lines.some(line => Bun.stripANSI(line).includes("dirty name"))).toBe(true);
});

test("a shadowed same-id row cannot be toggled", () => {
	const toggles: Array<[string, boolean]> = [];
	const shadowed = mcpRow({
		path: "/project/.proto/mcp.json",
		source: { provider: "native", providerName: "Native", level: "project" },
		state: "shadowed",
		disabledReason: "shadowed",
		raw: { _shadowed: true },
	});
	const list = new ExtensionList([shadowed], { onToggle: (id, enabled) => toggles.push([id, enabled]) });
	// Row 0 is the kind header.
	list.handleInput("\x1b[B");
	list.handleInput(" ");
	list.setExtensions([{ ...shadowed, state: "disabled", disabledReason: "item-disabled" }]);
	list.handleInput(" ");
	expect(toggles).toEqual([]);

	const winner = mcpRow({});
	const winnerList = new ExtensionList([winner], { onToggle: (id, enabled) => toggles.push([id, enabled]) });
	winnerList.handleInput("\x1b[B");
	winnerList.handleInput(" ");
	expect(toggles).toEqual([["mcp:github", false]]);
});

test("j and k type into the search instead of moving the selection", () => {
	const list = new ExtensionList([
		mcpRow({ name: "jira", displayName: "jira" }),
		mcpRow({ name: "kafka", displayName: "kafka" }),
	]);
	list.handleInput("j");
	list.handleInput("k");
	expect(list.getSearchQuery()).toBe("jk");
});
