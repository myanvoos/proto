import { expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";

initThemeSync();

function plain(component: ToolExecutionComponent): string {
	return component
		.render(120)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

test("partial tool-result deltas coalesce rebuilds while preserving the newest and final result", () => {
	let scheduledRenders = 0;
	let customResultRenders = 0;
	const ui: ToolExecutionUi = {
		requestRender: () => {},
		requestComponentRender: () => {
			scheduledRenders++;
		},
	};
	const tool = {
		label: "streaming-test",
		execute: async () => ({ content: [] }),
		renderResult: (result: { content: Array<{ type: string; text?: string }> }) => {
			customResultRenders++;
			const text = result.content.map(block => block.text ?? "").join("\n");
			return new Text(text, 0, 0);
		},
	} as unknown as AgentTool;
	const component = new ToolExecutionComponent("streaming-test", {}, { useBuiltInRenderer: false }, tool, ui);

	try {
		for (let index = 0; index < 1000; index++) {
			component.updateResult({ content: [{ type: "text", text: `partial-${index}` }] }, true);
		}

		expect(scheduledRenders).toBe(1);
		expect(customResultRenders).toBe(0);
		expect(plain(component)).toContain("partial-999");
		expect(plain(component)).not.toContain("partial-998");
		expect(customResultRenders).toBe(1);

		component.updateResult({ content: [{ type: "text", text: "final-result" }] }, false);
		expect(customResultRenders).toBe(2);
		expect(plain(component)).toContain("final-result");
		expect(plain(component)).not.toContain("partial-999");
	} finally {
		component.dispose();
	}
});
