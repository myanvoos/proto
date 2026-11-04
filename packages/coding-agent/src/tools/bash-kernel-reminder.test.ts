import { expect, test } from "bun:test";
import type { AfterToolCallContext, Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { BUILTIN_RULE_SOURCES } from "../discovery/builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import { TtsrManager } from "../export/ttsr";
import type { SessionManager } from "../session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "../session/ttsr-coordinator";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const RULE_NAME = "py-kernel-routing";

async function remind(command: string, toolName = "bash") {
	const source = BUILTIN_RULE_SOURCES.find(entry => entry.name === RULE_NAME);
	if (!source) throw new Error(`Missing bundled rule: ${RULE_NAME}`);
	const virtualPath = `builtin-defaults:${RULE_NAME}.md`;
	const rule = buildRuleFromMarkdown(
		RULE_NAME,
		source.content,
		virtualPath,
		createSourceMeta("builtin-defaults", virtualPath, "user"),
		{ ruleName: RULE_NAME },
	);
	// The rule must remain advisory even when the global setting interrupts.
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "keep",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
	});
	manager.addRule(rule);
	const bash = new BashTool({ settings: { get: () => false } } as unknown as ToolSession);
	const events: string[][] = [];
	const persisted: string[][] = [];
	let aborts = 0;
	const host: TtsrCoordinatorHost = {
		agent: {
			state: { messages: [], tools: [bash] },
			abort: () => {
				aborts++;
			},
		} as unknown as Agent,
		sessionManager: {
			getCwd: () => "/repo",
			appendTtsrInjection: (names: string[]) => persisted.push(names),
		} as unknown as SessionManager,
		settings: {} as Settings,
		createJudge: () => {
			throw new Error("Shell routing must not need a model judge");
		},
		emitSessionEvent: async event => {
			if (event.type === "ttsr_triggered") events.push(event.rules.map(rule => rule.name));
		},
		schedulePostPromptTask: () => {
			throw new Error("Tool reminder must not schedule a follow-up");
		},
		scheduleAgentContinue: () => {
			throw new Error("Tool reminder must not restart the agent");
		},
		promptGeneration: () => 1,
	};
	const coordinator = new TtsrCoordinator(host, manager);
	const toolCall = { type: "toolCall", id: "python-call", name: toolName, arguments: { command } };
	const message = { role: "assistant", timestamp: 1, content: [toolCall] };
	const interrupted = await coordinator.checkMessageUpdate({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
	} as unknown as AgentEvent);
	// Nothing is persisted before delivery. Repeated matching must not queue another copy.
	expect(persisted).toEqual([]);
	await coordinator.checkMessageUpdate({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
	} as unknown as AgentEvent);
	const context = {
		toolCall,
		result: { content: [{ type: "text", text: "42" }] },
	} as unknown as AfterToolCallContext;
	const result = coordinator.afterToolCall(context);
	expect(coordinator.afterToolCall(context)).toBeUndefined();
	return { events, persisted, interrupted, aborts, result };
}

test.each([
	["ordinary native Python", "python3 -c 'print(42)'"],
	["environment-selected Python", "uv run python -c 'print(42)'"],
])("%s is not warned about fresh-process execution", async (_label, command) => {
	const observed = await remind(command);
	expect(observed.interrupted).toBe(false);
	expect(observed.aborts).toBe(0);
	expect(observed.events).toEqual([]);
	expect(observed.persisted).toEqual([]);
	expect(observed.result).toBeUndefined();
});
