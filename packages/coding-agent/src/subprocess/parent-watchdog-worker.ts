import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";

if (!parentPort) throw new Error("parent-watchdog-worker: missing parentPort");

const handle = (message: unknown): void => {
	if (typeof message !== "number" || !Number.isSafeInteger(message) || message <= 0) return;
	const parentPid = message;
	const check = (): void => {
		let alive = process.ppid === parentPid;
		if (alive) {
			try {
				process.kill(parentPid, 0);
			} catch (error) {
				alive = error instanceof Error && "code" in error && error.code === "EPERM";
			}
		}
		if (!alive) process.kill(process.pid, "SIGKILL");
	};
	check();
	setInterval(check, 250);
};

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else parentPort.on("message", handle);
