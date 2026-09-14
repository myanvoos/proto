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

test("a shell suffix arriving after a kernel cell stays visible live and after rebuilding", () => {
	const reveal = new ToolArgsRevealController({
		getSmoothStreaming: () => false,
		requestRender: NOOP,
	});
	const kernelCommand = "python3 <<'PY'\nprint(1 + 2)\nPY";
	const command = `${kernelCommand}\nprintf 'shell suffix\\n'`;
	const target = { rawInput: false, exposeRawPartialJson: true };
	const firstArgs = reveal.setTarget("mixed-bash", JSON.stringify({ command: kernelCommand }).slice(0, -2), target);
	const live = new ToolExecutionComponent("bash", firstArgs, {}, undefined, UI);
	let rebuilt: ToolExecutionComponent | undefined;
	const rendered = (component: ToolExecutionComponent) => component.render(100).map(Bun.stripANSI).join("\n");
	try {
		expect(rendered(live)).toContain("print(1 + 2)");
		const partialJson = JSON.stringify({ command }).slice(0, -2);
		const liveArgs = reveal.setTarget("mixed-bash", partialJson, target);
		live.updateArgs(liveArgs);
		rebuilt = new ToolExecutionComponent(
			"bash",
			decodeStreamedToolArgs(partialJson, { rawInput: false, fullArgs: firstArgs }),
			{},
			undefined,
			UI,
		);
		for (const component of [live, rebuilt]) {
			expect(rendered(component)).toContain("printf 'shell suffix");
			component.setArgsComplete();
			component.setExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: "3\nshell suffix\n" }] }, true);
			expect(rendered(component)).toContain("printf 'shell suffix");
			component.updateResult({ content: [{ type: "text", text: "3\nshell suffix\n" }] }, false);
			expect(rendered(component)).toContain("printf 'shell suffix");
		}
	} finally {
		reveal.stop();
		live.dispose();
		rebuilt?.dispose();
	}
});

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
