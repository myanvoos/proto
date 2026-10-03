import { expect, test } from "bun:test";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { initThemeSync, type Theme, theme } from "../../modes/theme/theme";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolDefinition } from "./types";
import { RegisteredToolAdapter } from "./wrapper";

initThemeSync();

type RenderCall = NonNullable<ToolDefinition["renderCall"]>;

function queryOf(args: unknown): string {
	return args && typeof args === "object" && "query" in args ? String(args.query) : "";
}

function renderWith(renderCall: RenderCall, options: { expanded: boolean; isPartial: boolean }): string {
	const registered: RegisteredTool = {
		extensionPath: "/test/extension.ts",
		definition: {
			name: "search",
			label: "Search",
			description: "search tool",
			parameters: {} as never,
			execute: async () => ({ content: [] }),
			renderCall,
		},
	};
	const adapter = new RegisteredToolAdapter(registered, {} as ExtensionRunner);
	const rendered: Component | undefined = adapter.renderCall?.({ query: "needle" }, options, theme);
	if (!rendered) throw new Error("renderCall missing on adapter");
	return Bun.stripANSI(rendered.render(80).join("\n")).trim();
}

test("renderCall accepts both proto (args, options, theme) and pi (args, theme, context) argument orders", () => {
	// Compiled pi-era plugins declare renderCall(args, theme, context); the cast mirrors what reaches the adapter.
	const piOrder = ((args: unknown, piTheme: Theme) =>
		new Text(piTheme.fg("toolTitle", piTheme.bold("search ")) + queryOf(args), 0, 0)) as unknown as RenderCall;
	const protoOrder: RenderCall = (args, options, protoTheme) =>
		new Text(protoTheme.bold("search ") + queryOf(args) + (options.expanded ? " [expanded]" : ""), 0, 0);

	expect(renderWith(piOrder, { expanded: false, isPartial: false })).toBe("search needle");
	expect(renderWith(protoOrder, { expanded: true, isPartial: false })).toBe("search needle [expanded]");
});
