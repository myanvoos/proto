import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import { renderMCPResult } from "../mcp/render";
import type { MCPToolDetails } from "../mcp/tool-bridge";
import { initThemeSync, theme } from "../modes/theme/theme";
import { computerToolRenderer } from "./computer-renderer";
import { formatDefaultToolExecution } from "./default-renderer";
import { renderReadUrlResult } from "./fetch";
import { fleetToolRenderer } from "./fleet";
import { inspectMediaToolRenderer } from "./inspect-media-renderer";
import {
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import type { XdevDispatch } from "./xdev";
import { renderXdevResult } from "./xdev";

await Settings.init();
initThemeSync();

const WIDTH = 100;
const LAST_LINE = "line 120";
const BODY = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
const TEXT_RESULT = { content: [{ type: "text", text: BODY }] };

function strip(lines: readonly string[] | string): string {
	const text = typeof lines === "string" ? lines : lines.join("\n");
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function renderText(component: Component | undefined): string {
	return strip(component?.render(WIDTH) ?? []);
}

// Every renderer that shows a truncated body plus a "… N more lines" hint: the
// hint advertises Ctrl+O, so expanding must leave nothing behind. A regression
// strands the user — the hint disappears while the lines stay hidden.
const RENDERERS: Array<{ name: string; render: (expanded: boolean) => string }> = [
	{
		name: "default tool card",
		render: expanded =>
			strip(
				formatDefaultToolExecution(
					{
						label: "tool",
						args: { a: 1 },
						options: { expanded, isPartial: false },
						result: { output: BODY },
					},
					WIDTH,
					theme,
				),
			),
	},
	{
		name: "mcp tool result",
		render: expanded =>
			renderText(
				renderMCPResult(
					{ ...TEXT_RESULT, details: { serverName: "srv", mcpToolName: "tool" } satisfies MCPToolDetails },
					{ expanded, isPartial: false },
					theme,
					{},
				),
			),
	},
	{
		name: "xd composite card",
		render: expanded => {
			const dispatches: XdevDispatch[] = [
				{ tool: "browser", mode: "execute" },
				{ tool: "fleet", mode: "execute" },
			];
			return renderText(renderXdevResult(dispatches, TEXT_RESULT, { expanded, isPartial: false }, theme));
		},
	},
	{
		name: "inspect_media result",
		render: expanded =>
			renderText(
				inspectMediaToolRenderer.renderResult(TEXT_RESULT, { expanded, isPartial: false }, theme, {
					path: "shot.png",
					question: "what is here?",
				}),
			),
	},
	{
		name: "read url content preview",
		render: expanded =>
			renderText(
				renderReadUrlResult(
					{
						...TEXT_RESULT,
						details: {
							kind: "url",
							url: "https://example.test",
							finalUrl: "https://example.test",
							contentType: "text/plain",
							method: "GET",
							truncated: false,
							notes: [],
						},
					},
					{ expanded, isPartial: false },
					theme,
				),
			),
	},
	{
		name: "computer result",
		render: expanded =>
			renderText(
				computerToolRenderer.renderResult(
					{ ...TEXT_RESULT, details: { screenshots: [], code: "click(1, 2)" } },
					{ expanded, isPartial: false },
					theme,
					{ code: "click(1, 2)" },
				),
			),
	},
	{
		name: "fleet message body",
		render: expanded =>
			renderText(
				fleetToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "sent" }],
						details: { op: "send", receipts: [{ to: "peer", outcome: "delivered" }] },
					},
					{ expanded, isPartial: false },
					theme,
					{ op: "send", message: BODY },
				),
			),
	},
];

for (const { name, render } of RENDERERS) {
	test(`${name}: collapsed caps the body, expanded reveals all of it`, () => {
		const collapsed = render(false);
		expect(collapsed).not.toContain(LAST_LINE);
		expect(collapsed).toMatch(/more lines/);

		const expanded = render(true);
		expect(expanded).toContain(LAST_LINE);
		expect(expanded).not.toMatch(/more lines/);
	});
}

test("json output tree: expanded keeps no depth or line cap", () => {
	let deep: Record<string, unknown> = { leaf: "deepest-value" };
	for (let index = 0; index < 12; index++) deep = { [`level${index}`]: deep };
	const value = { deep, wide: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`key${i}`, i])) };

	const tree = renderJsonTreeLines(
		value,
		theme,
		JSON_TREE_MAX_DEPTH_EXPANDED,
		JSON_TREE_MAX_LINES_EXPANDED,
		JSON_TREE_SCALAR_LEN_EXPANDED,
	);

	expect(tree.truncated).toBe(false);
	const rendered = strip(tree.lines);
	expect(rendered).toContain("deepest-value");
	expect(rendered).toContain("key399");
});
