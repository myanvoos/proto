/**
 * Standalone JavaScript kernel entry for a selected Node or Bun executable.
 *
 * These workers cannot re-enter a compiled Bun CLI with its internal worker selector: Node cannot load
 * that host, and an external Bun requires an actual entry module. Build scripts embed this self-contained
 * module; source checkouts build it on demand. The host stages it and uses cross-runtime JSON IPC.
 */
import { decodeNodeKernelMessage, encodeNodeKernelMessage } from "./node-protocol";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound } from "./worker-protocol";

const MIN_NODE_MAJOR = 22;

const major = Number(process.versions.node.split(".")[0]);
if (typeof Bun === "undefined" && !(major >= MIN_NODE_MAJOR)) {
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
	if (
		typeof Bun === "undefined" &&
		INTERNAL_EXPERIMENTAL_WARNING.test(typeof warning === "string" ? warning : warning.message)
	)
		return;
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
	setReferenced: referenced => (referenced ? process.channel?.ref() : process.channel?.unref()),
	// The host terminates the process tree after the `closed` acknowledgement.
	close: () => {},
};

// Taken before the kernel routes `process.exit()` to the calling cell: losing the host must end this process.
const exitHost = process.exit.bind(process);
process.on("disconnect", () => exitHost(0));
new WorkerCore(transport, { mode: "isolated", chdir: cwd => process.chdir(cwd) });
