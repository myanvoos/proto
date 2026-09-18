import { afterEach, expect, spyOn, test, vi } from "bun:test";
import type { Subprocess } from "bun";
import { callTool, connectToServer, disconnectServer, listTools } from "../client";
import { StdioTransport, writeFrame } from "./stdio";

afterEach(() => vi.restoreAllMocks());

interface FakeStdin {
	write(chunk: string): unknown;
	flush(): unknown;
	end(): void;
}

interface FakeProcessOptions {
	stdin?: FakeStdin;
	startStdout?: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
}

function installFakeProcess(options: FakeProcessOptions = {}): {
	pid: number;
	killCalls: Array<{ pid: number; signal?: string | number }>;
} {
	const exited = Promise.withResolvers<number>();
	const killCalls: Array<{ pid: number; signal?: string | number }> = [];
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		exited.resolve(0);
		try {
			stdoutController?.close();
		} catch {}
	};
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
			options.startStdout?.(controller);
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	const pid = 987_654_321;
	const proc = {
		pid,
		stdin: options.stdin ?? {
			write: () => 0,
			flush: () => 0,
			end: () => {},
		},
		stdout,
		stderr,
		exited: exited.promise,
		kill: stop,
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;

	spyOn(Bun, "spawn").mockReturnValue(proc);
	spyOn(process, "kill").mockImplementation((targetPid, signal) => {
		killCalls.push({ pid: targetPid, signal });
		stop();
		return true;
	});
	return { pid, killCalls };
}

test("an unterminated oversized stdout frame closes the transport and kills the child", async () => {
	const closed = Promise.withResolvers<void>();
	const errors: Error[] = [];
	const { pid, killCalls } = installFakeProcess({
		startStdout(controller) {
			controller.enqueue(new Uint8Array(4 * 1024 * 1024).fill(0x20));
			controller.enqueue(new Uint8Array(4 * 1024 * 1024).fill(0x20));
			controller.enqueue(new Uint8Array([0x20]));
		},
	});

	const transport = new StdioTransport({ type: "stdio", command: "fake-mcp-server" });
	transport.onError = error => errors.push(error);
	transport.onClose = () => closed.resolve();
	await transport.connect();

	try {
		const outcome = await Promise.race([
			closed.promise.then(() => "closed" as const),
			Bun.sleep(500).then(() => "timed-out" as const),
		]);
		expect(outcome).toBe("closed");
		expect(transport.connected).toBe(false);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("frame exceeded");
		expect(killCalls[0]).toEqual({ pid: -pid, signal: "SIGTERM" });
	} finally {
		await transport.close();
	}
});

test.each(["write", "flush"] as const)("writeFrame propagates an asynchronous %s failure", async operation => {
	const fail = async () => {
		await Bun.sleep(0);
		throw new Error(`${operation} failed`);
	};
	const sink = {
		write: operation === "write" ? fail : () => 1,
		flush: operation === "flush" ? fail : () => 0,
	};

	await expect(writeFrame(sink, "{}\n")).rejects.toThrow(`${operation} failed`);
});

test("notify propagates an asynchronous flush failure and closes the transport", async () => {
	const failure = new Error("flush failed asynchronously");
	installFakeProcess({
		stdin: {
			write: async () => 1,
			flush: async () => {
				await Bun.sleep(0);
				throw failure;
			},
			end: () => {},
		},
	});
	const transport = new StdioTransport({ type: "stdio", command: "fake-mcp-server" });
	await transport.connect();

	try {
		await expect(transport.notify("notifications/cancelled")).rejects.toThrow(failure.message);
		expect(transport.connected).toBe(false);
	} finally {
		await transport.close();
	}
});

test("stdio supports initialize, tool discovery, and tool calls", async () => {
	const methods: string[] = [];
	const encoder = new TextEncoder();
	let sendResponse: ((id: string | number, result: unknown) => void) | undefined;
	installFakeProcess({
		startStdout(controller) {
			sendResponse = (id, result) => {
				controller.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`));
			};
		},
		stdin: {
			write(chunk) {
				const message = JSON.parse(chunk) as {
					id?: string | number;
					method: string;
					params?: Record<string, unknown>;
				};
				methods.push(message.method);
				if (message.id === undefined) return chunk.length;

				switch (message.method) {
					case "initialize":
						sendResponse?.(message.id, {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "fake-stdio", version: "1.0.0" },
						});
						break;
					case "tools/list":
						sendResponse?.(message.id, {
							tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
						});
						break;
					case "tools/call": {
						const args = message.params?.arguments as Record<string, unknown> | undefined;
						sendResponse?.(message.id, { content: [{ type: "text", text: `echo: ${String(args?.text)}` }] });
						break;
					}
				}
				return chunk.length;
			},
			flush: () => 0,
			end: () => {},
		},
	});

	const connection = await connectToServer("fake", { type: "stdio", command: "fake-mcp-server" });
	try {
		expect(connection.serverInfo).toEqual({ name: "fake-stdio", version: "1.0.0" });
		expect(await listTools(connection)).toEqual([
			{ name: "echo", description: "Echo text", inputSchema: { type: "object" } },
		]);
		expect(await callTool(connection, "echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "echo: hello" }],
		});
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
	} finally {
		await disconnectServer(connection);
	}
});
