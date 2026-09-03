import { describe, expect, test } from "bun:test";
import type { AgentMessage, CustomMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, DeveloperMessage, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { assembleEpochDigest, type EpochDigest, type EpochDigestInput } from "./digest";

// ---- fixture builders (minimal shapes the assembler actually reads) ----

let toolCallSeq = 0;
function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
	toolCallSeq += 1;
	return { type: "toolCall", id: `call-${toolCallSeq}`, name, arguments: args };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function user(content: string | UserMessage["content"]): UserMessage {
	return { role: "user", content: content as UserMessage["content"], timestamp: 0 };
}

function developer(content: string): DeveloperMessage {
	return { role: "developer", content, timestamp: 0 };
}

function toolResult(name: string, body: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-x",
		toolName: name,
		content: [{ type: "text", text: body }],
		isError: false,
		timestamp: 0,
	};
}

function custom(customType: string, content: string): CustomMessage {
	return { role: "custom", customType, content, display: true, timestamp: 0 };
}

function digest(messages: AgentMessage[], overrides: Partial<EpochDigestInput> = {}): EpochDigest {
	return assembleEpochDigest({
		messages,
		cursor: 0,
		wakeReasons: ["routine cadence wake"],
		epochNumber: 1,
		goalSummary: "status: running",
		diffStat: undefined,
		...overrides,
	});
}

// ---- assistant turns ----

describe("assistant activity lines", () => {
	test("renders tool-call headlines with arg-priority preview", () => {
		const result = digest([
			assistant([toolCall("bash", { command: 'rg "foo" src/' }), toolCall("read", { file_path: "src/x.ts" })]),
		]);
		expect(result.activity).toEqual([{ kind: "assistant", tools: 'bash(rg "foo" src/), read(src/x.ts)', text: "" }]);
	});

	test("arg preview prefers command over lower-priority keys and falls back to name()", () => {
		const result = digest([
			assistant([toolCall("edit", { path: "a.ts", query: "ignored", file_path: "b.ts" })]),
			assistant([toolCall("weird", { label: "no-match" })]),
		]);
		expect(result.activity[0]?.tools).toBe("edit(b.ts)");
		expect(result.activity[1]?.tools).toBe("weird()");
	});

	test("tool preview elides to 60 chars with ellipsis", () => {
		const long = "x".repeat(100);
		const result = digest([assistant([toolCall("bash", { command: long })])]);
		expect(result.activity[0]?.tools).toBe(`bash(${"x".repeat(59)}…)`);
	});

	test("text block first meaningful line is elided to 160", () => {
		const result = digest([assistant([{ type: "text", text: `  ${"y".repeat(200)}  ` }])]);
		expect(result.activity[0]?.text).toBe(`${"y".repeat(159)}…`);
	});

	test("first meaningful line skips blank lines and collapses whitespace", () => {
		const result = digest([assistant([{ type: "text", text: "\n\n  running   the\tsuite  \nnext line" }])]);
		expect(result.activity[0]?.text).toBe("running the suite");
	});

	test("thinking blocks never appear", () => {
		const result = digest([
			assistant([
				{ type: "thinking", thinking: "secret internal reasoning about tools" },
				{ type: "text", text: "visible conclusion" },
			]),
		]);
		expect(result.activity).toHaveLength(1);
		expect(JSON.stringify(result.text)).not.toContain("secret internal reasoning");
	});

	test("turn with neither tool calls nor text is skipped", () => {
		const result = digest([assistant([{ type: "thinking", thinking: "only thoughts" }]), user("real work")]);
		expect(result.turns).toBe(1);
		expect(result.activity[0]?.kind).toBe("user");
	});
});

// ---- user / developer / toolResult ----

describe("user and developer lines", () => {
	test("user string content renders first meaningful line", () => {
		const result = digest([user("\nfix the flaky test\nsecond line")]);
		expect(result.activity).toEqual([{ kind: "user", tools: "", text: "fix the flaky test" }]);
	});

	test("user block-array content and developer role both render as user", () => {
		const result = digest([user([{ type: "text", text: "from blocks" }]), developer("from developer")]);
		expect(result.activity.map(line => line.kind)).toEqual(["user", "user"]);
		expect(result.activity[0]?.text).toBe("from blocks");
	});

	test("toolResult bodies are elided entirely", () => {
		const result = digest([user("go"), toolResult("bash", "SECRET TOOL OUTPUT"), assistant([])]);
		expect(result.activity).toEqual([{ kind: "user", tools: "", text: "go" }]);
		expect(result.text).not.toContain("SECRET TOOL OUTPUT");
	});
});

// ---- custom messages ----

