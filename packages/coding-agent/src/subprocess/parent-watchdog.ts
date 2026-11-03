import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";

export const PARENT_WATCHDOG_WORKER_ARG = "__proto_worker_parent_watchdog";

/** Keep parent-death detection alive while an IPC worker blocks in native inference. */
export function startParentWatchdog(parentPid: number): void {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [PARENT_WATCHDOG_WORKER_ARG] })
		: new Worker(new URL("./parent-watchdog-worker.ts", import.meta.url).href, { type: "module" });
	worker.postMessage(parentPid);
	worker.unref();
}
