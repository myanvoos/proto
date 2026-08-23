/**
 * ACP-side `ClientBridge` implementation. Wraps `AgentSideConnection` so the
 * `read`/`write`/`bash`/`edit` tools can route through the client when it
 * advertises the relevant capabilities at `initialize` time.
 */
import type {
	TerminalHandle as AcpTerminalHandle,
	AgentSideConnection,
	ClientCapabilities,
} from "@oh-my-pi/pi-utils/acp";
import type {
	ClientBridge,
	ClientBridgeCapabilities,
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalHandle,
} from "../../session/client-bridge";

export function createAcpClientBridge(
	connection: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
): ClientBridge {
	const capabilities: ClientBridgeCapabilities = {
		readTextFile: clientCapabilities?.fs?.readTextFile === true,
		writeTextFile: clientCapabilities?.fs?.writeTextFile === true,
		terminal: clientCapabilities?.terminal === true,
	};

	const bridge: ClientBridge = { capabilities, deferAgentInitiatedTurns: true };

	if (capabilities.readTextFile) {
		bridge.readTextFile = async params => {
			const response = await connection.readTextFile({
				sessionId,
				path: params.path,
				...(typeof params.line === "number" ? { line: params.line } : {}),
				...(typeof params.limit === "number" ? { limit: params.limit } : {}),
			});
			return response.content;
		};
	}

	if (capabilities.writeTextFile) {
		bridge.writeTextFile = async params => {
			await connection.writeTextFile({
				sessionId,
				path: params.path,
				content: params.content,
			});
		};
	}

	if (capabilities.terminal) {
		bridge.createTerminal = (params: ClientBridgeCreateTerminalParams) =>
			createTerminalHandle(connection, sessionId, params);
	}

	return bridge;
}

async function createTerminalHandle(
	connection: AgentSideConnection,
	sessionId: string,
	params: ClientBridgeCreateTerminalParams,
): Promise<ClientBridgeTerminalHandle> {
	const handle = await connection.createTerminal({
		sessionId,
		command: params.command,
		...(params.args ? { args: params.args } : {}),
		...(params.env ? { env: params.env } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
		...(typeof params.outputByteLimit === "number" ? { outputByteLimit: params.outputByteLimit } : {}),
	});
	return wrapTerminalHandle(handle);
}

function wrapTerminalHandle(handle: AcpTerminalHandle): ClientBridgeTerminalHandle {
	return {
		terminalId: handle.id,
		async currentOutput() {
			const out = await handle.currentOutput();
			return {
				output: out.output,
				truncated: out.truncated,
				exitStatus: out.exitStatus ?? null,
			};
		},
		async waitForExit() {
			const status = await handle.waitForExit();
			return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
		},
		async kill() {
			await handle.kill();
		},
		async release() {
			await handle.release();
		},
	};
}
