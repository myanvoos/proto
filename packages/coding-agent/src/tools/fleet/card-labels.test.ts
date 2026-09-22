import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../../modes/theme/theme";
import { renderStatusLine } from "../../tui";
import { messagingRenderResult } from "./messaging";

initThemeSync();

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderFleet(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	args: Record<string, unknown>,
): string[] {
	const component = messagingRenderResult(
		result as never,
		{ expanded: false, isPartial: false } as never,
		theme,
		args as never,
	);
	return component.render(100).map(strip);
}

test("the peers card names the tool, not its transport, and separates its state", () => {
	const lines = renderFleet({ content: [], details: { op: "list", peers: [] } }, { op: "list" });
	const header = lines.find(line => line.includes("peers")) ?? "";
	expect(header).toContain("Fleet peers");
	expect(header).not.toContain("IRC");
	expect(header).toContain("·");
	expect(header).toMatch(/Fleet peers\s+·\s+no other agents/);
});

test("a fleet validation failure renders one row per error line", () => {
	const message = [
		'Validation failed for tool "fleet":',
		'  - op: op must be "send" or "list" (was "broadcast")',
	].join("\n");
	const lines = renderFleet({ content: [{ type: "text", text: message }], isError: true }, { op: "broadcast" });
	expect(lines.some(line => line.includes('Validation failed for tool "fleet"'))).toBe(true);
	const bullet = lines.find(line => line.includes("- op:"));
	expect(bullet).toBeDefined();
	// The detail indent sits on top of the message's own bullet indent.
	expect(bullet?.startsWith("    - op:")).toBe(true);
	// Each line is its own row, so no row carries an embedded newline.
	for (const line of lines) expect(line.includes("\n")).toBe(false);
});

test("a single meta value is separated from the title", () => {
	const line = strip(renderStatusLine({ icon: "info", title: "Fleet peers", meta: ["no other agents"] }, theme));
	expect(line).toContain("Fleet peers · no other agents");
});
