import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import { AcpAgent } from "./acp-agent";

let tmpDir: string;
let cwd: string;
let originalAgentDir: string;
let originalAgentDirEnv: string | undefined;

// ACP stores and looks up sessions under the agent dir; point it at a scratch one.
beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-content-replay-"));
	cwd = path.join(tmpDir, "work");
	await fs.mkdir(cwd, { recursive: true });
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	setAgentDir(path.join(tmpDir, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	await fs.rm(tmpDir, { recursive: true, force: true });
});

interface AcpHarness {
	acp: AcpAgent;
	updates: SessionNotification[];
	sessions: AgentSession[];
	dispose(): Promise<void>;
}

async function startAcp(): Promise<AcpHarness> {
	// The model stored sessions were recorded with; loading restores it. Nothing here calls it.
	const modelsFile = path.join(tmpDir, "models.yml");
	await Bun.write(
		modelsFile,
		[
			"providers:",
			"  probe:",
			"    baseUrl: http://127.0.0.1:9/v1",
			"    api: openai-completions",
			"    apiKey: sk-acp-content-replay",
			"    models:",
			"      - id: probe-model",
			"        name: probe-model",
			"        input: [text]",
			"        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}",
			"        contextWindow: 8192",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);
	const auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(auth, modelsFile, { settings });
	const updates: SessionNotification[] = [];
	const sessions: AgentSession[] = [];
	const connection = {
		signal: new AbortController().signal,
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		extNotification: async () => {},
	} as unknown as AgentSideConnection;
	const acp = new AcpAgent(connection, async sessionCwd => {
		const { session } = await createAgentSession({
			cwd: sessionCwd,
			agentDir: getAgentDir(),
			authStorage: auth,
			settings,
			modelRegistry,
			sessionManager: SessionManager.create(sessionCwd),
			toolNames: [],
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: { rootPath: sessionCwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		sessions.push(session);
		return session;
	});
	await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
	return {
		acp,
		updates,
		sessions,
		dispose: async () => {
			await acp.dispose();
			auth.close();
		},
	};
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-completions",
		provider: "probe",
		model: "probe-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function user(content: string, attribution: "user" | "agent" = "user"): UserMessage {
	return { role: "user", content: [{ type: "text", text: content }], attribution, timestamp: Date.now() };
}

/** Writes a stored session the way a finished conversation leaves it, and returns its id and file. */
async function storeSession(build: (manager: SessionManager) => void): Promise<{ id: string; file: string }> {
	const manager = SessionManager.create(cwd);
	build(manager);
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	const id = manager.getSessionId();
	await manager.close();
	return { id, file };
}

function chunkText(notification: SessionNotification): string {
	const { update } = notification;
	if (
		(update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") &&
		update.content.type === "text"
	) {
		return update.content.text;
	}
	return "";
}

test("resource prompt blocks reach the model with the location the client gave, not only a name", async () => {
	const harness = await startAcp();
	try {
		const { sessionId } = await harness.acp.newSession({ cwd, mcpServers: [] });
		const prompts: Array<{ text: string; images: ImageContent[] | undefined }> = [];
		spyOn(harness.sessions[0]!, "prompt").mockImplementation(async (text, options) => {
			prompts.push({ text, images: options?.images });
			return false;
		});
		const png = "iVBORw0KGgo=";
		const response = await harness.acp.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "Compare these" },
				{
					type: "resource_link",
					uri: "file:///home/user/My%20Project/src/main.rs",
					name: "main.rs",
					title: "Entry point",
				},
				{ type: "resource_link", uri: "https://example.com/spec.html?v=2", name: "spec.html" },
				{
					type: "resource",
					resource: { uri: "file:///home/user/My%20Project/src/lib.rs#L3:4", text: "fn shared() {}" },
				},
				{ type: "resource", resource: { uri: "file:///home/user/shot.png", blob: png, mimeType: "image/png" } },
			],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(prompts).toHaveLength(1);
		const [{ text, images }] = prompts;
		// A file link is the decoded absolute path the model's tools open, under the client's label.
		expect(text).toContain("/home/user/My Project/src/main.rs");
		expect(text).toContain("Entry point");
		// Any other scheme keeps its URI.
		expect(text).toContain("https://example.com/spec.html?v=2");
		// Embedded text is attributed to its file, selection fragment included, so an excerpt is not read as the file.
		const excerptAt = text.indexOf("/home/user/My Project/src/lib.rs#L3:4");
		expect(excerptAt).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("fn shared() {}")).toBeGreaterThan(excerptAt);
		// An embedded image still arrives as an image, and the model learns which file it is.
		expect(images).toEqual([{ type: "image", data: png, mimeType: "image/png" }]);
		expect(text).toContain("/home/user/shot.png");
	} finally {
		await harness.dispose();
	}
});

test("session/load replays the visible conversation, compacted history included, without injected context", async () => {
	const stored = await storeSession(manager => {
		manager.appendMessage(user("FIRST-QUESTION"));
		manager.appendMessage(assistant("FIRST-ANSWER"));
		const kept = manager.appendMessage({ role: "user", content: "SECOND-QUESTION", timestamp: Date.now() });
		manager.appendMessage(assistant("SECOND-ANSWER"));
		manager.appendCompaction("COMPACTION-SUMMARY", "compacted", kept, 1000);
		manager.appendMessage({
			role: "developer",
			content: [{ type: "text", text: "DEVELOPER-CONTEXT" }],
			timestamp: Date.now(),
		});
		manager.appendCustomMessageEntry(
			"goal-reminder",
			[{ type: "text", text: "HIDDEN-CUSTOM" }],
			false,
			undefined,
			"agent",
		);
		manager.appendCustomMessageEntry(
			"async-result",
			[{ type: "text", text: "AGENT-NOTICE" }],
			true,
			undefined,
			"agent",
		);
		manager.appendMessage({
			role: "hookMessage",
			customType: "hook",
			content: [{ type: "text", text: "HOOK-TEXT" }],
			display: true,
			timestamp: Date.now(),
		});
		manager.appendCustomMessageEntry(
			"skill-prompt",
			"SKILL-BODY",
			true,
			{ name: "review", path: "/skills/review/SKILL.md", args: "pr 12", lineCount: 1 },
			"user",
		);
		manager.appendMessage(assistant("SKILL-ANSWER"));
		manager.appendMessage(user("AGENT-SIDE-PROMPT", "agent"));
		manager.appendMessage(
			assistant("", {
				stopReason: "error",
				errorMessage: "RETRY-ERROR",
				retryRecovery: { kind: "auto-retry", status: "superseded", attempt: 1, recovery: "plain", note: "retried" },
			}),
		);
		manager.appendMessage(user("THIRD-QUESTION"));
		manager.appendMessage(assistant("THIRD-ANSWER"));
		manager.appendMessage(user("FOURTH-QUESTION"));
		manager.appendMessage(assistant("", { stopReason: "aborted", errorMessage: "Interrupted by user" }));
	});

	const harness = await startAcp();
	try {
		await harness.acp.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		const conversation = harness.updates
			.filter(
				notification =>
					notification.update.sessionUpdate === "user_message_chunk" ||
					notification.update.sessionUpdate === "agent_message_chunk",
			)
			.map(notification => `${notification.update.sessionUpdate}: ${chunkText(notification)}`);

		expect(conversation).toEqual([
			"user_message_chunk: FIRST-QUESTION",
			"agent_message_chunk: FIRST-ANSWER",
			"user_message_chunk: SECOND-QUESTION",
			"agent_message_chunk: SECOND-ANSWER",
			"user_message_chunk: /skill:review pr 12",
			"agent_message_chunk: SKILL-ANSWER",
			"user_message_chunk: THIRD-QUESTION",
			"agent_message_chunk: THIRD-ANSWER",
			"user_message_chunk: FOURTH-QUESTION",
		]);
	} finally {
		await harness.dispose();
	}
});
