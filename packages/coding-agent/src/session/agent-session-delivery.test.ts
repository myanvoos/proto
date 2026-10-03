import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { convertToLlm } from "./messages";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

async function createSession(responses: MockResponseSource = [], tools: AgentTool[] = []) {
	authStorage = await AuthStorage.create(":memory:");
	const mock = createMockModel({ responses });
	authStorage.setRuntimeApiKey(mock.provider, "test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "checklist.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	return { session, mock };
}

it("paints an idle displayable custom message exactly once without starting a provider turn", async () => {
	const { session, mock } = await createSession();
	const events: string[] = [];
	session.subscribe(event => events.push(event.type));
	const started = await session.sendCustomMessage({ customType: "notice", content: "ready", display: true });
	expect(started).toBe(false);
	expect(events.filter(event => event === "message_start" || event === "message_end")).toEqual([
		"message_start",
		"message_end",
	]);
	expect(events).not.toContain("agent_start");
	expect(mock.calls).toHaveLength(0);
	expect(
		session.messages.filter(message => message.role === "custom" && message.customType === "notice"),
	).toHaveLength(1);
	expect(
		session.sessionManager
			.buildSessionContext()
			.messages.filter(message => message.role === "custom" && message.customType === "notice"),
	).toHaveLength(1);
});

it("keeps completed sibling tool calls paired with their results after a batched rewind", async () => {
	const schema = type({ text: "string" });
	const tools: AgentTool[] = ["checkpoint", "rewind", "inspect"].map(name => ({
		name,
		label: name,
		description: name,
		parameters: schema,
		async execute() {
			return {
				content: [{ type: "text" as const, text: name === "inspect" ? "completed inspection" : name }],
				details:
					name === "checkpoint"
						? { startedAt: "2026-01-01T00:00:00.000Z" }
						: name === "rewind"
							? { report: "finished" }
							: undefined,
			};
		},
	}));
	const { session, mock } = await createSession(
		[
			{
				content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { text: "start" } }],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "toolCall", id: "rewind", name: "rewind", arguments: { text: "finished" } },
					{ type: "toolCall", id: "inspect", name: "inspect", arguments: { text: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{ content: ["Done"] },
		],
		tools,
	);
	await session.prompt("Investigate");
	await session.waitForIdle();
	for (const messages of [
		mock.calls[2]?.context.messages ?? [],
		session.sessionManager.buildSessionContext().messages,
	]) {
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.toolCallId === "inspect" &&
					message.content.some(part => part.type === "text" && part.text === "completed inspection"),
			),
		).toBe(true);
		expect(
			messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(part => part.type === "toolCall" && part.id === "inspect"),
			),
		).toBe(true);
		expect(messages.some(message => message.role === "toolResult" && message.toolCallId === "rewind")).toBe(false);
	}
});

it("queue editing leaves agent-attributed user-role notices out of the editor", async () => {
	const { session } = await createSession();
	session.agent.followUp({
		role: "user",
		content: [{ type: "text", text: "tool notice" }],
		attribution: "agent",
		timestamp: 1,
	});
	session.agent.followUp({
		role: "user",
		content: [{ type: "text", text: "user draft" }],
		attribution: "user",
		timestamp: 2,
	});
	expect(session.getQueuedMessages().followUp).toEqual(["user draft"]);
	expect(session.popLastQueuedMessage()?.text).toBe("user draft");
	expect(session.peekLastQueuedMessage()).toBeUndefined();
	expect(session.clearQueue().followUp).toEqual([]);
	expect(session.agent.peekFollowUpQueue()).toHaveLength(1);
});
