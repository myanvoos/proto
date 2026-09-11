import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { ToolExecutionComponent, type ToolExecutionUi } from "../components/tool-execution";
import { initTheme } from "../theme/theme";
import { decodeStreamedToolArgs, ToolArgsRevealController } from "./tool-args-reveal";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const UI: ToolExecutionUi = {
	requestRender: NOOP,
	requestComponentRender: NOOP,
	resetDisplay: NOOP,
};

function renderedEnvLine(args: Record<string, unknown>): string {
	const component = new ToolExecutionComponent("bash", args, {}, undefined, UI);
	try {
		const plainRows = component.render(160).map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));
		return plainRows.find(row => row.includes("FOO=")) ?? "";
	} finally {
		component.dispose();
	}
}

test("bash live and rebuilt previews prefer raw partial env values", () => {
	const reveal = new ToolArgsRevealController({
		getSmoothStreaming: () => false,
		requestRender: (_component: Component) => {},
	});
	const command = "x".repeat(250);
	const first = `{"command":"${command}","env":{"FOO":"o`;
	const second = `${first}ld"}}`;
	const firstArgs = reveal.setTarget("bash-1", first, {
		rawInput: false,
		exposeRawPartialJson: true,
	});
	const liveArgs = reveal.setTarget("bash-1", second, {
		rawInput: false,
		exposeRawPartialJson: true,
	});
	const rebuiltArgs = decodeStreamedToolArgs(second, {
		rawInput: false,
		fullArgs: liveArgs,
	});

	expect(firstArgs.env).toEqual({ FOO: "o" });
	expect(liveArgs.env).toEqual({ FOO: "old" });
	expect(rebuiltArgs.env).toEqual({ FOO: "old" });
	expect(renderedEnvLine(liveArgs)).toContain('FOO="old"');
	expect(renderedEnvLine({ ...liveArgs, env: { FOO: "o" } })).toContain('FOO="old"');
	expect(renderedEnvLine(rebuiltArgs)).toContain('FOO="old"');
});
