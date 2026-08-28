import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "./worker-protocol";

if (!parentPort) throw new Error("js worker-entry: missing parentPort");

const port = parentPort;

const inbox = consumeWorkerInbox();
const transport: Transport = {
	send: (msg: WorkerOutbound) => port.postMessage(msg),
	onMessage: handler => {
		if (inbox) return inbox.bind(data => handler(data as WorkerInbound));
		const wrap = (data: unknown): void => handler(data as WorkerInbound);
		port.on("message", wrap);
		return () => port.off("message", wrap);
	},
	close: () => {
		try {
			port.close();
		} catch {}

		setTimeout(() => process.exit(0), 0);
	},
};

new WorkerCore(transport, { mode: "isolated" });
