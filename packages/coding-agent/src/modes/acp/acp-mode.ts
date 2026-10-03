import * as stream from "node:stream";
import { inspect } from "node:util";
import { postmortem } from "@oh-my-pi/pi-utils";
import { AgentSideConnection, ndJsonStream, type Stream } from "@oh-my-pi/pi-utils/acp";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export interface AcpSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

export type AcpSessionFactory = (
	cwd: string,
	options?: { interactivePrompts?: boolean },
) => Promise<AgentSession | AcpSessionHandle>;

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
	onAgent?: (agent: AcpAgent) => void,
): AgentSideConnection {
	return new AgentSideConnection(connection => {
		const agent = new AcpAgent(connection, createSession, initialSession);
		onAgent?.(agent);
		return agent;
	}, transport);
}

// fd 1 is the JSON-RPC transport: one stray byte from an extension, dependency, console.log or terminal escape
// desyncs the client's frame parser. Keep the real stdout for the transport and detour every other writer to stderr.
function isolateProtocolStdout(): NodeJS.WriteStream {
	const protocolStdout = process.stdout;
	const stderrSink = new stream.Writable({
		write(chunk, _encoding, callback) {
			process.stderr.write(chunk, callback);
		},
	});
	Object.defineProperty(process, "stdout", { value: stderrSink, configurable: true, writable: true });
	// Bun's console writes fd 1 directly, bypassing process.stdout.
	const toStderr = (...args: unknown[]): void => {
		process.stderr.write(`${formatConsoleArgs(args)}\n`);
	};
	console.log = toStderr;
	console.info = toStderr;
	console.debug = toStderr;
	return protocolStdout;
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
			return inspect(arg, { depth: 2, breakLength: 120 });
		})
		.join(" ");
}

export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<void> {
	if (process.stdin.isTTY) {
		process.stderr.write(
			"proto acp: ACP server speaking JSON-RPC over stdio.\n" +
				'This command is meant to be spawned by an ACP client (e.g. Zed\'s "agent_servers" config), not run directly.\n' +
				"Waiting for protocol frames on stdin; logs: ~/.proto/logs/\n",
		);
	}
	let agent: AcpAgent | undefined;
	postmortem.register("acp-session-teardown", reason => agent?.dispose(reason));
	postmortem.registerStdioDisconnectHandling();
	const input = stream.Writable.toWeb(isolateProtocolStdout());
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession, createdAgent => {
		agent = createdAgent;
	});
	await connection.closed;
	await postmortem.quit(0);
}
