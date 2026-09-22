import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type ToolCall } from "@oh-my-pi/pi-ai";
import { type SettingPath, Settings } from "../config/settings";
import { SessionManager } from "./session-manager";
import { LoopGuards, type StreamGuardsHost } from "./stream-guards";

// The defect was a provider storm: a tool call that keeps failing produced
// thousands of identical requests because the guard fired once and never again.
// Each case drives a real Agent against a local fake provider that always
// answers with the same tool call, and asserts the request count is bounded.
const PROVIDER_REQUEST_CEILING = 200;

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function loopingProvider(toolName: string, counter: { requests: number }): StreamFn {
	return (model: Model) => {
		counter.requests++;
		if (counter.requests > PROVIDER_REQUEST_CEILING) {
			throw new Error(`fake provider received ${counter.requests} requests: the loop is unbounded`);
		}
		const stream = createAssistantMessageEventStream();
		const timestamp = Date.now();
		const call: ToolCall = {
			type: "toolCall",
			id: `tc_${counter.requests}`,
			name: toolName,
			arguments: { path: "/tmp/nowhere" },
		};
		const message: AssistantMessage = {
			role: "assistant",
			content: [call],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp,
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		});
		return stream;
	};
}

const failingReadTool = {
	name: "read",
	label: "Read",
	description: "always fails",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	},
	execute: async () => ({ content: [{ type: "text", text: "read failed: no such file" }], isError: true }),
} as unknown as AgentTool;

interface RunOutcome {
	requests: number;
	steers: number;
	stops: number;
	lastStopDetails: Record<string, unknown> | undefined;
}

async function runLoop(toolName: string, overrides: Partial<Record<SettingPath, unknown>> = {}): Promise<RunOutcome> {
	const counter = { requests: 0 };
	const settings = Settings.isolated({
		"model.toolCallLoopGuard.enabled": true,
		"model.toolCallLoopGuard.threshold": 3,
		"model.toolCallLoopGuard.hardLimit": 8,
		...overrides,
	});
	const sessionManager = SessionManager.inMemory(process.cwd());
	const agent = new Agent({ streamFn: loopingProvider(toolName, counter) });
	agent.setTools([failingReadTool]);
	const notices: string[] = [];
	const host: StreamGuardsHost = {
		agent,
		settings,
		sessionManager,
		model: () => undefined,
		getToolByName: name => (name === "read" ? failingReadTool : undefined),
		canObserveStreamedKernelInput: () => false,
		isDisposed: () => false,
		promptGeneration: () => 0,
		emitNotice: (_level, message) => notices.push(message),
		schedulePostPromptTask: () => {},
		discardAssistantTurn: () => {},
	};
	const guards = new LoopGuards(host);
	agent.setOnTurnEnd(async (messages, _signal, context) => {
		guards.recordTurn(messages, context);
	});
	await agent.prompt("start the loop");
	await agent.waitForIdle();

	const entries = sessionManager.getEntries();
	const custom = entries.filter(
		(entry): entry is typeof entry & { customType: string; details?: Record<string, unknown> } =>
			entry.type === "custom_message",
	);
	const stops = custom.filter(entry => entry.customType === "tool-call-loop-stop");
	return {
		requests: counter.requests,
		steers: custom.filter(entry => entry.customType === "tool-call-loop-redirect").length,
		stops: stops.length,
		lastStopDetails: stops.at(-1)?.details,
	};
}

test("a failing tool call repeated by the provider is stopped at the hard limit", async () => {
	const outcome = await runLoop("read");

	expect(outcome.requests).toBeLessThanOrEqual(10);
	expect(outcome.stops).toBe(1);
	expect(outcome.steers).toBeGreaterThan(1);
}, 60_000);

test("an unknown tool name is guarded exactly like a known one", async () => {
	const outcome = await runLoop("nonexistent_tool");

	expect(outcome.requests).toBeLessThanOrEqual(10);
	expect(outcome.stops).toBe(1);
	expect(outcome.steers).toBeGreaterThan(1);
	expect(outcome.lastStopDetails?.toolName).toBe("nonexistent_tool");
}, 60_000);

test("the steer keeps firing on every repeat past the threshold", async () => {
	const outcome = await runLoop("read", { "model.toolCallLoopGuard.hardLimit": 12 });

	// threshold 3, ceiling 12: repeats 3..11 steer, repeat 12 stops.
	expect(outcome.steers).toBe(9);
	expect(outcome.stops).toBe(1);
	expect(outcome.requests).toBeLessThanOrEqual(14);
}, 60_000);

test("the ceiling can be disabled without bringing back the unbounded storm", async () => {
	// With no ceiling the run is only bounded by the provider fixture, so this
	// documents that disabling it is a deliberate, still-steered choice.
	const outcome = await runLoop("read", { "model.toolCallLoopGuard.hardLimit": 0 });

	expect(outcome.stops).toBe(0);
	expect(outcome.steers).toBeGreaterThan(50);
	expect(outcome.requests).toBeGreaterThan(50);
}, 120_000);

test("a real headless run against a looping provider stops after a bounded number of requests", async () => {
	let providerRequests = 0;
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => {
			providerRequests++;
			const call = {
				index: 0,
				id: `call_${providerRequests}`,
				type: "function",
				function: { name: "read", arguments: JSON.stringify({ path: "/tmp/nowhere-loop" }) },
			};
			const frames = [
				{ choices: [{ delta: { role: "assistant", tool_calls: [call] } }] },
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			];
			const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const port = provider.port;
	if (typeof port !== "number") throw new Error("looping provider did not bind a port");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-loop-storm-"));
	roots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "work");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  loopp:",
			`    baseUrl: http://127.0.0.1:${port}/v1`,
			"    apiKey: test-key",
			"    api: openai-completions",
			"    models:",
			"      - id: mloop",
			'        name: "mloop"',
			"        contextWindow: 16384",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);

	try {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				path.resolve(import.meta.dir, "..", "cli.ts"),
				"--cwd",
				cwd,
				"--no-session",
				"--no-extensions",
				"--no-title",
				"--tools",
				"read",
				"--model",
				"loopp/mloop",
				"-p",
				"loop please",
			],
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				PI_CODING_AGENT_DIR: agentDir,
				TERM: "dumb",
				NO_COLOR: "1",
			},
		});
		const stderr = new Response(child.stderr).text();
		const exitCode = await Promise.race([child.exited, Bun.sleep(90_000).then(() => -1)]);
		if (exitCode === -1) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error("the headless run never stopped: the loop is unbounded");
		}

		expect(exitCode).toBe(1);
		expect(await stderr).toContain("Tool-call loop guard");
		// Default threshold 5, hard limit 20: the ceiling is what bounds the spend.
		expect(providerRequests).toBeLessThanOrEqual(22);
	} finally {
		provider.stop(true);
	}
}, 120_000);
