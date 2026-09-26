import { readLines } from "@oh-my-pi/pi-utils";
import type { WorkerHandle } from "../../subprocess/worker-client";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

const ACK_PREFIX = "native-stdio:";

/** The native pump and IPC use independent pipes. Sequence fences join them without timing guesses. */
export function withNativeOutput(
	worker: WorkerHandle<WorkerInbound, WorkerOutbound>,
	stdout: ReadableStream<Uint8Array>,
): WorkerHandle<WorkerInbound, WorkerOutbound> {
	const listeners = new Set<(message: WorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const acknowledgements = new Map<string, () => void>();
	const waiting: Extract<WorkerOutbound, { type: "result" }>[] = [];
	let consumed = 0;
	let stopping = false;
	let failure: Error | undefined;
	const report = (error: unknown): void => {
		if (stopping || failure) return;
		failure = error instanceof Error ? error : new Error(String(error));
		for (const handler of errors) handler(failure);
	};
	worker.onError(report);
	worker.onMessage(message => {
		if (message.type === "result" && message.nativeSequence !== undefined) {
			if (!Number.isSafeInteger(message.nativeSequence) || message.nativeSequence < 0) {
				report(new Error("Invalid native JS output fence"));
				return;
			}
			if (message.nativeSequence > consumed) {
				waiting.push(message);
				return;
			}
		}
		for (const handler of listeners) handler(message);
	});
	const drained = (async () => {
		try {
			for await (const line of readLines(stdout, undefined, 1024 * 1024)) {
				if (stopping) break;
				const frame = JSON.parse(new TextDecoder().decode(line)) as Record<string, unknown>;
				if (
					frame.type !== "native-stdio" ||
					typeof frame.runId !== "string" ||
					(frame.stream !== "stdout" && frame.stream !== "stderr") ||
					typeof frame.data !== "string" ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(frame.data) ||
					typeof frame.sequence !== "number" ||
					!Number.isSafeInteger(frame.sequence) ||
					frame.sequence !== consumed + 1
				)
					throw new Error("Invalid native JS output frame");
				const id = `${ACK_PREFIX}${frame.sequence}`;
				const acknowledged = Promise.withResolvers<void>();
				acknowledgements.set(id, acknowledged.resolve);
				const message: WorkerOutbound = {
					type: "bytes",
					runId: frame.runId,
					id,
					data: frame.data,
					stream: frame.stream,
				};
				for (const handler of listeners) handler(message);
				await acknowledged.promise;
				if (stopping) break;
				acknowledgements.delete(id);
				consumed = frame.sequence;
				while (waiting[0] && waiting[0].nativeSequence! <= consumed) {
					const result = waiting.shift()!;
					for (const handler of listeners) handler(result);
				}
			}
			if (!stopping && waiting.length) throw new Error("Native JS output ended before its completion fence");
		} catch (error) {
			report(error);
		}
	})();
	return {
		send(message) {
			if (message.type === "output-ack" && message.id.startsWith(ACK_PREFIX)) {
				acknowledgements.get(message.id)?.();
				return;
			}
			worker.send(message);
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			if (failure) queueMicrotask(() => handler(failure!));
			return () => errors.delete(handler);
		},
		async terminate() {
			stopping = true;
			for (const resolve of acknowledgements.values()) resolve();
			await worker.terminate();
			await drained;
		},
	};
}
