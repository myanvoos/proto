import { expect, test } from "bun:test";
import type { AfterToolCallContext, Agent, AgentEvent, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Rule } from "../capability/rule";
import type { Settings } from "../config/settings";
import { createSourceMeta } from "../discovery/helpers";
import { TtsrManager } from "../export/ttsr";
import type { JudgeFn } from "../export/ttsr-matcher";
import type { SessionManager } from "./session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "./ttsr-coordinator";

const RULE: Rule = {
	name: "no-any",
	path: "rules/no-any.md",
	content: "Never use `as any`.",
	interruptMode: "never",
	// Matches through the regex pass and again through the AST pass.
	match: { any: [{ regex: "\\bas any\\b" }, { ast: "$X as any" }] },
	_source: createSourceMeta("native", "rules/no-any.md", "project"),
};

const SOURCE = "const bad = value as any;";

interface Harness {
	coordinator: TtsrCoordinator;
	events: string[][];
	persisted: string[][];
	asked: string[];
	/** The session transcript the coordinator reads `did:` history from. */
	messages: unknown[];
	/** Swap the transcript the way compaction, pruning, and rewinds do. */
	rewrite: (next: readonly unknown[]) => void;
}

function harness(rules: readonly Rule[] = [RULE], verdict = true, digest = SOURCE, judgeFn?: JudgeFn): Harness {
	const manager = new TtsrManager();
	for (const rule of rules) expect(manager.addRule(rule)).toBe(true);
	const asked: string[] = [];
	const judge: JudgeFn =
		judgeFn ??
		(async request => {
			asked.push(request.question);
			return verdict;
		});
	const events: string[][] = [];
	const persisted: string[][] = [];
	const messages: unknown[] = [];
	const agent = {
		state: {
			messages,
			tools: [{ name: "bash", matcherEntries: () => [{ path: "a.ts", digest }] }],
		},
		abort: () => {},
	} as unknown as Agent;
	const sessionManager = {
		getCwd: () => "/repo",
		appendTtsrInjection: (names: string[]) => persisted.push(names),
	} as unknown as SessionManager;
	const host: TtsrCoordinatorHost = {
		agent,
		sessionManager,
		settings: {} as Settings,
		createJudge: () => judge,
		emitSessionEvent: async event => {
			if (event.type === "ttsr_triggered") events.push(event.rules.map(rule => rule.name));
		},
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 1,
	};
	const rewrite = (next: readonly unknown[]) => {
		(agent.state as { messages: unknown[] }).messages = [...next];
	};
	return { coordinator: new TtsrCoordinator(host, manager), events, persisted, asked, messages, rewrite };
}

function toolDelta(): AgentEvent {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "write" } }],
		},
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: SOURCE },
	} as unknown as AgentEvent;
}

test("a rule matched by both the regex and the ast pass notifies and injects once", async () => {
	const { coordinator, events, persisted } = harness();
	expect(await coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(events).toEqual([["no-any"]]);

	const result = coordinator.afterToolCall({
		toolCall: { id: "call-1", name: "bash", arguments: {} },
		result: { content: [{ type: "text", text: "tool output" }] },
	} as unknown as AfterToolCallContext);
	const blocks = result?.content ?? [];
	expect(blocks).toHaveLength(2);
	const reminder = blocks[0]!.type === "text" ? blocks[0].text : "";
	expect(reminder).toContain('rule="no-any"');
	expect(reminder).toContain("Never use `as any`.");
	expect(persisted).toEqual([["no-any"]]);
});

test("the tool reminder quotes the line that tripped the rule", async () => {
	const { coordinator } = harness();
	await coordinator.checkMessageUpdate(toolDelta());
	const result = coordinator.afterToolCall({
		toolCall: { id: "call-1", name: "bash", arguments: {} },
		result: { content: [] },
	} as unknown as AfterToolCallContext);
	const block = result?.content?.[0];
	const reminder = block && block.type === "text" ? block.text : "";
	expect(reminder).toContain("<matched>");
	expect(reminder).toContain("L1: const bad = value as any;");
});

const JUDGED_RULE: Rule = {
	name: "set-map",
	path: "rules/set-map.md",
	content: "Use Record for static tables.",
	interruptMode: "never",
	scope: ["tool:bash"],
	match: { all: [{ regex: "new Set\\b" }, { llm: "Is this Set built from a fixed literal list?" }] },
	_source: createSourceMeta("native", "rules/set-map.md", "project"),
};

const SET_SOURCE = "const kinds = new Set(['a', 'b']);";

function setToolDelta(): AgentEvent {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "write" } }],
		},
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: SET_SOURCE },
	} as unknown as AgentEvent;
}

