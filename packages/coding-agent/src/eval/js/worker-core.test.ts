import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "./worker-protocol";

type ToolCallMessage = Extract<WorkerOutbound, { type: "tool-call" }>;
type ResultMessage = Extract<WorkerOutbound, { type: "result" }>;

class TestTransport implements Transport {
	readonly sent: WorkerOutbound[] = [];
	#handler: ((msg: WorkerInbound) => void) | undefined;
	#listeners = new Set<(msg: WorkerOutbound) => void>();

	send(msg: WorkerOutbound): void {
		this.sent.push(msg);
		if ((msg.type === "text" || msg.type === "bytes") && msg.id) {
			this.#handler?.({ type: "output-ack", id: msg.id });
		}
		for (const listener of this.#listeners) listener(msg);
	}

	onMessage(handler: (msg: WorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}

	close(): void {}

	dispatch(msg: WorkerInbound): void {
		if (!this.#handler) throw new Error("Worker transport is closed");
		this.#handler(msg);
	}

	async waitFor<T extends WorkerOutbound>(predicate: (msg: WorkerOutbound) => msg is T): Promise<T> {
		const existing = this.sent.find(predicate);
		if (existing) return existing;
		const { promise, resolve } = Promise.withResolvers<T>();
		const listener = (msg: WorkerOutbound): void => {
			if (!predicate(msg)) return;
			this.#listeners.delete(listener);
			resolve(msg);
		};
		this.#listeners.add(listener);
		return await promise;
	}
}

function isToolCall(name: string): (msg: WorkerOutbound) => msg is ToolCallMessage {
	return (msg): msg is ToolCallMessage => msg.type === "tool-call" && msg.name === name;
}

function isResult(runId: string): (msg: WorkerOutbound) => msg is ResultMessage {
	return (msg): msg is ResultMessage => msg.type === "result" && msg.runId === runId;
}

test("serializes overlapping cells before the next cell can replace file attribution", async () => {
	using tempDir = TempDir.createSync("@js-worker-fifo-");
	const cwd = tempDir.path();
	const order = path.join(cwd, "order.txt");
	const aFile = path.join(cwd, "a.txt");
	const bFile = path.join(cwd, "b.txt");
	const snapshot = { cwd, sessionId: `worker-fifo:${crypto.randomUUID()}` };
	const transport = new TestTransport();
	const core = new WorkerCore(transport, {
		mode: "isolated",
		interceptUnhandledRejections: () => () => {},
	});

	try {
		transport.dispatch({ type: "init", snapshot });
		expect(transport.sent.some(message => message.type === "ready")).toBe(true);

		transport.dispatch({
			type: "run",
			runId: "run-a",
			filename: "run-a.js",
			snapshot,
			code: [
				`await Bun.write(${JSON.stringify(order)}, "A-start\\n");`,
				"await tool.hold({});",
				`await Bun.write(${JSON.stringify(aFile)}, "A");`,
				`await Bun.write(${JSON.stringify(order)}, (await Bun.file(${JSON.stringify(order)}).text()) + "A-end\\n");`,
			].join("\n"),
		});
		const hold = await transport.waitFor(isToolCall("hold"));

		transport.dispatch({
			type: "run",
			runId: "run-b",
			filename: "run-b.js",
			snapshot,
			code: [
				"await tool.started({});",
				`await Bun.write(${JSON.stringify(bFile)}, "B");`,
				`await Bun.write(${JSON.stringify(order)}, (await Bun.file(${JSON.stringify(order)}).text()) + "B\\n");`,
			].join("\n"),
		});

		// All promise work queued by run B drains before this task. A queued worker must not have admitted B yet.
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(transport.sent.some(message => message.type === "tool-call" && message.name === "started")).toBe(false);

		transport.dispatch({ type: "tool-reply", id: hold.id, reply: { ok: true, value: null } });
		const aResult = await transport.waitFor(isResult("run-a"));
		const started = await transport.waitFor(isToolCall("started"));
		transport.dispatch({ type: "tool-reply", id: started.id, reply: { ok: true, value: null } });
		const bResult = await transport.waitFor(isResult("run-b"));

		expect([aResult, bResult]).toEqual([
			{ type: "result", runId: "run-a", ok: true },
			{ type: "result", runId: "run-b", ok: true },
		]);
		expect(await Bun.file(order).text()).toBe("A-start\nA-end\nB\n");

		const writes = transport.sent.flatMap(message =>
			message.type === "display" && message.output.type === "status" && message.output.event.op === "write"
				? [{ runId: message.runId, path: message.output.event.path }]
				: [],
		);
		expect(writes).toContainEqual({ runId: "run-a", path: aFile });
		expect(writes).toContainEqual({ runId: "run-b", path: bFile });
	} finally {
		core.dispose();
	}
}, 5_000);

test("large rich displays are bounded before worker transport and overflow is visible", async () => {
	const transport = new TestTransport();
	const core = new WorkerCore(transport, { mode: "isolated", interceptUnhandledRejections: () => () => {} });
	const snapshot = { cwd: process.cwd(), sessionId: `worker-display:${crypto.randomUUID()}` };
	try {
		transport.dispatch({ type: "init", snapshot });
		transport.dispatch({
			type: "run",
			runId: "large-display",
			filename: "large-display.js",
			snapshot,
			code: 'for (let i = 0; i < 16; i++) display({ i, text: "x".repeat(1024 * 1024) });',
		});
		expect(await transport.waitFor(isResult("large-display"))).toEqual({
			type: "result",
			runId: "large-display",
			ok: true,
		});
		const displays = transport.sent.flatMap(message =>
			message.type === "display" && message.output.type !== "status" ? [message.output] : [],
		);
		expect(Buffer.byteLength(JSON.stringify(displays))).toBeLessThan(257 * 1024);
		expect(displays.some(output => output.type === "notice" && output.text.includes("omitted"))).toBe(true);
	} finally {
		core.dispose();
	}
});

test("late rich displays retain their originating run after the producer drains its budget", async () => {
	const transport = new TestTransport();
	const core = new WorkerCore(transport, { mode: "isolated", interceptUnhandledRejections: () => () => {} });
	const snapshot = { cwd: process.cwd(), sessionId: `worker-late-display:${crypto.randomUUID()}` };
	try {
		transport.dispatch({ type: "init", snapshot });
		transport.dispatch({
			type: "run",
			runId: "origin",
			filename: "origin.js",
			snapshot,
			code: "var lateGate = Promise.withResolvers(); void lateGate.promise.then(() => display({late:true}));",
		});
		await transport.waitFor(isResult("origin"));
		transport.dispatch({
			type: "run",
			runId: "trigger",
			filename: "trigger.js",
			snapshot,
			code: "lateGate.resolve();",
		});
		await transport.waitFor(isResult("trigger"));
		expect(transport.sent).toContainEqual({
			type: "display",
			runId: "origin",
			output: { type: "json", data: { late: true } },
		});
		expect(
			transport.sent.some(
				message => message.type === "display" && message.runId === "trigger" && message.output.type === "json",
			),
		).toBe(false);
	} finally {
		core.dispose();
	}
});
