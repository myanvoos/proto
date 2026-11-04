import { connect } from "node:net";
import * as path from "node:path";
import { logger, readLines, TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { type KernelProcess, throwIfAborted } from "../kernel-base";
import { stageRunnerScript } from "../runner-cache";
import SERVER_SOURCE from "./forkserver.py" with { type: "text" };
import { pythonEnvironmentIdentity } from "./runtime";

interface ChildExit {
	resolve(code: number): void;
	pid: number;
}
interface ForkServer {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	directory: string;
	socketPath: string;
	children: Map<number, ChildExit>;
	earlyExits: Map<number, number>;
	launches: number;
	settled: Promise<void>;
}
const servers = new Map<string, Promise<ForkServer>>();
const processes = new Set<Subprocess>();
export class ForkserverUnsupportedError extends Error {}
process.once("exit", () => {
	for (const proc of processes) {
		try {
			proc.kill("SIGTERM");
		} catch {}
	}
});

async function startServer(interpreter: string, runnerPath: string, forget: () => void): Promise<ForkServer> {
	const script = await stageRunnerScript("proto-python-forkserver", "py", SERVER_SOURCE);
	const ownedDirectory = await TempDir.createForUnixSocket("proto-py-fork-", "s");
	const directory = ownedDirectory.path();
	const socketPath = path.join(directory, "s");
	let proc: Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn([interpreter, "-I", "-S", "-u", script, socketPath, runnerPath], {
			cwd: directory,
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		await ownedDirectory.remove();
		throw error;
	}
	processes.add(proc);
	proc.unref();
	const ready = Promise.withResolvers<void>();
	const server: ForkServer = {
		proc,
		directory,
		socketPath,
		children: new Map(),
		earlyExits: new Map(),
		launches: 0,
		settled: Promise.resolve(),
	};
	const stdoutDone = (async () => {
		try {
			for await (const bytes of readLines(proc.stdout)) {
				const event: { type: string; pid?: number; code?: number } = JSON.parse(
					Buffer.from(bytes).toString("utf8"),
				);
				if (event.type === "ready") ready.resolve();
				else if (event.type === "unsupported")
					ready.reject(
						new ForkserverUnsupportedError("Interpreter does not support the local CPython forkserver"),
					);
				else if (event.type === "exit" && event.pid !== undefined) {
					const child = server.children.get(event.pid);
					if (child) {
						server.children.delete(event.pid);
						child.resolve(event.code ?? 1);
					} else server.earlyExits.set(event.pid, event.code ?? 1);
				}
			}
		} catch (error) {
			ready.reject(error);
		}
	})();
	let startupStderr = "";
	const stderrDone = (async () => {
		for await (const bytes of readLines(proc.stderr)) {
			const line = Buffer.from(bytes).toString("utf8");
			startupStderr = `${startupStderr}${line}\n`.slice(-16 * 1024);
			logger.debug("Python forkserver stderr", { line });
		}
	})();
	server.settled = proc.exited.then(async code => {
		await stdoutDone;
		processes.delete(proc);
		forget();
		for (const child of server.children.values()) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			child.resolve(1);
		}
		server.children.clear();
		await stderrDone;
		await ownedDirectory.remove();
		ready.reject(
			new Error(
				`Python forkserver exited before startup (exit ${code})${startupStderr ? `:\n${startupStderr.trim()}` : ""}`,
				{ cause: { pid: proc.pid, exitCode: code, socketPath, stderr: startupStderr } },
			),
		);
	});
	void server.settled.catch(error => ready.reject(error));
	const timer = setTimeout(() => {
		ready.reject(new Error("Python forkserver startup timed out"));
		proc.kill("SIGKILL");
	}, 10_000);
	try {
		await ready.promise;
		return server;
	} catch (error) {
		try {
			proc.kill("SIGKILL");
		} catch {}
		await server.settled;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export interface ForkserverProcess {
	process: KernelProcess;
	serverPid: number;
	startupMs: number;
}

/** A real child of a shared single-threaded interpreter; no Python relay or per-child spawn. */
export async function forkPythonKernel(options: {
	interpreter: string;
	runnerPath: string;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}): Promise<ForkserverProcess> {
	throwIfAborted(options.signal, "Python fork startup aborted");
	const started = performance.now();
	const key = pythonEnvironmentIdentity(options.interpreter);
	let pending = servers.get(key);
	if (!pending) {
		const forget = (): void => {
			if (servers.get(key) === pending) servers.delete(key);
		};
		pending = startServer(options.interpreter, options.runnerPath, forget);
		servers.set(key, pending);
		void pending.catch(forget);
	}
	const server = await pending;
	throwIfAborted(options.signal, "Python fork startup aborted");
	server.launches++;
	const launched = Promise.withResolvers<number>();
	const exited = Promise.withResolvers<number>();
	let pid: number | undefined;
	let header = Buffer.alloc(0);
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const socket = connect(server.socketPath);
	socket.on("data", chunk => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (pid !== undefined) {
			controller.enqueue(bytes.slice());
			return;
		}
		header = Buffer.concat([header, bytes]);
		const newline = header.indexOf(10);
		if (newline < 0) return;
		try {
			const reply: { pid?: number; error?: string } = JSON.parse(header.subarray(0, newline).toString());
			if (!reply.pid) throw new Error(reply.error ?? "Forkserver launch rejected");
			pid = reply.pid;
			server.children.set(pid, { pid, resolve: exited.resolve });
			const early = server.earlyExits.get(pid);
			if (early !== undefined) {
				server.earlyExits.delete(pid);
				server.children.delete(pid);
				exited.resolve(early);
			}
			const rest = header.subarray(newline + 1);
			if (rest.length) controller.enqueue(rest);
			header = Buffer.alloc(0);
			launched.resolve(pid);
		} catch (error) {
			launched.reject(error);
			socket.destroy();
		}
	});
	socket.on("close", () => {
		controller.close();
		if (pid === undefined) launched.reject(new Error("Forkserver closed during launch"));
	});
	socket.on("error", error => {
		launched.reject(error);
	});
	const write = (data: string): Promise<void> => {
		const pending = Promise.withResolvers<void>();
		socket.write(data, error => {
			if (error) pending.reject(error);
			else pending.resolve();
		});
		return pending.promise;
	};
	const abort = (): void => {
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}
		socket.destroy();
		launched.reject(new Error("Python fork startup aborted"));
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(abort, 10_000);
	try {
		await write(`${JSON.stringify({ cwd: options.cwd, env: options.env })}\n`);
		const childPid = await launched.promise;
		throwIfAborted(options.signal, "Python fork startup aborted");
		return {
			serverPid: server.proc.pid,
			startupMs: performance.now() - started,
			process: {
				pid: childPid,
				stdout,
				stderr: new ReadableStream({
					start(stream) {
						stream.close();
					},
				}),
				exited: exited.promise,
				stdin: {
					write,
					flush() {},
					end() {
						socket.end();
					},
				},
				kill(signal = "SIGTERM") {
					process.kill(childPid, signal);
				},
			},
		};
	} finally {
		server.launches--;
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}

export async function shutdownPythonForkservers(): Promise<void> {
	const active = await Promise.allSettled(servers.values());
	for (const result of active) if (result.status === "fulfilled") result.value.proc.stdin.end();
	await Promise.all(
		active.map(async result => {
			if (result.status === "fulfilled") await result.value.settled;
		}),
	);
}

export function pythonForkserverPids(): number[] {
	return [...processes].map(proc => proc.pid);
}

/** Sterile idle parents hold no user state and need no graph capture. */
export async function releaseIdlePythonForkservers(): Promise<boolean> {
	let released = false;
	for (const pending of servers.values()) {
		const server = await pending.catch(() => undefined);
		if (!server || server.children.size || server.launches) continue;
		server.proc.stdin.end();
		await server.settled;
		released = true;
	}
	return released;
}