describe("custom messages", () => {
	test("advisor notes survive with their first meaningful line", () => {
		const result = digest([custom("advisor", "\nThe verification command\nin the contract does not exist.")]);
		expect(result.activity).toEqual([{ kind: "advisor", tools: "", text: "The verification command" }]);
	});

	test("machinery custom types are dropped", () => {
		const machinery = [
			"goal-continuation",
			"goal-budget-limit",
			"session-stop-continuation",
			"conductor-verification",
			"conductor-epoch",
		];
		const messages = machinery.map(type => custom(type, `${type} noise body`));
		const result = digest(messages);
		expect(result.activity).toEqual([]);
		expect(result.turns).toBe(0);
		expect(result.text).toContain("no primary activity since the last epoch");
	});

	test("other custom types render with their type prefix", () => {
		const result = digest([custom("hookMessage", "deploy finished")]);
		expect(result.activity).toEqual([{ kind: "custom", tools: "", text: "hookMessage: deploy finished" }]);
	});
});

// ---- cursor semantics ----

describe("cursor semantics", () => {
	test("second call with returned cursor summarizes only new messages", () => {
		const first = digest([user("epoch one work"), assistant([{ type: "text", text: "done" }])]);
		expect(first.turns).toBe(2);
		expect(first.cursor).toBe(2);

		const messages: AgentMessage[] = [
			user("epoch one work"),
			assistant([{ type: "text", text: "done" }]),
			user("epoch two work"),
		];
		const second = digest(messages, { cursor: first.cursor });
		expect(second.turns).toBe(1);
		expect(second.activity).toEqual([{ kind: "user", tools: "", text: "epoch two work" }]);
		expect(second.cursor).toBe(3);
	});

	test("cursor beyond transcript length resets to zero and re-scans", () => {
		const result = digest([user("only message")], { cursor: 10 });
		expect(result.turns).toBe(1);
		expect(result.activity[0]?.text).toBe("only message");
		expect(result.cursor).toBe(1);
	});
});

// ---- line cap ----

describe("activity cap", () => {
	function longTranscript(turns: number): AgentMessage[] {
		return Array.from({ length: turns }, (_, i) => user(`turn ${i}`));
	}

	test("under the cap: not truncated, all lines kept", () => {
		const result = digest(longTranscript(80));
		expect(result.truncated).toBe(false);
		expect(result.activity).toHaveLength(80);
		expect(result.turns).toBe(80);
	});

	test("over the cap: truncated with the most recent 80 kept in chronological order", () => {
		const result = digest(longTranscript(90));
		expect(result.truncated).toBe(true);
		expect(result.activity).toHaveLength(80);
		expect(result.turns).toBe(90);
		expect(result.activity[0]?.text).toBe("turn 10");
		expect(result.activity.at(-1)?.text).toBe("turn 89");
	});
});

// ---- envelope ----

describe("envelope", () => {
	test("renders epoch attribute, wake reasons, goal, and activity", () => {
		const result = digest([user("fix the flaky test")], {
			wakeReasons: ["budget threshold crossed", "advisor flagged drift"],
			epochNumber: 7,
			goalSummary: "status: running; usage: 1k of 10k",
		});
		const lines = result.text.split("\n");
		expect(lines[0]).toBe('<epoch-digest epoch="7">');
		expect(lines[1]).toBe("<wake-reasons>");
		expect(lines[2]).toBe("- budget threshold crossed");
		expect(lines[3]).toBe("- advisor flagged drift");
		expect(result.text).toContain("<goal>\nstatus: running; usage: 1k of 10k\n</goal>");
		expect(result.text).toContain("- [user] fix the flaky test");
		expect(result.text).toContain('<activity turns="1" truncated="false" since-cursor="0">');
	});

	test("assistant line joins tools and text with separator", () => {
		const result = digest([
			assistant([toolCall("bash", { command: "bun test" }), { type: "text", text: "Running the suite…" }]),
		]);
		expect(result.text).toContain("- [agent] bash(bun test) | Running the suite…");
	});

	test("empty activity renders the no-activity fallback", () => {
		const result = digest([toolResult("bash", "noise")]);
		expect(result.text).toContain("no primary activity since the last epoch");
		expect(result.text).toContain('<activity turns="0" truncated="false" since-cursor="0">');
	});

	test("unavailable diffStat renders as unavailable", () => {
		const result = digest([user("hi")], { diffStat: undefined });
		expect(result.text).toContain("<working-tree>\nunavailable\n</working-tree>");
	});

	test("diffStat is inserted verbatim and XML-hostile content is escaped", () => {
		const result = digest([user("a <b> & 'c' \"d\"")], { diffStat: "src/x.ts | 1 +" });
		expect(result.text).toContain("<working-tree>\nsrc/x.ts | 1 +\n</working-tree>");
		expect(result.text).toContain("- [user] a &lt;b&gt; &amp; 'c' \"d\"");
	});
});
