import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { FleetTool } from "./fleet/index";
import type { Tool, ToolSession } from "./index";
import { MonitorTool } from "./monitor";
import { ToolError } from "./tool-errors";
import { dispatchXdevTool, type XdevState } from "./xdev";
import { normalizeXdDeviceArgs, suggestKnownKey } from "./xdev-normalize";

test("fleet send written Claude-Code style (to + message, no op) normalizes to canonical send", () => {
	const { args, notes } = normalizeXdDeviceArgs("fleet", { to: "Main", message: "done" });
	expect(args).toEqual({ op: "send", id: "Main", message: "done" });
	expect(notes.join(" ")).toContain('op:"send"');
	expect(notes.join(" ")).toContain("`to` as `id`");
});

test("fleet alias target maps to id and canonical id wins over alias", () => {
	const aliased = normalizeXdDeviceArgs("fleet", { op: "wait", target: "worker-1" });
	expect(aliased.args).toEqual({ op: "wait", id: "worker-1" });

	const conflict = normalizeXdDeviceArgs("fleet", { op: "send", id: "a", to: "b", message: "m" });
	expect(conflict.args).toEqual({ op: "send", id: "a", message: "m" });
	expect(conflict.notes.join(" ")).toContain("ignored `to`");
});

test("orchestrate_wait accepts worker/timeout_seconds spellings as ids/timeoutMs", () => {
	const { args } = normalizeXdDeviceArgs("orchestrate_wait", { worker: "w1", timeout_seconds: 30 });
	expect(args).toEqual({ ids: ["w1"], timeoutMs: 30000 });
});

test("orchestrate_send/kill map worker-style ids to canonical id", () => {
	expect(normalizeXdDeviceArgs("orchestrate_send", { workerId: "w1", message: "go" }).args).toEqual({
		id: "w1",
		message: "go",
	});
	expect(normalizeXdDeviceArgs("orchestrate_kill", { name: "rust-diff" }).args).toEqual({ id: "rust-diff" });
});

test("orchestrate_spawn maps prompt/name habits to message/label", () => {
	const { args } = normalizeXdDeviceArgs("orchestrate_spawn", { prompt: "do it", name: "scout-1" });
	expect(args).toEqual({ message: "do it", label: "scout-1" });
});

test("monitor maps action/name/job/id to op/label/ids", () => {
	const { args } = normalizeXdDeviceArgs("monitor", { action: "start", command: "make", name: "build", id: "m1" });
	expect(args).toEqual({ op: "start", command: "make", label: "build", ids: ["m1"] });
});

test("recall maps q and search mode, coerces numeric strings, and rejects result-count keys", () => {
	const { args } = normalizeXdDeviceArgs("recall", { q: "plot", mode: "search", expand: ["3"], page: "2" });
	expect(args).toEqual({ query: "plot", mode: "hybrid", expand: [3], page: 2 });

	expect(() => normalizeXdDeviceArgs("recall", { query: "x", limit: 3 })).toThrow(ToolError);
	expect(() => normalizeXdDeviceArgs("recall", { query: "x", limit: 3 })).toThrow(/page NUMBER/);
});

test("unknown devices pass through untouched", () => {
	const args = { anything: "goes" };
	expect(normalizeXdDeviceArgs("mcp__dgx_agent_aperture_web_fetch", args)).toEqual({ args, notes: [] });
});

test("suggestKnownKey proposes case-insensitive and near matches, else undefined", () => {
	expect(suggestKnownKey("iD", ["op", "id", "message"])).toBe("id");
	expect(suggestKnownKey("timeoutms", ["ids", "timeoutMs"])).toBe("timeoutMs");
	expect(suggestKnownKey("completely-unrelated", ["op", "id", "message"])).toBeUndefined();
});

test("dispatchXdevTool executes fleet send from Claude-Code-style args and reports the repair", async () => {
	const seen: Record<string, unknown>[] = [];
	const fleet = {
		name: "fleet",
		label: "Fleet",
		description: "stub fleet device",
		parameters: type({
			op: type("'send' | 'wait'").describe("fleet operation"),
			"id?": type("string").describe("recipient"),
			"message?": type("string").describe("body"),
		}),
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			seen.push(args);
			return { content: [{ type: "text" as const, text: "sent\n" }] };
		},
	} as unknown as Tool;
	const state: XdevState = {
		tools: new Map([[fleet.name, fleet]]),
		mountedNames: new Set([fleet.name]),
		builtInNames: new Set([fleet.name]),
		isActive: () => false,
	};

	const { result, xdev } = await dispatchXdevTool(state, "fleet", '{"to":"Main","message":"hi"}', "t1");
	expect(seen[0]).toEqual({ op: "send", id: "Main", message: "hi" });
	expect(xdev.args).toEqual({ op: "send", id: "Main", message: "hi" });
	expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^note: /) });
});

test("dispatchXdevTool surfaces unknown keys with did-you-mean hints as an error result", async () => {
	const fleet = {
		name: "fleet",
		label: "Fleet",
		description: "stub fleet device",
		parameters: type({
			op: type("'send' | 'wait'").describe("fleet operation"),
			"id?": type("string").describe("recipient"),
		}),
		async execute() {
			throw new Error("must not execute");
		},
	} as unknown as Tool;
	const state: XdevState = {
		tools: new Map([[fleet.name, fleet]]),
		mountedNames: new Set([fleet.name]),
		builtInNames: new Set([fleet.name]),
		isActive: () => false,
	};

	const { result } = await dispatchXdevTool(state, "fleet", '{"op":"send","iD":"Main"}', "t2");
	expect(result.isError).toBe(true);
	const text = result.content.map(block => ("text" in block ? block.text : "")).join("\n");
	expect(text).toContain("unknown top-level key: iD");
	expect(text).toContain("did you mean `id`?");
});

test("normalized args validate against real fleet and monitor schemas", () => {
	// Execute never runs here; a bare session stub is enough to read `parameters` off the real tools.
	const stubSession = {} as ToolSession;
	const cases: Array<[string, Record<string, unknown>, { parameters: unknown }]> = [
		["fleet", { to: "Main", message: "done" }, new FleetTool(stubSession)],
		["fleet", { target: "rust-diff", message: "ping" }, new FleetTool(stubSession)],
		["monitor", { action: "start", command: "make", name: "build" }, new MonitorTool(stubSession)],
	];
	for (const [name, raw, tool] of cases) {
		const { args, notes } = normalizeXdDeviceArgs(name, structuredClone(raw));
		const schema = toolWireSchema(tool as never);
		const validated = validateToolArguments(tool as never, {
			type: "toolCall",
			id: "smoke",
			name,
			arguments: args,
		});
		expect(notes.length).toBeGreaterThan(0);
		expect(validated).toMatchObject(name === "fleet" ? { op: "send" } : { op: "start" });
		expect(schema).toBeDefined();
	}
});
