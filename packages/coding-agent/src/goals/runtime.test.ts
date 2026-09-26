import { expect, test } from "bun:test";
import { GoalRuntime } from "./runtime";
import type { GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "./state";

const zeroUsage = (): GoalTokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

test("goal completion commits directly with no verification pend", async () => {
	const events: GoalRuntimeEvent[] = [];
	let state: GoalModeState | undefined;
	const rt = new GoalRuntime({
		getState: () => state,
		setState: s => {
			state = s;
		},
		getCurrentUsage: zeroUsage,
		emit: e => {
			events.push(e);
		},
		persist: () => {},
		sendHiddenMessage: async () => {},
	});
	state = await rt.createGoal({ objective: "## Objective\nsmoke", tokenBudget: 1000 });
	const done = await rt.completeGoalFromTool();
	expect(done.status).toBe("complete");
	// A completed goal cannot be revived — resume is only a pause-release.
	expect(rt.resumeGoal()).rejects.toThrow("Goal is already complete.");
	// Pause -> resume round-trip still lands back on "active".
	state = await rt.createGoal({ objective: "## Objective\nsmoke 2", tokenBudget: 1000 });
	await rt.pauseGoal();
	const resumed = await rt.resumeGoal();
	expect(resumed.goal.status).toBe("active");
	expect(events.some(e => e.type === "goal_updated")).toBe(true);
});

test("an interrupt pause arms one resume reminder per pause transition", async () => {
	let state: GoalModeState | undefined;
	const rt = new GoalRuntime({
		getState: () => state,
		setState: s => {
			state = s;
		},
		getCurrentUsage: zeroUsage,
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
	});
	await rt.createGoal({ objective: "## Objective\nsmoke" });

	await rt.onTaskAborted({ reason: "interrupted" });
	expect(state?.goal.status).toBe("paused");
	const reminder = rt.takeInterruptPausePrompt();
	expect(reminder).toContain("smoke");
	expect(reminder).toContain('goal({op:"resume"})');
	expect(rt.takeInterruptPausePrompt()).toBeUndefined();

	// Resumed before the next user turn, later paused on purpose: no interrupt pause left to announce.
	await rt.resumeGoal();
	await rt.onTaskAborted({ reason: "interrupted" });
	await rt.resumeGoal();
	await rt.pauseGoal();
	expect(rt.takeInterruptPausePrompt()).toBeUndefined();

	// Every new interrupt pause re-arms it.
	await rt.resumeGoal();
	await rt.onTaskAborted({ reason: "interrupted" });
	expect(rt.takeInterruptPausePrompt()).toBe(reminder);
});
