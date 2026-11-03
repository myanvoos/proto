import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { CommandController } from "./command-controller";
import { InputController } from "./input-controller";

await Settings.init({ inMemory: true });
initThemeSync();

test("focused jobs display comes from the viewed agent rather than the main session", async () => {
	const output: Component[] = [];
	const ctx = {
		session: {
			getAsyncJobSnapshot: () => {
				throw new Error("main job ownership leaked");
			},
		},
		viewSession: {
			getAsyncJobSnapshot: () => ({
				running: [],
				recent: [
					{ id: "agent-job", state: "completed", label: "worker-owned command", startedAt: 1, finishedAt: 2 },
				],
			}),
		},
		ui: { terminal: { columns: 100 } },
		presentCommandOutput: (components: Component[]) => output.push(...components),
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand();
	const text = Bun.stripANSI(output.flatMap(component => component.render(100)).join("\n"));
	expect(text).toContain("agent-job");
	expect(text).toContain("worker-owned command");
});

test("focused jobs is available without returning to main but mutation verbs remain gated", async () => {
	let draft = "/jobs";
	let views = 0;
	const statuses: string[] = [];
	const ctx = {
		focusedAgentId: "worker",
		editor: {
			getExpandedText: () => draft,
			pendingImages: [],
			pendingImageLinks: [],
			clearDraft: () => {
				draft = "";
			},
		},
		viewSession: {},
		handleJobsCommand: async () => {
			views++;
		},
		showStatus: (status: string) => statuses.push(status),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	await controller.handleFollowUp();
	expect(views).toBe(1);
	expect(draft).toBe("");
	draft = "/jobs kill owned-by-main";
	await controller.handleFollowUp();
	expect(views).toBe(1);
	expect(draft).toBe("/jobs kill owned-by-main");
	expect(statuses[0]).toContain("main session");
});
