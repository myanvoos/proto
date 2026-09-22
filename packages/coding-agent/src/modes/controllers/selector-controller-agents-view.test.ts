import { expect, test } from "bun:test";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

/**
 * `/agents` and the double-tap right gesture ask for the current session's agents.
 * With `--no-session` there is no file to scope to; the view used to answer with a
 * bare error toast per keypress, which said neither why nor what to do instead.
 */
test("the current-session agents view falls back to the fleet when the session is in memory", async () => {
	initThemeSync();
	const errors: string[] = [];
	const statuses: string[] = [];
	let fleetOpened = 0;
	const ctx = {
		sessionManager: { getSessionFile: () => undefined },
		showError: (message: string) => {
			errors.push(message);
		},
		showStatus: (message: string) => {
			statuses.push(message);
		},
		showAgentFleet: () => {
			fleetOpened++;
		},
		ui: {
			showOverlay: () => {
				throw new Error("the agents view must not open without a session file");
			},
			requestRender: () => {},
		},
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	await controller.showAgentsView("current");
	await controller.showAgentsView("current");

	// Repeated presses reopen the fleet with its in-memory empty state, never an error.
	expect(fleetOpened).toBe(2);
	expect(errors).toEqual([]);
	expect(statuses).toEqual([]);
});
