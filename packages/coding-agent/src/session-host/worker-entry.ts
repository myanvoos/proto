import { logger } from "@oh-my-pi/pi-utils";

import { runCli } from "../cli";
import { SESSION_HOST_READY_PATTERN, SESSION_HOST_SOCKET_ENV } from "./protocol";
import { activateSessionHostTransport, listenSessionHost } from "./transport";

/**
 * Session host worker entry: re-enters the CLI with `--resume <file> --mode rpc`
 * while rerouting the RPC transport from stdio to a unix socket published in the
 * daemon runtime dir. The daemon broker supervises this process, so the session
 * outlives every attached client.
 */
export async function startSessionHostFromEnvironment(): Promise<void> {
	const socketPath = Bun.env[SESSION_HOST_SOCKET_ENV];
	if (!socketPath) {
		process.stderr.write(`Error: ${SESSION_HOST_SOCKET_ENV} is required for ${"__proto_worker_session"}\n`);
		process.exitCode = 1;
		return;
	}

	const argv = Bun.argv.slice(2);
	if (argv[0] !== "__proto_worker_session") {
		process.stderr.write("Error: session host entry invoked without worker selector\n");
		process.exitCode = 1;
		return;
	}
	const cliArgv = argv.slice(1);
	if (!cliArgv.includes("--resume")) {
		process.stderr.write("Error: session host requires --resume <session-file>\n");
		process.exitCode = 1;
		return;
	}

	const server = await listenSessionHost(socketPath);
	activateSessionHostTransport(server.mux);
	process.stdout.write(`${SESSION_HOST_READY_PATTERN} ${socketPath}\n`);

	try {
		await runCli(cliArgv);
	} catch (error) {
		logger.error("session host crashed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		await server.stop();
	}
}
