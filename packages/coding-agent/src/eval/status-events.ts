import type { EvalStatusEvent } from "./types";

function isFileOp(event: EvalStatusEvent): boolean {
	return event.op === "write" || event.op === "delete";
}

// Agent events and file-op reports are snapshots keyed by `id`: an agent's
// progress replaces its earlier progress, and a kernel's report of a path
// (net diff from the pre-cell content, reported when the handle closes and
// again by the cell-end flush if it changed further) replaces the earlier
// report of that path — a cell that writes a file twice exposes one
// mutation. Every other status event retains its full history.
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (typeof event.id === "string" && (event.op === "agent" || isFileOp(event))) {
		const id = event.id;
		const idx =
			event.op === "agent"
				? events.findIndex(e => e.op === "agent" && e.id === id)
				: events.findIndex(e => isFileOp(e) && e.id === id);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
}
