import { describe, expect, it } from "bun:test";
import { trajectoryToOtlp } from "@oh-my-pi/pi-coding-agent/session/trajectory/export-otel";
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
			ttft: 300,
			timestamp: T0 + 500,
		},
	},
	{
		...entry("e3", 2100),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			isError: false,
			timestamp: T0 + 2100,
			content: [{ type: "text", text: "const x = 1;" }],
		},
	},
	{
		...entry("e4", 2500),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Fixed." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-x",
			usage: { ...usage, input: 80 },
			stopReason: "stop",
			duration: 900,
			timestamp: T0 + 2500,
		},
	},
];

function spanByName(doc: ReturnType<typeof trajectoryToOtlp>, prefix: string) {
	return doc.resourceSpans[0].scopeSpans[0].spans.filter(span => span.name.startsWith(prefix));
}

function attr(span: { attributes: Array<{ key: string }> }, key: string): unknown {
	const found = span.attributes.find(candidate => candidate.key === key);
	if (!found) return undefined;
	const value = found.value as {
		stringValue?: string;
		intValue?: string;
		doubleValue?: number;
		arrayValue?: { values: Array<{ stringValue?: string }> };
	};
	if (value.arrayValue) return value.arrayValue.values.map(item => item.stringValue).join(",");
	return value.stringValue ?? value.intValue ?? value.doubleValue;
}
describe("trajectoryToOtlp", () => {
	it("emits one invoke_agent root with conversation identity and aggregates", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-1", title: "Fix bug", cwd: "/tmp" });
		const doc = trajectoryToOtlp(trajectory);
		const roots = spanByName(doc, "invoke_agent");
		expect(roots).toHaveLength(1);
		const root = roots[0];
		expect(root.parentSpanId).toBeUndefined();
		expect(attr(root, "gen_ai.conversation.id")).toBe("sess-1");
		expect(attr(root, "gen_ai.operation.name")).toBe("invoke_agent");
		expect(Number(attr(root, "pi.gen_ai.usage.total_tokens"))).toBeGreaterThan(0);
	});

	it("creates chat spans per assistant message with GenAI usage attributes", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-1", title: null, cwd: "/tmp" });
		const doc = trajectoryToOtlp(trajectory);
		const chats = spanByName(doc, "chat anthropic/claude-x");
		expect(chats).toHaveLength(2);

		const first = chats[0];
		expect(attr(first, "gen_ai.operation.name")).toBe("chat");
		expect(attr(first, "gen_ai.request.model")).toBe("anthropic/claude-x");
		expect(attr(first, "gen_ai.provider.name")).toBe("anthropic");
		// Semconv input tokens include cache buckets: 100 + 200 + 10.
		expect(Number(attr(first, "gen_ai.usage.input_tokens"))).toBe(310);
		expect(Number(attr(first, "gen_ai.usage.output_tokens"))).toBe(50);
		expect(Number(attr(first, "gen_ai.usage.cache_read.input_tokens"))).toBe(200);
		expect(Number(attr(first, "gen_ai.usage.cache_creation.input_tokens"))).toBe(10);
		expect(Number(attr(first, "gen_ai.usage.reasoning.output_tokens"))).toBe(20);
	});

	it("maps stop reasons to semconv finish reasons", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-1", title: null, cwd: "/tmp" });
		const doc = trajectoryToOtlp(trajectory);
		const chats = spanByName(doc, "chat ");
		const finishReasons = chats.map(span => attr(span, "gen_ai.response.finish_reasons"));
		expect(finishReasons).toContain("tool_calls");
		expect(finishReasons).toContain("stop");
	});

	it("parents execute_tool spans under their emitting chat span with call/result attrs", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-1", title: null, cwd: "/tmp" });
		const doc = trajectoryToOtlp(trajectory);
		const spans = doc.resourceSpans[0].scopeSpans[0].spans;
		const tools = spans.filter(span => span.name.startsWith("execute_tool"));
		expect(tools).toHaveLength(1);
		const tool = tools[0];
		const chat = spans.find(span => span.spanId === tool.parentSpanId);
		expect(chat?.name).toBe("chat anthropic/claude-x");
		expect(attr(tool, "gen_ai.tool.name")).toBe("read");
		expect(attr(tool, "gen_ai.tool.call.id")).toBe("tc1");
		expect(String(attr(tool, "gen_ai.tool.call.arguments"))).toContain("/x/foo.ts");
		expect(attr(tool, "pi.gen_ai.tool.status")).toBe("ok");
	});

	it("produces valid hex ids, ordered nanos, and deterministic re-export", () => {
		const trajectory = buildTrajectory(FIXTURE_ENTRIES, { id: "sess-1", title: null, cwd: "/tmp" });
		const first = trajectoryToOtlp(trajectory);
		const second = trajectoryToOtlp(trajectory);
		for (const span of first.resourceSpans[0].scopeSpans[0].spans) {
			expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
			expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
		}
		// Parent references must resolve to real span ids.
		const ids = new Set(first.resourceSpans[0].scopeSpans[0].spans.map(span => span.spanId));
		for (const span of first.resourceSpans[0].scopeSpans[0].spans) {
			if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
		}
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("marks error chats with ERROR status and error.type mapping", () => {
		const entries: SessionEntry[] = [
			{ ...entry("f1", 0), type: "message", message: { role: "user", content: "go", timestamp: T0 } },
			{
				...entry("f2", 100),
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "boom" }],
					api: "openai-completions",
					provider: "openai",
					model: "gpt-x",
					usage,
					stopReason: "error",
					errorMessage: "503 upstream",
					timestamp: T0 + 100,
				},
			},
		];
		const trajectory = buildTrajectory(entries, { id: "err-sess", title: null, cwd: "/tmp" });
		const doc = trajectoryToOtlp(trajectory);
		const chat = spanByName(doc, "chat openai/gpt-x")[0];
		expect(chat.status.code).toBe(2);
		expect(chat.status.message).toContain("503");
	});
});
