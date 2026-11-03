import { afterEach, expect, test, vi } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession, type AgentSessionEvent } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

afterEach(() => vi.restoreAllMocks());

async function testSession(stream: StreamFn) {
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), systemPrompt: ["Test"], tools: [] },
			streamFn: stream,
		}),
		sideStreamFn: stream,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "images.autoResize": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	return { session, auth };
}

test("ephemeral side questions send attached images to the model without appending them to the main conversation", async () => {
	let last: Message | undefined;
	const mock = createMockModel({
		handler: context => {
			last = context.messages.at(-1);
			return { content: ["image reply"] };
		},
	});
	const { session, auth } = await testSession(mock.stream);
	try {
		await session.runEphemeralTurn({
			promptText: "Describe this",
			promptImages: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT2kAAAAASUVORK5CYII=",
				},
			],
		});
		expect(last?.role).toBe("user");
		const content = last?.content;
		expect(Array.isArray(content) && content.some(block => block.type === "image")).toBe(true);
		expect(session.messages).toEqual([]);
	} finally {
		await session.dispose();
		auth.close();
	}
});

test("manual compaction reports a matched start and skipped end when the session is too small", async () => {
	const mock = createMockModel({ responses: [{ content: ["unused"] }] });
	const { session, auth } = await testSession(mock.stream);
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => {
		events.push(event);
	});
	try {
		await expect(session.compact()).rejects.toThrow("Nothing to compact");
		expect(events.filter(event => event.type.startsWith("manual_compaction"))).toMatchObject([
			{ type: "manual_compaction_start" },
			{
				type: "manual_compaction_end",
				aborted: false,
				skipped: true,
				errorMessage: expect.stringContaining("Nothing to compact"),
			},
		]);
	} finally {
		await session.dispose();
		auth.close();
	}
});
