import { expect, test } from "bun:test";
import * as os from "node:os";
import type { Component } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { CommandController } from "./command-controller";

test("/jobs renders home-prefixed paths compactly and never emits raw tabs", async () => {
	initThemeSync();
	let output: Component[] = [];
	const controller = new CommandController({
		viewSession: {
			getAsyncJobSnapshot: () => ({
				running: [
					{
						id: "job-live",
						type: "bash",
						status: "running",
						startTime: Date.now(),
						label: `Build\t${os.homedir()}/project/live`,
					},
				],
				recent: [
					{
						id: "job-done",
						type: "worker",
						status: "completed",
						startTime: Date.now(),
						label: `Review ${os.homedir()}/project/done`,
					},
				],
			}),
		},
		ui: { terminal: { columns: 120 } },
		presentCommandOutput: (components: Component[]) => {
			output = components;
		},
	} as unknown as InteractiveModeContext);
	await controller.handleJobsCommand();
	const rendered = Bun.stripANSI(output.flatMap(component => component.render(120)).join("\n"));
	expect(rendered).toContain("~/project/live");
	expect(rendered).toContain("~/project/done");
	expect(rendered).not.toContain(os.homedir());
	expect(rendered).not.toContain("\t");
});
