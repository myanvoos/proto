import { expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import type { ChecklistPhase } from "../tools/checklist";
import { ChecklistTracker, type ChecklistTrackerHost } from "./checklist-tracker";

const settings = await Settings.init();

interface TrackerFixture {
	tracker: ChecklistTracker;
	appended: Message[];
	continues: number;
}

function createTracker(options: { hasActiveMonitors: boolean }): TrackerFixture {
	const appended: Message[] = [];
	const fixture = { appended, continues: 0 } as TrackerFixture;
	const host: ChecklistTrackerHost = {
		agent: {
			state: { messages: [] as Message[] },
			appendMessage: (message: Message) => {
				appended.push(message);
			},
		} as unknown as ChecklistTrackerHost["agent"],
		sessionManager: {
			getBranch: () => [],
			appendMessage: () => {},
		} as unknown as ChecklistTrackerHost["sessionManager"],
		settings,
		model: () => undefined,
		agentKind: () => "main",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {
			fixture.continues++;
		},
		promptGeneration: () => 1,
		hasPendingAsyncWake: () => false,
		hasActiveMonitors: () => options.hasActiveMonitors,
		getActiveToolNames: () => ["checklist"],
		getEnabledToolNames: () => ["checklist"],
		toolRegistry: () => new Map<string, AgentTool>(),
	};
	const tracker = new ChecklistTracker(host);
	const phases: ChecklistPhase[] = [
		{ name: "Ship it", tasks: [{ content: "wait for the deploy to finish", status: "in_progress" }] },
	];
	tracker.setPhases(phases);
	fixture.tracker = tracker;
	return fixture;
}

const finishedTurn: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Deploy kicked off; monitoring the rollout log." }],
} as unknown as AssistantMessage;

test("incomplete checklist items still nudge the agent to keep going when no monitor is running", async () => {
	const fixture = createTracker({ hasActiveMonitors: false });

	expect(await fixture.tracker.checkCompletion(finishedTurn)).toBe(true);
	expect(fixture.continues).toBe(1);
	expect(fixture.appended).toHaveLength(1);
	const reminder = fixture.appended[0];
	expect(reminder?.role).toBe("developer");
	expect(JSON.stringify(reminder?.content)).toContain("wait for the deploy to finish");
});

test("an active monitor suppresses the incomplete-checklist reminder without consuming an attempt", async () => {
	const fixture = createTracker({ hasActiveMonitors: true });

	expect(await fixture.tracker.checkCompletion(finishedTurn)).toBe(false);
	expect(fixture.continues).toBe(0);
	expect(fixture.appended).toHaveLength(0);

	// Suppression must not burn a reminder attempt: once the monitor stops, the reminder
	// still has its full budget and fires on the very next turn end.
	const resumed = createTracker({ hasActiveMonitors: false });
	expect(await resumed.tracker.checkCompletion(finishedTurn)).toBe(true);
	expect(resumed.continues).toBe(1);
});

test("mid-run nudge counts file writes, not read-only bash results", () => {
	const reads = createTracker({ hasActiveMonitors: false });
	for (let index = 0; index < 12; index++) {
		reads.tracker.onToolResult("bash", false, { statusEvents: [] });
	}
	expect(reads.tracker.takeMidRunNudge()).toBeNull();

	const writes = createTracker({ hasActiveMonitors: false });
	for (let index = 0; index < 12; index++) {
		writes.tracker.onToolResult("bash", false, { mutatedPaths: [`/tmp/file-${index}`] });
	}
	expect(writes.tracker.takeMidRunNudge()).not.toBeNull();
});
