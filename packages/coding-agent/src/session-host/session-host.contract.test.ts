import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { negotiateSessionHost } from "./ensure";
import { SESSION_HOST_READY_PATTERN, SESSION_HOST_SOCKET_ENV, SESSION_HOST_WORKER_ARG } from "./protocol";

const BOOTSTRAP_TIMEOUT_MS = 90_000;

interface HostClient {
	sendCommand(command: object): void;
	frames: AsyncIterableQueue;
	close(): void;
	closed: Promise<void>;
}

class AsyncIterableQueue {
	#frames: object[] = [];
	#waiters = new Set<() => void>();

	push(frame: object): void {
		this.#frames.push(frame);
		for (const waiter of this.#waiters) waiter();
	}

	async next(): Promise<object> {
		for (;;) {
			const frame = this.#frames.shift();
			if (frame) return frame;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.add(resolve);
			try {
				// Re-check after registering: a push landing between the shift
				// above and waiter registration must not be lost.
				const queued = this.#frames.shift();
				if (queued) return queued;
				await promise;
			} finally {
				this.#waiters.delete(resolve);
			}
		}
	}

	async findResponse(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.#frames.findIndex(frame => {
				const candidate = frame as { id?: unknown };
				return candidate.id === id;
			});
			if (index >= 0) {
				const [frame] = this.#frames.splice(index, 1);
				return frame as Record<string, unknown>;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for rpc response ${id}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.add(resolve);
			try {
				// Re-check after registering so a push that lands between the
				// findIndex above and waiter registration cannot be lost.
				const indexNow = this.#frames.findIndex(frame => {
					const candidate = frame as { id?: unknown };
					return candidate.id === id;
				});
				if (indexNow >= 0) {
					const [frame] = this.#frames.splice(indexNow, 1);
					return frame as Record<string, unknown>;
				}
				if (Date.now() > deadline) throw new Error(`timed out waiting for rpc response ${id}`);
				await promise;
			} finally {
				this.#waiters.delete(resolve);
			}
		}
	}
}

async function connectHostClient(socket: string, timeoutMs: number): Promise<HostClient> {
	const frames = new AsyncIterableQueue();
	const decoder = new RpcFrameDecoder();
	const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
	const conn = await Bun.connect({
		unix: socket,
		socket: {
			data(_socket, chunk) {
				const text = new TextDecoder().decode(chunk);
				for (const line of text.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const parsed: unknown = JSON.parse(trimmed);
						const frame = decoder.push(parsed);
						if (frame) frames.push(frame);
					} catch {
						// partial JSON line or chunk bookkeeping — decoder handles reassembly
					}
				}
			},
			close() {
				resolveClosed();
			},
			error() {
				resolveClosed();
			},
		},
	});
	void timeoutMs;
	return {
		frames,
		closed,
		sendCommand(command: object) {
			conn.write(`${JSON.stringify(command)}\n`);
		},
		close() {
			conn.end();
		},
	};
}

describe("session host worker", () => {
	let tmpDir: string;
	let sessionFile: string;
	let socketPath: string;
	let hostStdout = "";
	let hostStderr = "";
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-session-host-"));
		// Hand-written minimal session file — SessionManager would write into the
		// real config root from the unsandboxed test process.
		sessionFile = path.join(tmpDir, "session.jsonl");
		await fs.writeFile(
			sessionFile,
			[
				JSON.stringify({ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" }),
				JSON.stringify({
					type: "session",
					version: 3,
					id: "00000000-0000-4000-8000-000000000002",
					timestamp: new Date().toISOString(),
					cwd: tmpDir,
				}),
				"",
			].join("\n"),
		);
		socketPath = path.join(tmpDir, "host.sock");
		// resolveWorkerSpawnCmd's bun-test fallback uses a package-root-relative
		// entry; resolve it absolutely so the worker can run with cwd = project.
		const hostEntry = workerHostEntry() ?? path.resolve(import.meta.dir, "..", "cli.ts");
		child = Bun.spawn({
			cmd: [process.execPath, hostEntry, SESSION_HOST_WORKER_ARG, "--resume", sessionFile, "--mode", "rpc"],
			env: workerEnvFromParent({ [SESSION_HOST_SOCKET_ENV]: socketPath }),
			cwd: tmpDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Drain stdout/stderr continuously like the broker's log capture does —
		// an undrained pipe would eventually block the host on write.
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
				hostStdout += decoder.decode(chunk, { stream: true });
				if (hostStdout.length > 64_000) hostStdout = hostStdout.slice(-32_000);
			}
		})();
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
				hostStderr += decoder.decode(chunk, { stream: true });
				if (hostStderr.length > 64_000) hostStderr = hostStderr.slice(-32_000);
			}
		})();
		// Await the broker readiness signal itself — the host prints it right after listen().
		const waitForReadyLine = async (): Promise<void> => {
			while (!hostStdout.includes(SESSION_HOST_READY_PATTERN)) {
				await Bun.sleep(20);
			}
		};
		await Promise.race([
			waitForReadyLine(),
			child.exited.then(code => {
				throw new Error(`session host exited (code ${code}) before ready line\n${hostStderr}`);
			}),
		]);
	});

	afterAll(async () => {
		child?.kill();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("serves RPC over the socket, survives client churn, and reports unknown commands", async () => {
		const probe = await negotiateSessionHost(socketPath, BOOTSTRAP_TIMEOUT_MS);
		expect(probe.socket).toBe("live");

		const first = await connectHostClient(socketPath, BOOTSTRAP_TIMEOUT_MS);
		first.sendCommand({ id: "state-1", type: "get_state" });
		const response = await first.frames.findResponse("state-1", BOOTSTRAP_TIMEOUT_MS);
		expect(response.success).toBe(true);
		expect((response.data as { sessionFile?: string }).sessionFile).toBe(path.resolve(sessionFile));

		// Latest client wins: attaching a second client closes the first.
		const second = await connectHostClient(socketPath, BOOTSTRAP_TIMEOUT_MS);
		await first.closed;
		second.sendCommand({ id: "state-2", type: "get_state" });
		const secondResponse = await second.frames.findResponse("state-2", BOOTSTRAP_TIMEOUT_MS);
		expect(secondResponse.success).toBe(true);

		// Host survives client disconnect: detach must not dispose the session.
		second.close();
		const redetach = await negotiateSessionHost(socketPath, BOOTSTRAP_TIMEOUT_MS);
		expect(redetach.socket).toBe("live");

		// Unknown commands surface an error response instead of crashing the host.
		const third = await connectHostClient(socketPath, BOOTSTRAP_TIMEOUT_MS);
		third.sendCommand({ id: "bogus-1", type: "definitely_not_a_command" });
		const errorResponse = await third.frames.findResponse("bogus-1", BOOTSTRAP_TIMEOUT_MS);
		expect(errorResponse.success).toBe(false);
		third.close();
	}, 120_000);
});
