import * as path from "node:path";

export const LSP_MUX_WORKER_ARG = "__proto_worker_lsp_mux";

export const LSP_MUX_SOCKET_ENV = "PROTO_LSP_MUX_SOCKET";

export const LSP_MUX_PROJECT_DIR_ENV = "PROTO_LSP_MUX_PROJECT_DIR";

export const LSP_MUX_DAEMON_NAME = "proto.lsp.mux";

export const LSP_MUX_READY_PATTERN = String.raw`proto lsp mux listening on \S+`;

export function lspMuxReadyBanner(endpoint: string): string {
	return `proto lsp mux listening on ${endpoint}`;
}

export function lspMuxEndpoint(_projectDir: string, runtimeDir: string): string {
	return path.join(runtimeDir, "lsp-mux.sock");
}

export const MUX_CONNECT_METHOD = "proto/muxConnect";

export const MUX_PING_METHOD = "proto/muxPing";
export const MUX_PING_RESULT = "pong";

export const MUX_RESTART_METHOD = "proto/muxRestartServer";

export interface MuxConnectParams {
	command: string;

	args: string[];

	cwd: string;

	env?: Record<string, string>;
}

export interface MuxConnectResult {
	key: string;

	spawned: boolean;

	pid?: number;
}

export function muxServerKey(params: MuxConnectParams): string {
	const envEntries = Object.entries(params.env ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const identity = JSON.stringify([params.command, params.args, params.cwd, envEntries]);
	return `sha256:${Bun.SHA256.hash(identity, "hex")}`;
}
