import { expect, test } from "bun:test";
import type { AxNode, DesktopWindow } from "@oh-my-pi/pi-natives";
import type { ComputerWorkerOutbound } from "./protocol";
import { ComputerWorkerCore, type NativeDesktopSession } from "./worker";

type Result = Extract<ComputerWorkerOutbound, { type: "result" }>;

const window: DesktopWindow = {
	id: "42",
	app: "Editor",
	title: "document",
	pid: 12,
	x: 0,
	y: 0,
	width: 800,
	height: 600,
	focused: false,
};

async function run(code: string, native: Partial<NativeDesktopSession>, readOnly = true): Promise<Result> {
	const finished = Promise.withResolvers<Result>();
	const closed = Promise.withResolvers<void>();
	const core = new ComputerWorkerCore(
		{
			send: message => {
				if (message.type === "result") finished.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage: () => () => {},
			close: () => {},
		},
		() => ({ close: async () => {}, ...native }) as NativeDesktopSession,
	);
	try {
		core.handle({
			type: "run",
			id: "lookup",
			code,
			timeoutMs: 5000,
			session: {
				cwd: process.cwd(),
				sessionId: `computer-window:${crypto.randomUUID()}`,
				captureMaxWidth: 1280,
				captureMaxHeight: 896,
				display: "all",
				readOnly,
			},
		});
		return await finished.promise;
	} finally {
		core.handle({ type: "close" });
		await closed.promise;
	}
}

test("window waits through its final partial interval for a newly opened window", async () => {
	let calls = 0;
	const result = await run('return (await desktop.window({app: "Editor", wait: 20})).id;', {
		listWindows: async () => (++calls === 1 ? [] : [window]),
	});
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.payload.returnValue).toBe("42");
	expect(calls).toBe(2);
});

test("window rejects unserializable waits before listing windows", async () => {
	let calls = 0;
	const result = await run("await desktop.window({wait: 1n});", {
		listWindows: async () => {
			calls++;
			return [];
		},
	});
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("window({ wait })");
	expect(calls).toBe(0);
});

test("window miss lists untitled window ids and keeps app names on one line", async () => {
	const result = await run('await desktop.window({app: "Missing"});', {
		listWindows: async () => [{ ...window, app: "Editor\nInjected", title: "" }],
	});
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.message).toContain('42 ""');
		expect(result.error.message).not.toContain("Editor\nInjected");
	}
});

test("window id filter selects one window without hiding ambiguity", async () => {
	const result = await run("return (await desktop.window({id: 42})).id;", {
		listWindows: async () => [window, { ...window, id: "43" }],
	});
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.payload.returnValue).toBe("42");
});

test("move forwards the explicitly requested delivery mode", async () => {
	let delivery: string | undefined;
	const result = await run(
		'const win = await desktop.window(42); await win.move(1,2,{delivery:"foreground"});',
		{
			listWindows: async () => [window],
			moveMouse: async (_target, _x, _y, options) => {
				delivery = options?.deliveryMode;
			},
		},
		false,
	);
	expect(result.ok).toBe(true);
	expect(delivery).toBe("foreground");
});

test("malformed text reports its helper without reaching native input", async () => {
	let calls = 0;
	const result = await run(
		"const win = await desktop.window(42); await win.type(123);",
		{
			listWindows: async () => [window],
			typeText: async () => {
				calls++;
			},
		},
		false,
	);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("type(text) requires a string");
	expect(calls).toBe(0);
});

const node: AxNode = {
	ref: "e1",
	role: "button",
	nativeRole: "AXButton",
	enabled: true,
	focused: false,
	childCount: 0,
	actions: ["AXPress"],
};

test("ref handles chain element methods and double-click with two presses", async () => {
	let lookups = 0;
	const clicks: number[] = [];
	const result = await run(
		'const win = await desktop.window(42); const el = win.ref("e1"); await el.doubleClick(); return (await el).ref;',
		{
			listWindows: async () => [window],
			axNode: async () => {
				lookups++;
				return node;
			},
			axClick: async (_ref, options) => {
				clicks.push(options?.count ?? 1);
			},
		},
		false,
	);
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.payload.returnValue).toBe("e1");
	expect(lookups).toBe(1);
	expect(clicks).toEqual([2]);
});

test("malformed ref writes reject before looking up the native element", async () => {
	let lookups = 0;
	const result = await run(
		'const win = await desktop.window(42); await win.ref("expired").setValue(12);',
		{
			listWindows: async () => [window],
			axNode: async () => {
				lookups++;
				throw new Error("stale ref");
			},
		},
		false,
	);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("setValue(value) requires a string");
	expect(lookups).toBe(0);
});

test("find array field reads explain how to select an element", async () => {
	const result = await run('const win = await desktop.window(42); return (await win.find({role:"button"})).ref;', {
		listWindows: async () => [window],
		axQuery: async () => [node],
	});
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain("find() returns an array");
});

test("window listings stay bounded while exact lookup searches every window", async () => {
	const windows = Array.from({ length: 60 }, (_, index) => ({ ...window, id: String(index) }));
	const result = await run(
		"return {listed: (await desktop.windows()).length, found: (await desktop.window(59)).id};",
		{
			listWindows: async () => windows,
		},
	);
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.payload.returnValue).toEqual({ listed: 48, found: "59" });
});

test("an omitted selector succeeds only on a one-window desktop", async () => {
	for (const count of [0, 1, 2]) {
		const result = await run("return (await desktop.window()).id;", {
			listWindows: async () => Array.from({ length: count }, (_, index) => ({ ...window, id: String(index) })),
		});
		if (count === 1) {
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.payload.returnValue).toBe("0");
		} else {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("window id");
		}
	}
});
