import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import type { ToolSession } from ".";
import {
	dispatchProtolensArgv,
	dispatchProtolensTarget,
	dispatchXdevTool,
	parseProtolensBashCommand,
	resolveMountedXdevExecutable,
	type XdevState,
	xdevDocs,
} from "./xdev";

test("protolens resolution forwards cancellation before a pending action applies", async () => {
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	let seenSignal: AbortSignal | undefined;
	let seenInvokerSignal: AbortSignal | undefined;
	let sideEffectRan = false;
	const session = {
		cwd: process.cwd(),
		peekPendingInvoker: () => async (input: unknown, invokerSignal?: AbortSignal) => {
			const invocation = input as { signal?: AbortSignal };
			seenSignal = invocation.signal;
			seenInvokerSignal = invokerSignal;
			started.resolve();
			await new Promise<void>((resolve, reject) => {
				if (!invocation.signal) {
					resolve();
					return;
				}
				if (invocation.signal.aborted) {
					reject(new Error("aborted before apply"));
					return;
				}
				invocation.signal.addEventListener("abort", () => reject(new Error("aborted during apply")), {
					once: true,
				});
			});
			sideEffectRan = true;
			return { content: [{ type: "text" as const, text: "applied\n" }] };
		},
	} as unknown as ToolSession;

	const pending = dispatchProtolensTarget(session, "resolve", "apply this", {
		toolCallId: "resolve-cancel",
		signal: controller.signal,
	});
	await started.promise;
	controller.abort();

	await expect(pending).rejects.toThrow("aborted during apply");
	expect(seenSignal).toBe(controller.signal);
	expect(seenInvokerSignal).toBe(controller.signal);
	expect(sideEffectRan).toBe(false);
});

function probeState(seen: { args?: Record<string, unknown> }): XdevState {
	const probe = {
		name: "probe",
		label: "Probe",
		description: "probe device",
		parameters: type({ target: type("string > 0").describe("thing to probe") }),
		execute: async (_id: string, args: Record<string, unknown>) => {
			seen.args = args;
			return { content: [{ type: "text" as const, text: "probed\n" }] };
		},
	} as unknown as AiTool;
	return {
		tools: new Map([["probe", probe as never]]),
		mountedNames: new Set(["probe"]),
		builtInNames: new Set(["probe"]),
		isActive: () => true,
	};
}

test("devices accept the documented intent field and drop it before execution", async () => {
	const seen: { args?: Record<string, unknown> } = {};
	const { result } = await dispatchXdevTool(
		probeState(seen),
		"probe",
		JSON.stringify({ target: "disk", i: "Probing disk" }),
		"protolens-intent",
	);

	expect(result.isError).toBeFalsy();
	expect(seen.args).toEqual({ target: "disk" });
});

test("device validation states the constraint and the offending value", async () => {
	await expect(
		dispatchXdevTool(probeState({}), "probe", JSON.stringify({ target: "" }), "protolens-invalid"),
	).rejects.toThrow(/target must be at least length 1 \(was ""\)/);
});

test("a direct device call resolves whether the name is bare or carries the advertised protolens:// prefix", () => {
	const state = probeState({});
	const probe = state.tools.get("probe");
	expect(resolveMountedXdevExecutable(state, "probe")).toBe(probe);
	expect(resolveMountedXdevExecutable(state, "protolens://probe")).toBe(probe);
	expect(resolveMountedXdevExecutable(state, "protolens://missing")).toBeUndefined();
	expect(resolveMountedXdevExecutable(state, "xd://probe")).toBeUndefined();
	expect(resolveMountedXdevExecutable(state, "proto://probe")).toBeUndefined();
});

test("MCP device docs advertise only the JSON forms the parser accepts", async () => {
	const name = "mcp__srv_run_command";
	const mcpTool = {
		name,
		label: "Run command",
		description: "run a command",
		parameters: type({ command: "string", machine: "string", "timeout?": "number" }),
		execute: async () => ({ content: [] }),
	} as unknown as AiTool;
	const xdev: XdevState = {
		tools: new Map([[name, mcpTool as never]]),
		mountedNames: new Set([name]),
		builtInNames: new Set(),
		isActive: () => true,
	};
	const session = { cwd: process.cwd(), xdev } as unknown as ToolSession;
	const help = await dispatchProtolensArgv(session, name, ["?"], undefined, undefined, { toolCallId: "mcp-help" });
	const helpText = help.content.map(part => (part.type === "text" ? part.text : "")).join("");

	for (const docs of [helpText, xdevDocs(xdev, name)]) {
		expect(docs).toContain(`protolens ${name} --json '<json>'`);
		expect(docs).not.toContain("<command>");
		expect(docs).not.toContain("--machine");
	}
	await expect(
		dispatchProtolensArgv(session, name, ["ls", "box"], undefined, undefined, { toolCallId: "mcp-positional" }),
	).rejects.toThrow(/MCP devices take a single JSON args object/);
});

test("bare protolens help flags list devices instead of dispatching a tool named --help", () => {
	for (const flag of ["--help", "-h", "?", "help"]) {
		expect(parseProtolensBashCommand(["protolens", flag])).toEqual({ kind: "listing" });
	}
	expect(parseProtolensBashCommand(["protolens", "jobs", "--help"])).toEqual({
		kind: "device",
		name: "jobs",
		argv: ["--help"],
	});
});