function beforeToolCall(): BeforeToolCallContext {
	return {
		toolCall: { id: "call-1", name: "bash", arguments: { command: "write" } },
		args: { command: "write" },
	} as unknown as BeforeToolCallContext;
}

test("a judge condition waits for the final arguments, then rides the tool result", async () => {
	const { coordinator, asked, persisted } = harness([JUDGED_RULE], true, SET_SOURCE);

	// Streaming deltas must not spend a model call on a buffer that can still change.
	expect(await coordinator.checkMessageUpdate(setToolDelta())).toBe(false);
	expect(asked).toEqual([]);

	await coordinator.beforeToolCall(beforeToolCall());
	expect(asked).toEqual(["Is this Set built from a fixed literal list?"]);

	const result = coordinator.afterToolCall({
		toolCall: { id: "call-1", name: "bash", arguments: {} },
		result: { content: [] },
	} as unknown as AfterToolCallContext);
	const block = result?.content?.[0];
	expect(block && block.type === "text" ? block.text : "").toContain("Use Record for static tables.");
	expect(persisted).toEqual([["set-map"]]);
});

test("ending a turn cancels an in-flight judge instead of waiting out its timeout", async () => {
	// Answers only when cancelled: if the turn's signal never reaches the judge,
	// `beforeToolCall` never settles and the agent loop is stuck behind it.
	const cancellable: JudgeFn = (_request, signal) =>
		new Promise(resolve => signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
	const session = harness([JUDGED_RULE], true, SET_SOURCE, cancellable);

	session.coordinator.onTurnStart();
	const inFlight = session.coordinator.beforeToolCall(beforeToolCall());
	session.coordinator.onTurnEnd();

	await inFlight;
	// A judge that never answered is not evidence of anything.
	expect(session.events).toEqual([]);
	expect(
		session.coordinator.afterToolCall({
			toolCall: { id: "call-1", name: "bash", arguments: {} },
			result: { content: [] },
		} as unknown as AfterToolCallContext),
	).toBeUndefined();
});

test("a negative verdict leaves the tool result untouched", async () => {
	const { coordinator, asked } = harness([JUDGED_RULE], false, SET_SOURCE);
	await coordinator.beforeToolCall(beforeToolCall());
	expect(asked).toHaveLength(1);
	const result = coordinator.afterToolCall({
		toolCall: { id: "call-1", name: "bash", arguments: {} },
		result: { content: [] },
	} as unknown as AfterToolCallContext);
	expect(result).toBeUndefined();
});

const PLOT_SOURCE = "import matplotlib.pyplot as plt";

function ruleGatedOn(match: Rule["match"], name: string): Rule {
	return {
		name,
		path: `rules/${name}.md`,
		content: "Read the plotting skill first.",
		interruptMode: "never",
		match,
		_source: createSourceMeta("native", `rules/${name}.md`, "project"),
	};
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): unknown {
	return { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id, name, arguments: args }] };
}

test("a did condition answers from the session transcript, not from the buffer", async () => {
	const match = { all: [{ regex: "matplotlib" }, { not: { did: { tool: "read", path: "skill://viz" } } }] };
	const skipped = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);
	expect(await skipped.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(skipped.events).toEqual([["read-the-skill"]]);

	const informed = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);
	informed.messages.push(toolCallMessage("call-0", "read", { path: "skill://viz" }));
	expect(await informed.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(informed.events).toEqual([]);
});

function summaryMessage(): unknown {
	return { role: "user", timestamp: 1, content: [{ type: "text", text: "[summary] The session set up a plot." }] };
}

