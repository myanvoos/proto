import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";
import { JsRuntime } from "./shared/runtime";
import type { JsStatusEvent } from "./shared/types";

interface State {
	generation: string;
	executionCount: number;
	active: number;
	queued: number | null;
	totalVariables: number;
	variables: { name: string; type: string; preview: string; cell: number }[];
	tasks: { id: string; kind: string; state: string; cell: number }[];
}

test("JavaScript inspection avoids getters and proxies, bounds previews, and reflects process restart", async () => {
	using tempDir = TempDir.createSync("@js-inspection-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const ownerId = `inspection:${crypto.randomUUID()}`;
	const events: JsStatusEvent[] = [];
	const run = async (code: string) => {
		let output = "";
		await executeInVmContext({
			runtime: "bun",
			sessionKey: ownerId,
			sessionId: ownerId,
			ownerId,
			cwd,
			session,
			code,
			filename: "inspection.js",
			runState: {
				onText: chunk => {
					output += chunk;
				},
				onDisplay: output => {
					if (output.type === "status") events.push(output.event);
				},
			},
			onStatus: event => {
				events.push(event);
			},
		});
		return { value: output.trim() };
	};
	try {
		await run(`var probe_calls = 0;
var probe_value = new Proxy({}, { get() { probe_calls++; throw Error("proxy invoked"); } });
Object.defineProperty(globalThis, "probe_getter", { configurable: true, get() { probe_calls++; throw Error("getter invoked"); } });
var probe_large = "\\x00".repeat(1000000);
var probe_integer = 1n << 1000000n;
var probe_cell = kernelState().executionCount;`);
		const { value } = await run("JSON.stringify(kernelState())");
		expect(typeof value).toBe("string");
		const state = JSON.parse(String(value)) as State;
		expect(state.active).toBe(1);
		expect(state.queued).toBeNull();
		expect(state.variables.find(v => v.name === "probe_getter")).toMatchObject({
			type: "accessor",
			preview: "<accessor>",
		});
		expect(state.variables.find(v => v.name === "probe_value")).toMatchObject({
			type: "object",
			preview: "<object>",
			cell: state.executionCount - 1,
		});
		expect(state.variables.every(v => v.preview.length <= 200)).toBe(true);
		expect(state.tasks).toContainEqual(
			expect.objectContaining({ kind: "cell", state: "running", cell: state.executionCount }),
		);
		expect((await run("probe_calls")).value).toBe("0");
		expect((await run("defs().probe_value === probe_cell")).value).toBe("true");
		const zero = JSON.parse(String((await run("JSON.stringify(kernelState({limit: 0}))")).value)) as State;
		expect(zero.variables).toEqual([]);
		expect(zero.tasks).toEqual([]);
		expect(zero.totalVariables).toBeGreaterThan(0);
		for (const limit of [-1, 1001, true, 1.5]) {
			await expect(run(`kernelState({limit: ${JSON.stringify(limit)}})`)).rejects.toThrow(
				"limit must be an integer",
			);
		}
		await run("delete globalThis.probe_value; delete globalThis.probe_getter;");
		expect((await run('Object.hasOwn(defs(), "probe_value")')).value).toBe("false");
		await expect(run("process.exit(17)")).rejects.toThrow("completion is uncertain");
		const restarted = JSON.parse(String((await run("JSON.stringify(kernelState())")).value)) as State;
		expect(restarted.generation).not.toBe(state.generation);
		expect(restarted.variables.some(v => v.name === "probe_large")).toBe(false);
		expect(events.filter(event => event.op === "kernel-state").map(event => event.generation)).toContain(
			restarted.generation,
		);
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 60_000);

test("JavaScript inspection reports actual in-flight tool calls and removes settled tasks", async () => {
	using tempDir = TempDir.createSync("@js-inspection-tasks-");
	const runtime = new JsRuntime({ initialCwd: tempDir.path(), sessionId: crypto.randomUUID() });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<unknown>();
	const running = runtime.run("await tool.inspection_wait({})", "inspection-task.js", {
		onText: () => {},
		onDisplay: () => {},
		callTool: async () => {
			entered.resolve();
			return await release.promise;
		},
	});
	try {
		await entered.promise;
		const state = runtime.kernelState();
		expect(state.active).toBe(1);
		expect(state.totalTasks).toBe(2);
		expect(state.tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "cell", state: "running", cell: 1 }),
				expect.objectContaining({ kind: "tool", state: "running", cell: 1 }),
			]),
		);
		expect(runtime.kernelState({ limit: 1 }).tasks).toHaveLength(1);
		release.resolve(null);
		await running;
		expect(runtime.kernelState()).toMatchObject({ active: 0, totalTasks: 0, tasks: [] });
	} finally {
		release.resolve(null);
		await running;
		runtime.dispose();
	}
}, 10_000);
