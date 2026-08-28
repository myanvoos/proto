export interface ClientBridgeCapabilities {
	readTextFile?: boolean;

	writeTextFile?: boolean;

	terminal?: boolean;
}

export interface ClientBridgeTerminalExitStatus {
	exitCode?: number | null;
	signal?: string | null;
}

export interface ClientBridgeTerminalOutput {
	output: string;
	truncated: boolean;
	exitStatus?: ClientBridgeTerminalExitStatus | null;
}

export interface ClientBridgeTerminalHandle {
	terminalId: string;
	waitForExit(): Promise<ClientBridgeTerminalExitStatus>;
	currentOutput(): Promise<ClientBridgeTerminalOutput>;
	kill(): Promise<void>;
	release(): Promise<void>;
}

export interface ClientBridgeCreateTerminalParams {
	command: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	cwd?: string;
	outputByteLimit?: number;
}

export interface ClientBridge {
	readonly capabilities: ClientBridgeCapabilities;

	readonly deferAgentInitiatedTurns?: boolean;
	readTextFile?(params: { path: string; line?: number; limit?: number }): Promise<string>;
	writeTextFile?(params: { path: string; content: string }): Promise<void>;
	createTerminal?(params: ClientBridgeCreateTerminalParams): Promise<ClientBridgeTerminalHandle>;
}