test("a rewritten transcript takes calls back out of did history", async () => {
	const match = { all: [{ regex: "matplotlib" }, { not: { did: { tool: "read", path: "skill://viz" } } }] };
	const session = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);
	const readTheSkill = toolCallMessage("call-0", "read", { path: "skill://viz" });

	// The session read the skill, so the rule has nothing to say.
	session.messages.push(readTheSkill);
	expect(await session.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(session.events).toEqual([]);

	// Compaction replaces the transcript, but its tail still holds the read.
	session.rewrite([summaryMessage(), readTheSkill]);
	expect(await session.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(session.events).toEqual([]);

	// Now the read is summarized away: the agent lost the skill, so the rule fires again.
	session.rewrite([summaryMessage()]);
	expect(await session.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(session.events).toEqual([["read-the-skill"]]);
});

test("did history follows edits made in place on the same transcript array", async () => {
	const match = { all: [{ regex: "matplotlib" }, { not: { did: { tool: "read", path: "skill://viz" } } }] };
	const session = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);

	session.messages.push(toolCallMessage("call-0", "read", { path: "skill://viz" }));
	expect(await session.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(session.events).toEqual([]);

	// Turn recovery rewinds and replays into the same array: same object, same
	// length, different contents. The read is gone, so the rule fires again.
	session.messages.length = 0;
	session.messages.push(toolCallMessage("call-9", "bash", { command: "ls" }));
	expect(await session.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(session.events).toEqual([["read-the-skill"]]);
});

function batchMessage(...calls: { id: string; name: string; arguments: Record<string, unknown> }[]): unknown {
	return { role: "assistant", timestamp: 1, content: calls.map(call => ({ type: "toolCall", ...call })) };
}

test("calls the model emitted in the same batch are not treated as prior history", async () => {
	const match = { all: [{ regex: "matplotlib" }, { not: { did: { tool: "read", path: "skill://viz" } } }] };

	// Read and write requested together: the read cannot have informed the write.
	const parallel = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);
	parallel.messages.push(
		batchMessage(
			{ id: "call-0", name: "read", arguments: { path: "skill://viz" } },
			{ id: "call-1", name: "bash", arguments: { command: "write" } },
		),
	);
	expect(await parallel.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(parallel.events).toEqual([["read-the-skill"]]);

	// The same read one batch earlier did inform it.
	const sequential = harness([ruleGatedOn(match, "read-the-skill")], true, PLOT_SOURCE);
	sequential.messages.push(
		toolCallMessage("call-0", "read", { path: "skill://viz" }),
		toolCallMessage("call-1", "bash", { command: "write" }),
	);
	expect(await sequential.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(sequential.events).toEqual([]);
});

function textRule(match: Rule["match"], name: string): Rule {
	return { ...ruleGatedOn(match, name), scope: ["text"] } as Rule;
}

function claimMessage(...calls: { id: string; name: string; arguments: Record<string, unknown> }[]): unknown {
	return {
		role: "assistant",
		timestamp: 1,
		content: [...calls.map(call => ({ type: "toolCall", ...call })), { type: "text", text: "" }],
	};
}

function claimDelta(message: unknown): AgentEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "all tests pass" },
	} as unknown as AgentEvent;
}

test("prose is not history to itself: calls in the same message do not count", async () => {
	const match = {
		all: [{ regex: "all tests pass" }, { not: { did: { tool: "bash", args: "bun test" } } }],
	} as Rule["match"];
	const testRun = { id: "call-0", name: "bash", arguments: { command: "bun test" } };

	// The claim and the test run were emitted together, so the run cannot back the claim.
	const together = harness([textRule(match, "prove-it")], true);
	const message = claimMessage(testRun);
	together.messages.push(message);
	expect(await together.coordinator.checkMessageUpdate(claimDelta(message))).toBe(false);
	expect(together.events).toEqual([["prove-it"]]);

	// A run in an earlier message did precede the claim.
	const after = harness([textRule(match, "prove-it")], true);
	const claim = claimMessage();
	after.messages.push(toolCallMessage("call-0", "bash", { command: "bun test" }), claim);
	expect(await after.coordinator.checkMessageUpdate(claimDelta(claim))).toBe(false);
	expect(after.events).toEqual([]);
});

test("the call under evaluation is not counted as something the session already did", async () => {
	const match = { all: [{ regex: "matplotlib" }, { not: { did: "bash" } }] };
	// The transcript already holds the very call being matched.
	const first = harness([ruleGatedOn(match, "first-bash")], true, PLOT_SOURCE);
	first.messages.push(toolCallMessage("call-1", "bash", { command: "write" }));
	expect(await first.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(first.events).toEqual([["first-bash"]]);

	// An earlier call by the same tool does count.
	const second = harness([ruleGatedOn(match, "first-bash")], true, PLOT_SOURCE);
	second.messages.push(
		toolCallMessage("call-0", "bash", { command: "ls" }),
		toolCallMessage("call-1", "bash", { command: "write" }),
	);
	expect(await second.coordinator.checkMessageUpdate(toolDelta())).toBe(false);
	expect(second.events).toEqual([]);
});
