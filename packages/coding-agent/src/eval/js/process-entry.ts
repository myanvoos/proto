import { postmortem, readLines } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { safeSend } from "../../utils/ipc";
import { withNativeInput } from "./native-input";
import { withNativeOutput } from "./native-output";
import { decodeJsKernelFrame, JsKernelFrameWriter, MAX_JS_KERNEL_WIRE_BYTES } from "./stdio-protocol";
import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

// Taken before the kernel routes `process.exit()` to the calling cell: the host's own exits end the process.
const exitHost = process.exit.bind(process);

export function startJsEvalProcess(
	transport: {
		send(message: WorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
		setReferenced?(referenced: boolean): void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	new WorkerCore(
		{
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),
			setReferenced:
				transport.setReferenced ?? (referenced => (referenced ? process.channel?.ref() : process.channel?.unref())),

			close: () => {},
		},
		{
			mode: "isolated",

			chdir: cwd => process.chdir(cwd),
			interceptUnhandledRejections,
			markNonFatal: postmortem.markExpectedCleanupError,
		},
	);
}

/** The remote control stdout stays separate from the child interpreter's native output pipes. */
export async function startJsEvalStdioProcess(): Promise<void> {
	const spawned = createWorkerSubprocess<WorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd("__proto_worker_js_eval_process"),
		env: workerEnvFromParent({ PI_JS_NATIVE_STDIO: "1" }),
		exitLabel: "Remote JS eval worker",
		captureNativeStdio: true,
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<WorkerInbound, WorkerOutbound>(spawned, message =>
		safeSend(spawned.proc, message, "remote-js-eval"),
	);
	const worker = await withNativeInput(withNativeOutput(base, spawned.proc.stdout!));
	const writer = new JsKernelFrameWriter(Bun.stdout.writer(), () => exitHost(1));
	let closing = false;
	worker.onMessage(message => {
		writer.send(message);
		if (message.type === "closed") {
			closing = true;
			void writer.flush().then(
				async () => {
					await worker.terminate();
					exitHost(0);
				},
				() => exitHost(1),
			);
		}
	});
	worker.onError(error => {
		if (closing) return;
		closing = true;
		process.stderr.write(`${error.message}\n`);
		void worker.terminate().finally(() => exitHost(1));
	});
	try {
		for await (const line of readLines(Bun.stdin.stream(), undefined, MAX_JS_KERNEL_WIRE_BYTES))
			worker.send(decodeJsKernelFrame(line) as WorkerInbound);
	} finally {
		closing = true;
		await worker.terminate();
		// A disconnected remote supervisor must not orphan any descendants outside the worker's snapshot.
		if (process.env.PI_KERNEL_REMOTE === "1") {
			try {
				process.kill(-process.pid, "SIGKILL");
			} catch {}
		}
	}
}
