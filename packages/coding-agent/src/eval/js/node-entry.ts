/**
 * Node.js entry of the JavaScript kernel: `node` cells run the shared WorkerCore/JsRuntime here, in
 * the real Node the command named, while `bun` cells keep the Bun worker (process-entry.ts).
 *
 * Exception to the AGENTS.md worker rule (workers re-enter the CLI entrypoint): Node cannot load the
 * Bun CLI host. The build scripts bundle this module for Node and embed it (node-runtime.ts builds it
 * on demand from a source checkout); the host stages the bundle as a file and spawns it with JSON IPC
 * (node-protocol.ts).
 */
import { decodeNodeKernelMessage, encodeNodeKernelMessage } from "./node-protocol";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound } from "./worker-protocol";

const MIN_NODE_MAJOR = 22;

const major = Number(process.versions.node.split(".")[0]);
if (!(major >= MIN_NODE_MAJOR)) {
	process.stderr.write(
		`node kernel requires Node.js >= ${MIN_NODE_MAJOR}; ${process.execPath} is ${process.version}\n`,
	);
	process.exit(1);
}

// The kernel's own experimental Node features (vm modules, TS stripping) must not print warnings into
// user cell output; every other warning, including ones user code triggers, still reaches it.
const INTERNAL_EXPERIMENTAL_WARNING =
	/^(?:VM Modules|stripTypeScriptTypes|vm\.USE_MAIN_CONTEXT_DEFAULT_LOADER) is an experimental feature/;
const emitWarning = process.emitWarning;
process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
	if (INTERNAL_EXPERIMENTAL_WARNING.test(typeof warning === "string" ? warning : warning.message)) return;
	Reflect.apply(emitWarning, this, [warning, ...rest]);
} as typeof process.emitWarning;

const transport: Transport = {
	send(message) {
		// A lost host channel ends the kernel through the disconnect handler below.
		if (process.connected) process.send?.(encodeNodeKernelMessage(message));
	},
	onMessage(handler) {
		const receive = (raw: unknown): void => handler(decodeNodeKernelMessage(raw) as WorkerInbound);
		process.on("message", receive);
		return () => {
			process.off("message", receive);
		};
	},
	// The host terminates the process tree after the `closed` acknowledgement.
	close: () => {},
};

process.on("disconnect", () => process.exit(0));
new WorkerCore(transport, { mode: "isolated", chdir: cwd => process.chdir(cwd) });
