import { expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import type { MonitorEvent } from "../../monitor/types";
import type { CustomMessage } from "../../session/messages";
import { MONITOR_EVENT_MESSAGE_TYPE, type MonitorEventDetails } from "../../session/monitor-event";
import { initTheme } from "../theme/theme";
import { buildMonitorEventBlock } from "./transcript-render-helpers";

await Settings.init();
await initTheme(false, false, "proto");

const ANSI = /\x1b\[[0-9;]*m/g;

function monitorMessage(events: MonitorEvent[]): CustomMessage<MonitorEventDetails> {
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

test("monitor event block renders sanitized, truncated output", () => {
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
