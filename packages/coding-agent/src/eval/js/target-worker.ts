import { readLines, withTimeout } from "@oh-my-pi/pi-utils";
import { type KernelTarget, kernelTargetCwd, kernelTargetLabel, spawnKernelTarget } from "../kernel-target";
import { decodeJsKernelFrame, JsKernelFrameWriter, MAX_JS_KERNEL_WIRE_BYTES } from "./stdio-protocol";
import type { SessionSnapshot, WorkerInbound, WorkerOutbound } from "./worker-protocol";

export interface TargetJsWorker {
	mode: "target";
	send(message: WorkerInbound): void;
	onMessage(handler: (message: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

export async function spawnTargetJsWorker(
	target: Exclude<KernelTarget, { kind: "local" }>,
	snapshot: SessionSnapshot,
): Promise<TargetJsWorker> {
	const command = [...(target.hostCommand ?? ["proto"])];
	const interpreter = snapshot.interpreter ?? target.interpreter;
	if (interpreter) {
		if (!target.hostCommand)
			throw new Error(
				'Remote JavaScript interpreter requires hostCommand naming its installed compatible proto CLI entry (for example ["bun","/opt/proto/cli.js"])',
			);
		command[0] = interpreter;
	}
	const spawned = await spawnKernelTarget(target, [...command, "__proto_worker_js_eval_process", "--stdio"], {
		cwd: kernelTargetCwd(target, snapshot.cwd),
		discoveryCwd: snapshot.discoveryCwd ?? snapshot.cwd,
		env: { PI_KERNEL_REMOTE: "1" },
	});
	const messages = new Set<(message: WorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	let failure: Error | undefined;
	let stopping = false;
	let closed = false;
	const closedAck = Promise.withResolvers<void>();
	let stderr = "";
	const report = (error: Error): void => {
		failure ??= error;
		for (const handler of errors) handler(error);
	};
	const writer = new JsKernelFrameWriter(spawned.proc.stdin, report);
	const drained = (async () => {
		const decoder = new TextDecoder();
		for await (const bytes of spawned.proc.stderr)
			stderr = (stderr + decoder.decode(bytes, { stream: true })).slice(-16 * 1024);
	})();
	void (async () => {
		try {
			for await (const line of readLines(spawned.proc.stdout, undefined, MAX_JS_KERNEL_WIRE_BYTES)) {
				const message = decodeJsKernelFrame(line) as WorkerOutbound;
				if (message.type === "closed") {
					closed = true;
					closedAck.resolve();
				}
				for (const handler of messages) handler(message);
			}
		} catch (error) {
			report(error instanceof Error ? error : new Error(String(error)));
			void spawned.terminate();
		}
	})();
	void spawned.proc.exited.then(async code => {
		await drained;
		if (!stopping)
			report(
				new Error(
					`JS kernel target ${kernelTargetLabel(target)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}. Remote JavaScript requires an installed compatible proto hostCommand; no local fallback is used.`,
				),
			);
	});
	return {
		mode: "target",
		send(message) {
			if (failure) throw failure;
			writer.send(message);
		},
		onMessage(handler) {
			messages.add(handler);
			return () => messages.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			if (failure) queueMicrotask(() => handler(failure!));
			return () => errors.delete(handler);
		},
		async close() {
			stopping = true;
			if (!closed && spawned.proc.exitCode === null) {
				try {
					writer.send({ type: "close" });
					await writer.flush();
				} catch {}
				await withTimeout(
					Promise.race([closedAck.promise, spawned.proc.exited]),
					1_000,
					"Target close acknowledgement timed out",
				).catch(() => undefined);
			}
			return await spawned.terminate();
		},
		async terminate() {
			stopping = true;
			if (!(await spawned.terminate()))
				throw new Error(`Kernel target ${kernelTargetLabel(target)} shutdown not confirmed`);
		},
	};
}
