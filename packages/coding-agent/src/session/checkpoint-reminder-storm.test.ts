import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type ToolCall } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

// A checkpoint the model never closes used to be an unbounded provider storm:
// every yield attempt appended another "active checkpoint" warning and scheduled
// another continue, measured at 831 requests from a single prompt. Each case runs a
// real session against a local fake provider and asserts the request count is bounded.
const PROVIDER_REQUEST_CEILING = 40;
const REMINDER_CAP = 3;

interface Harness {
	session: AgentSession;
	counter: { requests: number };
	notices: Array<{ level: string; message: string; source?: string }>;
	close: () => Promise<void>;
}

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

function pushMessage(model: Model, content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason,
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		const call = content.find((part): part is ToolCall => part.type === "toolCall");
		if (call) {
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		} else {
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "done looking", partial: message });
		}
		stream.push({ type: "done", reason: stopReason, message });
	});
	return stream;
}

/** Scripted calls run in order; every later request answers with plain text and no tool call. */
function scriptedProvider(
	script: Array<{ name: string; args: Record<string, unknown> }>,
	counter: { requests: number },
): StreamFn {
	let next = 0;
	return (model: Model) => {
		counter.requests++;
		if (counter.requests > PROVIDER_REQUEST_CEILING) {
			throw new Error(`fake provider received ${counter.requests} requests: the checkpoint loop is unbounded`);
		}
		const step = script[next];
		if (step) {
			next++;
			const call: ToolCall = {
				type: "toolCall",
				id: `tc_${counter.requests}`,
				name: step.name,
				arguments: step.args,
			};
			return pushMessage(model, [call], "toolUse");
		}
		return pushMessage(model, [{ type: "text", text: "done looking" }], "stop");
	};
}

async function createHarness(script: Array<{ name: string; args: Record<string, unknown> }>): Promise<Harness> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-storm-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("checkpoint-storm-test", "test-key");
	const counter = { requests: 0 };
	try {
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir,
			authStorage,
			sessionManager: SessionManager.inMemory(process.cwd()),
			settings: Settings.isolated({ "checkpoint.enabled": true }),
			toolNames: ["checkpoint", "rewind"],
			restrictToolNames: true,
			streamFn: scriptedProvider(script, counter),
			disableExtensionDiscovery: true,
			enableMCP: false,
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			extensions: [],
		});
		session.agent.setModel(
			buildModel({
				id: "checkpoint-storm-test",
				name: "Checkpoint Storm Test",
				api: "openai-responses",
				provider: "checkpoint-storm-test",
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		session.agent.getApiKey = () => "test";
		const notices: Array<{ level: string; message: string; source?: string }> = [];
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
		return {
			session,
			counter,
			notices,
			close: async () => {
				await session.dispose();
				authStorage.close();
				await fs.rm(agentDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

function reminderCount(session: AgentSession): number {
	return session.agent.state.messages.filter(message => {
		if (message.role !== "developer") return false;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return text.includes("active checkpoint");
	}).length;
}

test("a checkpoint the model never closes stops after a bounded number of reminders", async () => {
	const harness = await createHarness([{ name: "checkpoint", args: { goal: "storm repro" } }]);
	try {
		await harness.session.prompt("investigate the bug");
		await harness.session.waitForIdle();

		// 1 checkpoint call + 1 answer + one request per reminder, then the turn ends.
		expect(harness.counter.requests).toBe(2 + REMINDER_CAP);
		expect(reminderCount(harness.session)).toBe(REMINDER_CAP);
		expect(harness.session.isStreaming).toBe(false);

		const warning = harness.notices.find(notice => notice.source === "checkpoint");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("rewind");
		// The checkpoint is still open: giving up on reminders must not silently discard it.
		expect(harness.session.getCheckpointState()).toBeDefined();
	} finally {
		await harness.close();
	}
}, 60_000);

test("a new user turn re-arms the reminder budget instead of extending the old one", async () => {
	const harness = await createHarness([{ name: "checkpoint", args: { goal: "storm repro" } }]);
	try {
		await harness.session.prompt("investigate the bug");
		await harness.session.waitForIdle();
		const afterFirst = harness.counter.requests;

		await harness.session.prompt("any progress?");
		await harness.session.waitForIdle();

		// The second turn gets its own bounded budget: one answer plus the reminders.
		expect(harness.counter.requests - afterFirst).toBe(1 + REMINDER_CAP);
		expect(harness.notices.filter(notice => notice.source === "checkpoint")).toHaveLength(2);
	} finally {
		await harness.close();
	}
}, 60_000);

test("a checkpoint closed by rewind produces no reminders and no warning", async () => {
	const harness = await createHarness([
		{ name: "checkpoint", args: { goal: "storm repro" } },
		{ name: "rewind", args: { report: "found the bug in the parser" } },
	]);
	try {
		await harness.session.prompt("investigate the bug");
		await harness.session.waitForIdle();

		expect(harness.counter.requests).toBe(3);
		expect(reminderCount(harness.session)).toBe(0);
		expect(harness.notices.filter(notice => notice.source === "checkpoint")).toHaveLength(0);
		expect(harness.session.getCheckpointState()).toBeUndefined();
	} finally {
		await harness.close();
	}
}, 60_000);
