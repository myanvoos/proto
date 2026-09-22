import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import { initThemeSync, theme } from "../modes/theme/theme";
import { truncateToWidth } from "../tools/render-utils";
import { renderMCPResult } from "./render";

await Settings.init({ inMemory: true });
initThemeSync();

function visible(component: Component, width: number): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(truncateToWidth(line, width, "")))
		.join("")
		.replaceAll(" ", "");
}

test("narrow MCP JSON output preserves complete package names rather than losing values to tree prefixes", () => {
	const packages = ["@ai-sdk/anthropic", "@oh-my-pi/pi-ai", "@oh-my-pi/pi-tui"];
	const component = renderMCPResult(
		{ content: [{ type: "text", text: JSON.stringify(packages) }] },
		{ expanded: false, isPartial: false },
		theme,
	);
	expect(visible(component, 8)).toContain("@ai-sdk/anthropic");
	expect(visible(component, 8)).toContain("@oh-my-pi/pi-ai");
	expect(visible(component, 12)).toContain("@oh-my-pi/pi-tui");
});

test("expanded MCP JSON arguments and result values survive narrowing the same component", () => {
	const component = renderMCPResult(
		{ content: [{ type: "text", text: JSON.stringify({ id: "request-id-1234567890" }) }] },
		{ expanded: true, isPartial: false },
		theme,
		{ query: "lookup-id-9876543210" },
	);
	for (const width of [40, 8, 40]) {
		const output = visible(component, width);
		expect(output).toContain("lookup-id-9876543210");
		expect(output).toContain("request-id-1234567890");
	}
});

test("expanded Markdown MCP results preserve narrow argument trees as well as rendered Markdown", () => {
	const component = renderMCPResult(
		{ content: [{ type: "text", text: "**done**" }] },
		{ expanded: true, isPartial: false },
		theme,
		{ query: "lookup-id-9876543210" },
	);
	const output = visible(component, 8);
	expect(output).toContain("lookup-id-9876543210");
	expect(output).toContain("done");
	expect(output).not.toContain("**");
});
