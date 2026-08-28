import { describe, expect, it } from "bun:test";
import { buildTrajectory, type TrajectoryStep } from "@oh-my-pi/pi-coding-agent/session/trajectory/model";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);

function entry(id: string, offsetMs: number): { id: string; parentId: null; timestamp: string } {
	return { id, parentId: null, timestamp: new Date(T0 + offsetMs).toISOString() };
}

const usage = {
	input: 100,
	output: 50,
	cacheRead: 200,
	cacheWrite: 10,
	totalTokens: 360,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
	reasoningTokens: 20,
} as const;

function userEntry(id: string, offsetMs: number, text: string, flags?: { synthetic?: boolean; steering?: boolean }): SessionEntry {
	return {
		...entry(id, offsetMs),
		type: "message",
		message: { role: "user", content: text, timestamp: T0 + offsetMs, ...flags },
	};
}

function assistantEntry(
	id: string,
	offsetMs: number,
	content: AssistantContent,
	extra?: Partial<{ duration: number; ttft: number; stopReason: "stop" | "toolUse" | "error"; errorMessage: string }>,
): SessionEntry {
	return {
		...entry(id, offsetMs),
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-x",
			usage,
			stopReason: extra?.stopReason ?? "stop",
			errorMessage: extra?.errorMessage,
			duration: extra?.duration,
			ttft: extra?.ttft,
			timestamp: T0 + offsetMs,
		},
	};
}

type AssistantContent = Array<
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
>;

function toolResultEntry(id: string, offsetMs: number, toolCallId: string, text: string, isError = false): SessionEntry {
	return {
		...entry(id, offsetMs),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			isError,
			timestamp: T0 + offsetMs,
			content: [{ type: "text", text }],
		},
	};
}

describe("buildTrajectory", () => {
	it("groups a real user message and its assistant/tool activity into one turn", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "Fix the bug"),
			assistantEntry("e2", 500, [{ type: "text", text: "On it." }], { duration: 1500, ttft: 300 }),
		]);

		expect(trajectory.turnCount).toBe(1);
		expect(trajectory.steps.map(step => step.source)).toEqual(["user", "assistant"]);
		const chat = trajectory.steps[1];
		expect(chat.kind).toBe("chat");
		expect(chat.detail).toBe("anthropic/claude-x");
		expect(chat.durationMs).toBe(1500);
		expect(chat.ttftMs).toBe(300);
		expect(trajectory.turns[0]?.firstStepIndex).toBe(1);
		expect(trajectory.turns[0]?.lastStepIndex).toBe(2);
	});

	it("does not start turns for synthetic or steering user messages", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "Real prompt"),
			userEntry("e2", 100, "[auto-continue]", { synthetic: true }),
			userEntry("e3", 200, "steer now", { steering: true }),
			assistantEntry("e4", 300, [{ type: "text", text: "done" }]),
		]);

		expect(trajectory.turnCount).toBe(1);
		expect(trajectory.steps[1].kind).toBe("injected");
		expect(trajectory.steps[2].kind).toBe("steer");
	});

	it("pairs tool calls with results and derives execution duration", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "Read foo"),
			assistantEntry("e2", 500, [
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/x/foo.ts" } },
			]),
			toolResultEntry("e3", 2100, "tc1", "const x = 1;"),
		]);

		const toolStep = trajectory.steps.find((step): step is TrajectoryStep & { toolCallId: string } => step.kind === "tool_call");
		expect(toolStep).toBeDefined();
		expect(toolStep.title).toBe("READ");
		expect(toolStep.toolCallId).toBe("tc1");
		expect(toolStep.resultText).toBe("const x = 1;");
		expect(toolStep.durationMs).toBe(1600);
		expect(toolStep.content).toContain("[result]");
	});

	it("emits an unpaired tool result as its own ledger row", () => {
		const trajectory = buildTrajectory([toolResultEntry("e1", 0, "ghost-call", "orphan output")]);
		const orphan = trajectory.steps[0];
		expect(orphan.kind).toBe("tool_result");
		expect(orphan.preview).toBe("orphan output");
	});

	it("rolls up usage and cost across chat steps", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "one"),
			assistantEntry("e2", 100, [{ type: "text", text: "a" }]),
			assistantEntry("e3", 200, [{ type: "text", text: "b" }]),
		]);

		expect(trajectory.totals.requests).toBe(2);
		expect(trajectory.totals.input).toBe(200);
		expect(trajectory.totals.output).toBe(100);
		expect(trajectory.totals.cacheRead).toBe(400);
		expect(trajectory.totals.costUsd).toBeCloseTo(0.066, 6);
		expect(trajectory.hasErrors).toBe(false);
	});

	it("flags errors from error-stop assistant messages and failed tool results", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "go"),
			assistantEntry("e2", 100, [{ type: "text", text: "boom" }], { stopReason: "error", errorMessage: "503 upstream" }),
			assistantEntry("e3", 200, [{ type: "toolCall", id: "tc9", name: "bash", arguments: {} }]),
			toolResultEntry("e4", 300, "tc9", "exit 1", true),
		]);

		expect(trajectory.hasErrors).toBe(true);
		const chat = trajectory.steps[1];
		expect(chat.isError).toBe(true);
		const toolStep = trajectory.steps.find(step => step.kind === "tool_call");
		expect(toolStep?.isError).toBe(true);
	});

	it("surfaces compactions as their own steps and keeps them out of message nodes", () => {
		const entries: SessionEntry[] = [
			...buildInner(),
			{
				...entry("e5", 900),
				type: "compaction",
				summary: "Compacted history",
				firstKeptEntryId: "e3",
				tokensBefore: 90_000,
				tokensAfter: 12_000,
				method: "local",
			},
		];
		function buildInner(): SessionEntry[] {
			return [userEntry("e1", 0, "hello"), assistantEntry("e2", 100, [{ type: "text", text: "hi" }])];
		}
		const trajectory = buildTrajectory(entries);
		const compaction = trajectory.steps.find(step => step.kind === "compaction");
		expect(compaction?.preview).toBe("Compacted history");
		expect(compaction?.content).toContain("90000 → 12000");
	});

	it("records model changes as meta steps", () => {
		const trajectory = buildTrajectory([
			userEntry("e1", 0, "hi"),
			{ ...entry("e2", 50), type: "model_change", model: "openai/gpt-x", role: "default" },
		]);
		const meta = trajectory.steps[1];
		expect(meta.source).toBe("meta");
		expect(meta.preview).toBe("openai/gpt-x");
	});
});
