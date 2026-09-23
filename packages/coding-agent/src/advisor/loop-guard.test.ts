/**
 * Advisors drive a private Agent loop that never passed through the primary's tool-call loop guard, so an advisor could
 * reissue one failing call without bound. The advisor loop now gets one corrective and is stopped if it ignores it.
 */
import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Context, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

const failingReadTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Mock read tool",
	parameters: type({ "path?": "string" }),
	execute: async () => ({
		content: [{ type: "text" as const, text: "ENOENT: no such file or directory" }],
		isError: true,
	}),
};

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

/** A live advisor (built through the real advisor path) whose stream repeats one failing call, ignoring correctives. */
async function createAdvisor(guardSettings: Record<string, unknown>, maxRepeatedTurns: number) {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] });
	const advisorMock = createMockModel({ provider: "anthropic" });
	const contexts: Context[] = [];
	const advisorStreamFn: typeof advisorMock.stream = (_model, context) => {
		contexts.push(context);
		const repeating = contexts.length <= maxRepeatedTurns;
		const message: AssistantMessage = {
			role: "assistant",
			content: repeating
				? [{ type: "toolCall", id: `tc-${contexts.length}`, name: "read", arguments: { path: "missing.ts" } }]
				: [{ type: "text", text: "Stopped repeating." }],
			api: advisorMock.api,
			provider: advisorMock.provider,
			model: advisorMock.id,
			usage: zeroUsage,
			stopReason: repeating ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: repeating ? "toolUse" : "stop", message });
		});
		return stream;
	};
	const settings = Settings.isolated({ "advisor.syncBacklog": "1", "compaction.enabled": false, ...guardSettings });
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		advisorTools: [failingReadTool],
		advisorStreamFn,
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	expect(session.setAdvisorEnabled(true)).toBe(true);
	const advisor = session.getAdvisorAgent();
	if (!advisor) throw new Error("Expected advisor agent to be active");
	advisor.setModel(advisorMock);
	return { current: session, advisor, contexts };
}

it("redirects the advisor's repeated tool call once, then stops the update without a retryable error", async () => {
	const { current, advisor, contexts } = await createAdvisor(
		{ "model.toolCallLoopGuard.enabled": true, "model.toolCallLoopGuard.threshold": 3 },
		20,
	);

	await current.prompt("review the current update");
	expect(await current.waitForAdvisorCatchup(2_000)).toBe(true);

	expect(contexts.length).toBeLessThan(20);
	expect(JSON.stringify(contexts[3]?.messages)).toContain("You called `read` 3 consecutive times");
	const redirects = advisor.state.messages.filter(
		message => message.role === "user" && JSON.stringify(message.content).includes("tool_call_loop_detected"),
	);
	expect(redirects).toHaveLength(1);
	expect(advisor.state.error).toBeUndefined();
});

it("leaves the advisor loop unbounded by the guard when it is disabled", async () => {
	const { current, contexts } = await createAdvisor({ "model.toolCallLoopGuard.enabled": false }, 8);

	await current.prompt("review the current update");
	expect(await current.waitForAdvisorCatchup(2_000)).toBe(true);

	expect(contexts).toHaveLength(9);
});
