import type { EvalStatusEvent } from "./types";

function isFileOp(event: EvalStatusEvent): boolean {
	return event.op === "write" || event.op === "delete" || event.op === "revert";
}

// Agent events and file-op reports are snapshots keyed by `id`: an agent's
// progress replaces its earlier progress, and a kernel's report of a path
// (net diff from the pre-cell content, reported when the handle closes and
// again by the cell-end flush if it changed further) replaces the earlier
// report of that path — a cell that writes a file twice exposes one
// mutation. Every other status event retains its full history.
export function statusEventKey(event: EvalStatusEvent): string | undefined {
	if (typeof event.id !== "string") return undefined;
	if (event.op === "agent") return `agent:${event.id}`;
	if (isFileOp(event)) return `file:${event.id}`;
	return undefined;
}

export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	const key = statusEventKey(event);
	if (key !== undefined) {
		const idx = events.findIndex(previous => statusEventKey(previous) === key);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
}
