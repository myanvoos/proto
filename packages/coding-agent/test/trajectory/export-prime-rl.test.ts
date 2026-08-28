import { describe, expect, it } from "bun:test";
import {
	trajectoryToPrimeRlEpisode,
	trajectoriesToPrimeRlJsonl,
} from "@oh-my-pi/pi-coding-agent/session/trajectory/export-prime-rl";
import { buildTrajectory } from "@oh-my-pi/pi-coding-agent/session/trajectory/model";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);
const usage = {
	input: 100,
	output: 50,
	cacheRead: 200,
	cacheWrite: 10,
	totalTokens: 360,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
	reasoningTokens: 20,
} as const;

function entry(id: string, offsetMs: number): { id: string; parentId: null; timestamp: string } {
	return { id, parentId: null, timestamp: new Date(T0 + offsetMs).toISOString() };
}

const FIXTURE_ENTRIES: SessionEntry[] = [
	{ ...entry("e1", 0), type: "message", message: { role: "user", content: "Fix the bug", timestamp: T0 } },
	{
		...entry("e2", 500),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Reading." },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/x/foo.ts" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-x",
			usage,
			stopReason: "toolUse",
			duration: 1500,
			timestamp: T0 + 500,
		},
	},
	{
		...entry("e3", 2100),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			isError: false,
			timestamp: T0 + 2100,
			content: [{ type: "text", text: "const x = 1;" }],
		},
	},
];

interface EpisodeView {
	id: string;
	env: { id: string };
	ok: boolean;
	traces: Array<{
		version: number;
		agent: { name: string; trainable: boolean };
		nodes: Array<{ parent: number | null; message: Record<string, unknown>; sampled: boolean; timestamp: number }>;
		calls: Array<Record<string, unknown>>;
		rewards: Record<string, unknown>;
		metrics: Record<string, unknown>;
		errors: unknown[];
	}>;
}

function episode(entries: SessionEntry[], options?: Parameters<typeof trajectoryToPrimeRlEpisode>[1]): EpisodeView {
	return trajectoryToPrimeRlEpisode(buildTrajectory(entries, { id: "sess-rl", title: "T", cwd: "/tmp" }), options) as unknown as EpisodeView;
}

describe("trajectoryToPrimeRlEpisode", () => {
	it("builds a parent-linked node chain with correct provenance flags", () => {
		const ep = episode(FIXTURE_ENTRIES);
		expect(ep.traces).toHaveLength(1);
		const trace = ep.traces[0];
		expect(trace.version).toBe(1);
		expect(trace.agent).toEqual({ config: {}, runtime: null, name: "proto", trainable: true });

		const nodes = trace.nodes;
		expect(nodes.map(node => node.message.role)).toEqual(["user", "assistant", "tool"]);
		expect(nodes[0].parent).toBeNull();
		for (let i = 1; i < nodes.length; i++) expect(nodes[i].parent).toBe(i - 1);
		expect(nodes[0].sampled).toBe(false);
		expect(nodes[1].sampled).toBe(true);
		expect(nodes[2].sampled).toBe(false);
	});

	it("attaches tool_calls to the assistant message and results to tool messages", () => {
		const ep = episode(FIXTURE_ENTRIES);
		const assistant = ep.traces[0].nodes[1].message as {
			tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
		};
		expect(assistant.tool_calls).toHaveLength(1);
		expect(assistant.tool_calls?.[0]?.function.name).toBe("read");
		expect(JSON.parse(assistant.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ path: "/x/foo.ts" });

		const toolNode = ep.traces[0].nodes[2].message as { tool_call_id: string; content: string };
		expect(toolNode.tool_call_id).toBe("tc1");
		expect(toolNode.content).toContain("const x = 1;");
	});

	it("maps proto usage buckets onto verifiers token semantics per call", () => {
		const ep = episode(FIXTURE_ENTRIES);
		const calls = ep.traces[0].calls;
		expect(calls).toHaveLength(1);
		const call = calls[0] as {
			node: number;
			model: string;
			finish_reason: string;
			usage: { prompt_tokens: number; completion_tokens: number; cached_input_tokens: number; reasoning_tokens: number; cost: number };
			time: { start: number; end: number };
		};
		expect(call.node).toBe(1);
		expect(call.model).toBe("anthropic/claude-x");
		expect(call.finish_reason).toBe("tool_calls");
		// proto input excludes cache reads — maps directly onto verifiers prompt_tokens.
		expect(call.usage.prompt_tokens).toBe(100);
		expect(call.usage.completion_tokens).toBe(50);
		expect(call.usage.cached_input_tokens).toBe(200);
		expect(call.usage.reasoning_tokens).toBe(20);
		expect(call.usage.cost).toBeCloseTo(0.033, 6);
		expect(call.time.end - call.time.start).toBeCloseTo(1.5, 5);
	});

	it("keeps thinking out of the sampled assistant content", () => {
		const entries: SessionEntry[] = [
			{ ...entry("t1", 0), type: "message", message: { role: "user", content: "hi", timestamp: T0 } },
			{
				...entry("t2", 100),
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret scratchpad" },
						{ type: "text", text: "visible answer" },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-x",
					usage,
					stopReason: "stop",
					timestamp: T0 + 100,
				},
			},
		];
		const ep = episode(entries);
		const content = String(ep.traces[0].nodes[1].message.content);
		expect(content).toBe("visible answer");
		expect(content).not.toContain("scratchpad");
	});

	it("stamps manual reward and flips ok on errors", () => {
		const rewarded = episode(FIXTURE_ENTRIES, { reward: 0.75 });
		expect(rewarded.traces[0].rewards.manual).toEqual({ score: 0.75, weight: 1 });

		const failing: SessionEntry[] = [
			{ ...entry("x1", 0), type: "message", message: { role: "user", content: "go", timestamp: T0 } },
			{
				...entry("x2", 100),
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "boom" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-x",
					usage,
					stopReason: "error",
					errorMessage: "503 upstream",
					timestamp: T0 + 100,
				},
			},
		];
		const failed = episode(failing);
		expect(failed.ok).toBe(false);
		expect(failed.traces[0].ok).toBe(false);
		expect(failed.traces[0].errors.length).toBeGreaterThan(0);
	});

	it("serializes JSONL with one episode per line and stable ids across re-exports", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-rl", title: "T", cwd: "/tmp" });
		const jsonl = trajectoriesToPrimeRlJsonl([trajectory, trajectory]);
		const lines = jsonl.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]) as EpisodeView;
		expect(first.env.id).toBe("proto");
		const again = trajectoriesToPrimeRlJsonl([trajectory]);
		expect((JSON.parse(again) as EpisodeView).id).toBe(first.id);
	});
});
