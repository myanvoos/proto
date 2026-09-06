import { afterAll, afterEach, expect, spyOn, test, vi } from "bun:test";
import * as net from "node:net";
import type { ToolSession } from "../tools";
import jsBackend from "./js";
import { disposeVmContextsByOwner } from "./js/context-manager";
import { type KernelShellBridgeHandle, registerKernelShellRun } from "./shell-bridge";

const KERNEL_OWNER = `shell-bridge-test:${process.pid}`;

function stubSession(): ToolSession {
	const id = crypto.randomUUID();
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		getEvalSessionId: () => id,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

async function connectBridge(bridge: KernelShellBridgeHandle) {
	const connected = Promise.withResolvers<void>();
	const response = Promise.withResolvers<string>();
	const [host, port] = bridge.env.PI_KERNEL_BRIDGE_ADDR!.split(":");
	const socket = net.createConnection({ host, port: Number(port) }, connected.resolve);
	let text = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		text += chunk;
	});
	socket.on("error", error => {
		connected.reject(error);
		response.reject(error);
	});
	socket.on("close", () => response.resolve(text));
	await connected.promise;
	return {
		socket,
		response: response.promise,
		request: (code: string) => `${JSON.stringify({ token: bridge.env.PI_KERNEL_BRIDGE_TOKEN, lang: "js", code })}\n`,
	};
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => disposeVmContextsByOwner(KERNEL_OWNER));

test("a slow shell reader receives complete UTF-8 output and the final exit frame", async () => {
	const executed = Promise.withResolvers<void>();
	const execute = jsBackend.execute;
	spyOn(jsBackend, "execute").mockImplementation(async (...args) => {
		try {
			return await execute(...args);
		} finally {
			executed.resolve();
		}
	});
	const bridge = registerKernelShellRun(stubSession());
	const client = await connectBridge(bridge);
	try {
		// Exceed the TCP send buffer without relying on a guessed reader delay.
		client.socket.pause();
		client.socket.write(client.request('console.log("ü".repeat(8 * 1024 * 1024))'));
		await executed.promise;
		client.socket.resume();
		const frames: Array<{ t: string; d?: string; c?: number }> = (await client.response)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(
			frames
				.filter(frame => frame.t === "o")
				.map(frame => frame.d)
				.join(""),
		).toBe(`${"ü".repeat(8 * 1024 * 1024)}\n`);
		expect(frames.at(-1)).toEqual({ t: "x", c: 0 });
	} finally {
		client.socket.destroy();
		bridge.dispose();
	}
});

for (const available of [true, false]) {
	test(`cancelling during backend preflight prevents ${available ? "cell execution" : "external fallback"}`, async () => {
		const entered = Promise.withResolvers<void>();
		const availability = Promise.withResolvers<boolean>();
		spyOn(jsBackend, "isAvailable").mockImplementation(async () => {
			entered.resolve();
			return availability.promise;
		});
		const bridge = registerKernelShellRun(stubSession());
		const client = await connectBridge(bridge);
		try {
			client.socket.write(`${client.request("console.log('must not execute')")}{"t":"c"}\n`);
			await entered.promise;
			expect((await client.response).trim()).toBe(JSON.stringify({ t: "x", c: 130 }));
		} finally {
			availability.resolve(available);
			client.socket.destroy();
			bridge.dispose();
		}
	});
}

test("disposing one shell run cancels its pending cell without closing another run's bridge", async () => {
	const entered = Promise.withResolvers<void>();
	const availability = Promise.withResolvers<boolean>();
	spyOn(jsBackend, "isAvailable").mockImplementationOnce(async () => {
		entered.resolve();
		return availability.promise;
	});
	const session = stubSession();
	const disposedBridge = registerKernelShellRun(session);
	const survivingBridge = registerKernelShellRun(session);
	const cancelled = await connectBridge(disposedBridge);
	const surviving = await connectBridge(survivingBridge);
	try {
		cancelled.socket.write(cancelled.request("console.log('must not execute')"));
		await entered.promise;
		disposedBridge.dispose();
		expect((await cancelled.response).trim()).toBe(JSON.stringify({ t: "x", c: 130 }));
		surviving.socket.write(surviving.request("console.log(6 * 7)"));
		expect(
			(await surviving.response)
				.trim()
				.split("\n")
				.map(line => JSON.parse(line)),
		).toEqual([
			{ t: "o", d: "42\n" },
			{ t: "x", c: 0 },
		]);
	} finally {
		availability.resolve(true);
		cancelled.socket.destroy();
		surviving.socket.destroy();
		disposedBridge.dispose();
		survivingBridge.dispose();
	}
});
