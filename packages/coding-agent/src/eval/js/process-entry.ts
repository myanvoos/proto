import { postmortem, readLines } from "@oh-my-pi/pi-utils";
import { decodeJsKernelFrame, JsKernelFrameWriter, MAX_JS_KERNEL_WIRE_BYTES } from "./stdio-protocol";
import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

// Taken before the kernel routes `process.exit()` to the calling cell: the host's own exits end the process.
const exitHost = process.exit.bind(process);

export function startJsEvalProcess(
	transport: {
		send(message: WorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	new WorkerCore(
		{
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),

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

/** Same CLI worker host and runtime as IPC, with a bounded authenticated-by-pipe remote transport. */
export async function startJsEvalStdioProcess(interceptUnhandledRejections: RejectionInterceptor): Promise<void> {
	let receive: ((message: WorkerInbound) => void) | undefined;
	const writer = new JsKernelFrameWriter(Bun.stdout.writer(), () => exitHost(1));
	startJsEvalProcess(
		{
			send(message) {
				writer.send(message);
				if (message.type === "closed")
					void writer.flush().then(
						() => exitHost(0),
						() => exitHost(1),
					);
			},
			onMessage(handler) {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
		},
		interceptUnhandledRejections,
	);
	try {
		for await (const line of readLines(Bun.stdin.stream(), undefined, MAX_JS_KERNEL_WIRE_BYTES)) {
			const message = decodeJsKernelFrame(line) as WorkerInbound;
			receive?.(message);
		}
	} finally {
		// Loss of the transport must not orphan a remote interpreter or its subprocesses.
		if (process.env.PI_KERNEL_REMOTE === "1") {
			try {
				process.kill(-process.pid, "SIGKILL");
			} catch {}
		}
		receive?.({ type: "close" });
	}
}
