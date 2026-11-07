import { afterEach, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { attachWakeTurnMonitor, softRequestBudgetFor } from "./executor";

afterEach(() => {
	vi.restoreAllMocks();
});

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
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

interface WakeHarness {
	session: AgentSession;
	/** Emit one assistant completion, which counts as one request for the budget. */
	completeRequest: (text: string) => void;
	/** Steer notices the wake turn sent to the session. */
	steered: Array<{ content: string; options?: unknown }>;
	/** Start a wake turn and return the callback that finishes it. */
	start: () => (error?: unknown) => void | Promise<void>;
}

function createWakeHarness(): WakeHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const steered: Array<{ content: string; options?: unknown }> = [];
	let wakeObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
	const session = {
		sessionManager: { getSubagentUsage: () => emptySubagentUsageTotals() },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		holdIrcWakes: () => () => {},
		setWakeTurnObserver: (observer: typeof wakeObserver) => {
			wakeObserver = observer;
		},
		getLastAssistantMessage: () => undefined,
		getToolByName: () => undefined,
		sendUserMessage: (content: string, options?: unknown) => {
			steered.push({ content, options });
			return Promise.resolve();
		},
	} as unknown as AgentSession;
	return {
		session,
		steered,
		completeRequest: text => {
			const message = assistant(text);
			for (const listener of [...listeners]) listener({ type: "message_end", message } as AgentSessionEvent);
		},
		start: () => {
			const finish = wakeObserver?.([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "wake up and work",
					display: true,
					timestamp: 1,
				},
			] as CustomMessage[]);
			if (!finish) throw new Error("Expected a wake turn observer");
			return finish;
		},
	};
}

// Every run, wake, revival and follow-up turn resolves the guard through this helper, so an
// agent-scoped budget must win over the session default and the notice switch must be honored.
test("resolves the per-agent soft budget and notice from settings", () => {
	const settings = Settings.isolated({
		"orchestrator.softRequestBudget": 200,
		"orchestrator.agentSoftRequestBudget": { scout: 300 },
		"orchestrator.softRequestBudgetNotice": false,
	});
	expect(softRequestBudgetFor("scout", settings)).toEqual({ softRequestBudget: 300, softRequestBudgetNotice: false });
	expect(softRequestBudgetFor("worker", settings)).toEqual({ softRequestBudget: 200, softRequestBudgetNotice: false });
});

// Regression: a subagent woken after parking ran its turn with a zero budget, so the guard never
// steered it toward yielding and it could spend an unbounded number of requests.
test("a woken subagent keeps its soft request budget and is steered at the limit", async () => {
	const harness = createWakeHarness();
	attachWakeTurnMonitor(harness.session, {
		id: "wake-budget",
		agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
		softRequestBudget: 1,
		softRequestBudgetNotice: true,
	});

	const finish = harness.start();
	harness.completeRequest("first request");
	await Promise.resolve();
	await Promise.resolve();

	expect(harness.steered).toHaveLength(1);
	expect(harness.steered[0]?.options).toEqual({ deliverAs: "steer", attribution: "agent" });
	await finish();
});

test("a woken subagent without a budget is not steered", async () => {
	const harness = createWakeHarness();
	attachWakeTurnMonitor(harness.session, {
		id: "wake-no-budget",
		agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
	});

	const finish = harness.start();
	harness.completeRequest("first request");
	await Promise.resolve();
	await Promise.resolve();

	expect(harness.steered).toEqual([]);
	await finish();
});
