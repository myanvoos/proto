import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as net from "node:net";
import type { ToolSession } from "../tools";
import type { ExecutorBackendResult } from "./backend";
import { bunBackend } from "./js";
import { type KernelShellBridgeHandle, registerKernelShellRun } from "./shell-bridge";
import type { EvalDisplayOutput, EvalStatusEvent } from "./types";

function session(): ToolSession {
	return { cwd: process.cwd(), settings: { get: () => undefined } } as unknown as ToolSession;
}

function result(displayOutputs: EvalDisplayOutput[]): ExecutorBackendResult {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs,
	};
}

async function request(bridge: KernelShellBridgeHandle): Promise<string> {
	const response = Promise.withResolvers<string>();
	const [host, port] = bridge.env.PI_KERNEL_BRIDGE_ADDR!.split(":");
	const socket = net.createConnection({ host, port: Number(port) });
	let text = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		text += chunk;
	});
	socket.on("error", response.reject);
	socket.on("close", () => response.resolve(text));
	socket.on("connect", () =>
		socket.write(`${JSON.stringify({ token: bridge.env.PI_KERNEL_BRIDGE_TOKEN, lang: "bun", code: "bounded" })}\n`),
	);
	try {
		return await response.promise;
	} finally {
		socket.destroy();
	}
}

afterEach(() => vi.restoreAllMocks());

test("one shell run shares rich-output admission across every bridge cell", async () => {
	spyOn(bunBackend, "execute").mockImplementation(async () =>
		result([
			{ type: "json", data: { payload: "j".repeat(60 * 1024) } },
			{ type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png" },
		]),
	);
	const bridge = registerKernelShellRun(session());
	try {
		for (let index = 0; index < 32; index++) {
			const response = await request(bridge);
			expect(response).toBe('{"t":"x","c":0}\n');
		}
		const images = bridge.drainImages();
		const json = bridge.drainJsonOutputs();
		expect(images).toHaveLength(3);
		expect(Buffer.byteLength(JSON.stringify({ images, json }))).toBeLessThan(4 * 1024 * 1024);
		expect(bridge.drainDisplayText().some(text => text.includes("truncated"))).toBe(true);
		expect(bridge.drainImages()).toEqual([]);
		expect(bridge.drainJsonOutputs()).toEqual([]);
	} finally {
		bridge.dispose();
	}
});

test("shell status frames cannot retain unbounded rich metadata in callbacks or drains", async () => {
	spyOn(bunBackend, "execute").mockImplementation(async (_code, options) => {
		for (let index = 0; index < 80; index++)
			options.onStatus?.({ op: "progress", index, payload: "s".repeat(128 * 1024) });
		return result([]);
	});
	const live: EvalStatusEvent[] = [];
	const bridge = registerKernelShellRun(session(), event => live.push(event));
	try {
		expect(await request(bridge)).toBe('{"t":"x","c":0}\n');
		expect(bridge.drainDisplayText().join("\n")).toContain("metadata truncated");
		expect(Buffer.byteLength(JSON.stringify(live))).toBeLessThan(4 * 1024 * 1024);
		expect(bridge.drainStatusEvents()).toEqual(live);
	} finally {
		bridge.dispose();
	}
});
