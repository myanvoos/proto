import type { ServerSentEvent } from "@oh-my-pi/pi-utils";
import type { RawSseEvent } from "../types";

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		observer(event as RawSseEvent);
	} catch {}
}
