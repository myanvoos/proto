import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { SessionManager } from "../../session/session-manager";
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
			sessionManager: SessionManager.inMemory(),
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

test("focused jobs cancellation only reaches jobs owned by the selected node", async () => {
	let draft = "/jobs";
	let views = 0;
	const cancelled: string[] = [];
	const statuses: string[] = [];
	const manager = SessionManager.inMemory();
	const ctx = {
		focusedAgentId: "worker",
		editor: {
			getExpandedText: () => draft,
			setText: (text: string) => {
				draft = text;
			},
			pendingImages: [],
			pendingImageLinks: [],
			clearDraft: () => {
				draft = "";
			},
		},
		viewSession: {
			sessionManager: manager,
			getAsyncJobSnapshot: () => ({ running: [{ id: "child-job" }], recent: [] }),
			cancelAsyncJob: (id: string) => {
				cancelled.push(id);
				return true;
			},
		},
		session: {
			cancelAsyncJob: () => {
				throw new Error("root cancellation leaked");
			},
		},
		handleJobsCommand: async () => {
			views++;
		},
		showStatus: (status: string) => statuses.push(status),
		showError: (message: string) => {
			throw new Error(message);
		},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	await controller.handleFollowUp();
	expect(views).toBe(1);
	expect(draft).toBe("");
	draft = "/jobs kill owned-by-main";
	await controller.handleFollowUp();
	expect(cancelled).toEqual([]);
	draft = "/jobs kill child-job";
	await controller.handleFollowUp();
	expect(cancelled).toEqual(["child-job"]);
	expect(statuses[0]).toContain("No running background job");
});
