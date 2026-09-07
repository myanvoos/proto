import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { MONITOR_EVENT_MESSAGE_TYPE } from "./monitor-event";
import { SessionManager } from "./session-manager";

const TEST_TIMESTAMP = 1_700_000_000_000;

interface Harness {
	session: AgentSession;
	authStorage: AuthStorage;
	agentDir: string;
}

function stubAnswer(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ack" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: TEST_TIMESTAMP,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function createHarness(): Promise<Harness> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-wake-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	try {
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir,
			authStorage,
			sessionManager: SessionManager.inMemory(process.cwd()),
			disableExtensionDiscovery: true,
			enableMCP: false,
			skipPythonPreflight: true,
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
				id: "monitor-wake-test",
				name: "Monitor Wake Test",
				api: "openai-responses",
				provider: "monitor-wake-test",
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		session.agent.getApiKey = () => "test";
		return { session, authStorage, agentDir };
	} catch (error) {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

async function closeHarness(harness: Harness): Promise<void> {
	await harness.session.dispose();
	harness.authStorage.close();
	await fs.rm(harness.agentDir, { recursive: true, force: true });
}

test("a monitor event wakes an idle session and starts a turn carrying the event", async () => {
	const harness = await createHarness();
	const turnStarted = Promise.withResolvers<void>();
	try {
		harness.session.agent.streamFn = () => {
			turnStarted.resolve();
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: stubAnswer() }));
			return stream;
		};

		const monitor = harness.session.monitorManager.start({
			command: "printf 'warming up\\nDEPLOY OK\\n'",
			label: "deploy",
			match: "DEPLOY",
		});
		expect(harness.session.hasActiveMonitors()).toBe(true);

		await Promise.race([
			turnStarted.promise,
			Bun.sleep(15_000).then(() => {
				throw new Error("Monitor event never woke the session");
			}),
		]);
		await harness.session.waitForIdle();

		const delivered = harness.session.agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType === MONITOR_EVENT_MESSAGE_TYPE
				? [typeof message.content === "string" ? message.content : ""]
				: [],
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("DEPLOY OK");
		expect(delivered[0]).toContain(monitor.id);
		expect(delivered[0]).not.toContain("warming up");
	} finally {
		await closeHarness(harness);
	}
}, 30_000);

test("the registered monitor tool starts a monitor that wakes the session", async () => {
	const harness = await createHarness();
	const turnStarted = Promise.withResolvers<void>();
	try {
		harness.session.agent.streamFn = () => {
			turnStarted.resolve();
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: stubAnswer() }));
			return stream;
		};

		const tool = harness.session.getToolByName("monitor");
		expect(tool).toBeDefined();

		const started = await tool!.execute("call-1", {
			op: "start",
			command: "printf 'noise\\nREADY on port 4000\\n'",
			label: "dev server",
			match: "READY",
		});
		expect(started.isError).toBeUndefined();
		expect(harness.session.hasActiveMonitors()).toBe(true);

		await Promise.race([
			turnStarted.promise,
			Bun.sleep(15_000).then(() => {
				throw new Error("Monitor event never woke the session");
			}),
		]);
		await harness.session.waitForIdle();

		const delivered = harness.session.agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType === MONITOR_EVENT_MESSAGE_TYPE
				? [typeof message.content === "string" ? message.content : ""]
				: [],
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("READY on port 4000");
		expect(delivered[0]).not.toContain("noise");

		const listed = await tool!.execute("call-2", { op: "list" });
		expect(listed.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain("dev server");
	} finally {
		await closeHarness(harness);
	}
}, 30_000);
test("disposing the session stops its monitors", async () => {
	const harness = await createHarness();
	harness.session.agent.streamFn = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: stubAnswer() }));
		return stream;
	};
	const manager = harness.session.monitorManager;
	manager.start({ command: "while true; do echo tick; sleep 0.05; done", maxEvents: 1_000 });
	expect(manager.hasActive()).toBe(true);

	await closeHarness(harness);

	expect(manager.hasActive()).toBe(false);
	expect(manager.list()).toEqual([]);
}, 30_000);
