import { prompt } from "@oh-my-pi/pi-utils";
import type { MonitorEvent } from "../monitor/types";
import monitorEventTemplate from "../prompts/session/monitor-event.md" with { type: "text" };
import type { CustomMessage } from "./messages";

export const MONITOR_EVENT_MESSAGE_TYPE = "monitor-event";

export interface MonitorEventDetails {
	events: MonitorEvent[];
}

export function buildMonitorEventBatchMessage(entries: MonitorEvent[]): CustomMessage<MonitorEventDetails> | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: MONITOR_EVENT_MESSAGE_TYPE,
		content: prompt.render(monitorEventTemplate, {
			multiple: entries.length > 1,
			events: entries.map(event => ({
				monitorId: event.monitorId,
				label: event.label,
				kind: event.kind,
				text: event.text,
				terminal: event.kind !== "output",
			})),
		}),
		display: true,
		attribution: "agent",
		details: { events: entries },
		timestamp: Date.now(),
	};
}
