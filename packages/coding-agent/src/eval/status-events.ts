import type { EvalStatusEvent } from "./types";

// Agent events are snapshots; other status events retain their full history.
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const id = event.id;
		const idx = events.findIndex(e => e.op === "agent" && e.id === id);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
}
