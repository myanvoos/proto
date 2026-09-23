import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import type { AgentSessionEvent } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

function reply(model: Model, content: AssistantMessage["content"]) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

// A capped empty stop still ends with stopReason "stop". Built-in checklist reminders
// used to treat it as a normal yield and schedule another request, so the empty-response
// retry cap was silently extended by the reminder budget.
test("capped empty responses are not revived by pending checklist reminders", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-stop-reminder-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey("empty-stop-test", "test-key");
	let requests = 0;
	const streamFn: StreamFn = (model: Model) => {
		requests++;
		return requests <= 4 ? reply(model, []) : reply(model, [{ type: "text", text: "Which task should I resume?" }]);
	};
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		authStorage,
		sessionManager: SessionManager.inMemory(process.cwd()),
		settings: Settings.isolated({
			"checklist.enabled": true,
			"checklist.reminders": true,
			"checklist.remindersMax": 3,
		}),
		toolNames: ["checklist"],
		restrictToolNames: true,
		streamFn,
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
	try {
		session.agent.setModel(
			buildModel({
				id: "empty-stop-test",
				name: "Empty Stop Test",
				api: "openai-responses",
				provider: "empty-stop-test",
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		session.agent.getApiKey = () => "test";
		session.setChecklistPhases([
			{ name: "Work", tasks: [{ content: "Finish the pending change", status: "in_progress" }] },
		]);
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const reminders: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "checklist_reminder") reminders.push(event);
		});

		await session.prompt("continue the pending task");
		await session.waitForIdle();

		// One request plus three empty-stop retries, then the cap ends the turn.
		expect(requests).toBe(4);
		expect(retryEnds).toEqual([expect.objectContaining({ success: false, attempt: 3 })]);
		expect(reminders).toEqual([]);

		await session.prompt("I am ready to resume");
		await session.waitForIdle();
		expect(requests).toBe(5);
	} finally {
		await session.dispose();
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 60_000);
