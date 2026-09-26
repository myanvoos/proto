import { expect, test } from "bun:test";
import type { AsyncJobEvent } from "../../async/job-manager";
import { Settings } from "../../config/settings";
import type { CustomMessage } from "../../session/messages";
import {
	buildMonitorEventBatchMessage,
	MONITOR_EVENT_MESSAGE_TYPE,
	type MonitorEventDetails,
	type PersistedMonitorEvent,
} from "../../session/monitor-event";
import { initTheme } from "../theme/theme";
import { buildAsyncResultBlock, buildMonitorEventBlock } from "./transcript-render-helpers";

await Settings.init();
await initTheme(false, false, "proto");

const ANSI = /\x1b\[[0-9;]*m/g;

function monitorMessage(events: PersistedMonitorEvent[]): CustomMessage<MonitorEventDetails> {
	return {
		role: "custom",
		customType: MONITOR_EVENT_MESSAGE_TYPE,
		content: "monitor fired",
		display: true,
		attribution: "agent",
		details: { events },
		timestamp: 0,
	};
}

test("stored monitor event identities render with sanitized, truncated output", () => {
	const longTail = "x".repeat(400);
	const block = buildMonitorEventBlock(
		monitorMessage([
			{
				monitorId: "mon1",
				label: "build",
				kind: "output",
				text: `col\tumn ${longTail}`,
				sequence: 1,
				timestamp: 0,
			},
			{
				monitorId: "mon2",
				label: "deploy",
				kind: "error",
				text: "spawn failed",
				sequence: 1,
				timestamp: 0,
			},
		]),
	);
	const rendered = block.render(200).join("\n").replace(ANSI, "");

	expect(rendered).toContain("mon1");
	expect(rendered).toContain("mon2");
	expect(rendered).toContain("Monitor error");
	expect(rendered).toContain("spawn failed");
	expect(rendered).not.toContain("\t");
	expect(rendered).toContain("col   umn");
	expect(rendered).not.toContain(longTail);
	expect(rendered).toContain("…");
});

test("new monitor events retain the stored identity contract and render their job identity", () => {
	const event: AsyncJobEvent = {
		jobId: "bg_monitor_17",
		label: "deployment",
		sequence: 3,
		kind: "exit",
		text: "Deployment watcher exited with code 0",
		timestamp: 1_700_000_000_000,
	};
	const message = buildMonitorEventBatchMessage([event]);
	expect(message).not.toBeNull();
	expect(message!.details?.events).toEqual([
		{
			monitorId: "bg_monitor_17",
			label: "deployment",
			sequence: 3,
			kind: "exit",
			text: "Deployment watcher exited with code 0",
			timestamp: 1_700_000_000_000,
		},
	]);
	expect(message!.content).toContain("bg_monitor_17");
	const rendered = buildMonitorEventBlock(message!).render(200).join("\n").replace(ANSI, "");
	expect(rendered).toContain("bg_monitor_17");
	expect(rendered).toContain("Monitor exited");
	expect(rendered).toContain("Deployment watcher exited with code 0");
});

function asyncResultMessage(jobs: Array<{ jobId: string; status?: string }>): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "async-result",
		content: "job finished",
		display: true,
		attribution: "agent",
		details: { jobs: jobs.map(job => ({ ...job, type: "bash", durationMs: 1_100 })) },
		timestamp: 0,
	} as CustomMessage<unknown>;
}

test("async result block distinguishes failed jobs from completed ones", () => {
	const rendered = buildAsyncResultBlock(asyncResultMessage([{ jobId: "bg_1", status: "failed" }]))
		.render(120)
		.join("\n")
		.replace(ANSI, "");
	expect(rendered).toContain("Background job failed");
	expect(rendered).toContain("bg_1");
	expect(rendered).not.toContain("Background job completed");

	const success = buildAsyncResultBlock(asyncResultMessage([{ jobId: "bg_2", status: "completed" }]))
		.render(120)
		.join("\n")
		.replace(ANSI, "");
	expect(success).toContain("Background job completed");
	expect(success).not.toContain("Background job failed");
});
