import * as fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkerHandle } from "../../subprocess/worker-client";
import { KERNEL_INPUT_CHUNK_BYTES } from "../kernel-streams";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

interface InputRun {
	socket?: Socket;
	requested: boolean;
}

/** Feed real fd 0 from the supervising process, even while the interpreter blocks in read(2).
 * The existing one-chunk credit protocol keeps local and remote input bounded alike.
 */
export async function withNativeInput(
	worker: WorkerHandle<WorkerInbound, WorkerOutbound>,
): Promise<WorkerHandle<WorkerInbound, WorkerOutbound>> {
	let directory: string;
	try {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-js-input-"));
	} catch (error) {
		await worker.terminate();
		throw error;
	}
	const socketPath = path.join(directory, "stdin.sock");
	const runs = new Map<string, InputRun>();
	const sockets = new Set<Socket>();
	const listeners = new Set<(message: WorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	let stopping = false;
	const emit = (message: WorkerOutbound): void => {
		for (const listener of listeners) listener(message);
	};
	const report = (error: Error): void => {
		if (!stopping) for (const listener of errors) listener(error);
	};
	const request = (runId: string, run: InputRun): void => {
		if (stopping || run.requested || run.socket?.destroyed !== false) return;
		run.requested = true;
		emit({ type: "stdin-request", runId });
	};
	const server = createServer({ allowHalfOpen: true }, socket => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy()); // An early-exiting reader may close a pending write.
		socket.once("close", () => sockets.delete(socket));
		let header = "";
		const identify = (chunk: Buffer): void => {
			header += chunk.toString("utf8");
			if (header.length > 1025) return void socket.destroy();
			const end = header.indexOf("\n");
			if (end < 0) return;
			socket.off("data", identify);
			socket.pause();
			const runId = header.slice(0, end);
			const run = runs.get(runId);
			if (!run || run.socket || end !== header.length - 1) return void socket.destroy();
			run.socket = socket;
			request(runId, run);
		};
		socket.on("data", identify);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		await worker.terminate();
		throw error;
	}
	server.on("error", report);
	const unsubscribeError = worker.onError(report);
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.type === "result") {
			runs.get(message.runId)?.socket?.destroy();
			runs.delete(message.runId);
		}
		emit(message);
	});
	return {
		send(message) {
			if (message.type === "run") {
				if (message.snapshot.stdin) runs.set(message.runId, { requested: false });
				worker.send({
					...message,
					snapshot: { ...message.snapshot, stdinSocket: message.snapshot.stdin ? socketPath : undefined },
				});
			} else if (message.type === "stdin") {
				const run = runs.get(message.runId);
				if (run?.socket?.destroyed !== false) return;
				const bytes = Buffer.from(message.data, "base64");
				if (!run.requested || bytes.length > KERNEL_INPUT_CHUNK_BYTES || (!message.eof && !bytes.length)) {
					report(new Error("Invalid native kernel stdin credit"));
					return;
				}
				run.requested = false;
				if (message.eof) run.socket.end(bytes);
				else
					run.socket.write(bytes, error => {
						if (!error) request(message.runId, run);
					});
			} else worker.send(message);
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			stopping = true;
			for (const socket of sockets) socket.destroy();
			runs.clear();
			try {
				await worker.terminate();
			} finally {
				unsubscribeMessage();
				unsubscribeError();
				listeners.clear();
				errors.clear();
				sockets.clear();
				await new Promise<void>(resolve => server.close(() => resolve()));
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
	};
}
