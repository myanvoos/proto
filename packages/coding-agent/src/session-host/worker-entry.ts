import { logger } from "@oh-my-pi/pi-utils";

import { runCli } from "../cli";
import { createBrokerExecutionAdmissionClient } from "../launch/execution-admission";
import { ExecutionAdmission } from "../task/execution-admission";
import { activateSessionHostOwnership, beginSessionHostOwnership, type SessionHostOwnership } from "./ownership";
import {
	SESSION_HOST_BROKER_RUNTIME_ENV,
	SESSION_HOST_INTERACTIVE_ENV,
	SESSION_HOST_READY_PATTERN,
	SESSION_HOST_SOCKET_ENV,
} from "./protocol";
import { activateSessionHostTransport, listenSessionHost, type SessionHostServer } from "./transport";

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
	let cliArgv = argv.slice(1);
	if (!cliArgv.includes("--resume")) {
		process.stderr.write("Error: session host requires --resume <session-file>\n");
		process.exitCode = 1;
		return;
	}

	let ownership: SessionHostOwnership | undefined;
	if (Bun.env[SESSION_HOST_INTERACTIVE_ENV] === "1") {
		const resumeIndex = cliArgv.indexOf("--resume");
		const initialFile = cliArgv[resumeIndex + 1];
		if (!initialFile) throw new Error("Session host requires an explicit resume file");
		ownership = await beginSessionHostOwnership(socketPath, process.cwd(), initialFile);
		activateSessionHostOwnership(ownership);
		const restartArgs = ownership.restartArgs;
		if (ownership.restoring && !restartArgs && ownership.revision > 0)
			throw new Error("Hosted restart arguments were not committed; refusing to replay the original submission");
		if (restartArgs) cliArgv = [...restartArgs];
		const activeResumeIndex = cliArgv.indexOf("--resume");
		if (activeResumeIndex < 0) throw new Error("Committed hosted restart arguments have no explicit resume target");
		cliArgv[activeResumeIndex + 1] = ownership.activeSessionFile;
	}
	let server: SessionHostServer | undefined;
	try {
		ExecutionAdmission.global().setBroker(
			await createBrokerExecutionAdmissionClient(process.cwd(), Bun.env[SESSION_HOST_BROKER_RUNTIME_ENV]),
		);
		server = await listenSessionHost(socketPath);
		activateSessionHostTransport(server.mux);
		const running = runCli(cliArgv);
		await Promise.race([
			server.mux.whenServing(),
			running.then(() => {
				throw new Error("Session host exited before serving requests");
			}),
		]);
		process.stdout.write(`${SESSION_HOST_READY_PATTERN} ${socketPath}\n`);
		await running;
	} catch (error) {
		logger.error("session host crashed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		try {
			await server?.stop();
		} finally {
			await ownership?.close();
		}
	}
}
