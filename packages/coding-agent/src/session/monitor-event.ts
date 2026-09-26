import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJobEvent } from "../async/job-manager";
import monitorEventTemplate from "../prompts/session/monitor-event.md" with { type: "text" };
import type { CustomMessage } from "./messages";

export const MONITOR_EVENT_MESSAGE_TYPE = "monitor-event";

/** Stored transcript contract; runtime async jobs use jobId instead. */
export interface PersistedMonitorEvent extends Omit<AsyncJobEvent, "jobId"> {
	monitorId: string;
}

export interface MonitorEventDetails {
	events: PersistedMonitorEvent[];
}

export function buildMonitorEventBatchMessage(entries: AsyncJobEvent[]): CustomMessage<MonitorEventDetails> | null {
	if (entries.length === 0) return null;
	const events: PersistedMonitorEvent[] = entries.map(({ jobId, ...event }) => ({
		...event,
		monitorId: jobId,
	}));
	return {
		role: "custom",
		customType: MONITOR_EVENT_MESSAGE_TYPE,
		content: prompt.render(monitorEventTemplate, {
			multiple: events.length > 1,
			events: events.map(event => ({
				monitorId: event.monitorId,
				label: event.label,
				kind: event.kind,
				text: event.text,
				terminal: event.kind !== "output",
			})),
		}),
		display: true,
		attribution: "agent",
		details: { events },
		timestamp: Date.now(),
	};
}
