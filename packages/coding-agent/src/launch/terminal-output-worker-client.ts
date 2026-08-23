import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import type { TerminalOutputOptions } from "./terminal-output";
import {
	TERMINAL_OUTPUT_WORKER_ARG,
	type TerminalOutputWorkerRequest,
	type TerminalOutputWorkerResult,
} from "./terminal-output-worker-protocol";

/** Replay legacy broker PTY bytes without evaluating xterm in the client process. */
export async function renderTerminalOutputIsolated(
	output: string,
	options: TerminalOutputOptions,
): Promise<string[] | undefined> {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [TERMINAL_OUTPUT_WORKER_ARG] })
		: new Worker(new URL("./terminal-output-worker.ts", import.meta.url).href, { type: "module" });
	const pending = Promise.withResolvers<string[] | undefined>();
	const onMessage = (event: MessageEvent<TerminalOutputWorkerResult>): void => {
		if (event.data.ok) pending.resolve(event.data.rows);
		else pending.reject(new Error(event.data.error));
	};
	const onError = (event: ErrorEvent): void => {
		pending.reject(event.error instanceof Error ? event.error : new Error(event.message));
	};
	const onClose = (): void => {
		pending.reject(new Error("Terminal output worker exited before responding"));
	};
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("close", onClose);
	try {
		const request: TerminalOutputWorkerRequest = { output, options };
		worker.postMessage(request);
		return await pending.promise;
	} finally {
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("close", onClose);
		worker.terminate();
	}
}
