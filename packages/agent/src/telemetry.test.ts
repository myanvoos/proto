import { expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type {
	Attributes,
	Exception,
	Link,
	Span,
	SpanAttributes,
	SpanAttributeValue,
	SpanContext,
	SpanStatus,
	TimeInput,
	Tracer,
} from "@opentelemetry/api";
import { finishChatSpan, PiGenAIAttr, resolveTelemetry, startChatSpan } from "./telemetry";

const model = getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");

class RecordingSpan implements Span {
	attributes: Attributes = {};
	ended = false;

	spanContext(): SpanContext {
		return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
	}

	setAttribute(key: string, value: SpanAttributeValue): this {
		this.attributes[key] = value;
		return this;
	}

	setAttributes(attributes: SpanAttributes): this {
		Object.assign(this.attributes, attributes);
		return this;
	}

	addEvent(_name: string, _attributesOrStartTime?: SpanAttributes | TimeInput, _startTime?: TimeInput): this {
		return this;
	}

	addLink(_link: Link): this {
		return this;
	}

	addLinks(_links: Link[]): this {
		return this;
	}

	setStatus(_status: SpanStatus): this {
		return this;
	}

	updateName(_name: string): this {
		return this;
	}

	end(): void {
		this.ended = true;
	}

	isRecording(): boolean {
		return !this.ended;
	}

	recordException(_exception: Exception): void {}
}

function recordingTracer(): { tracer: Tracer; spans: RecordingSpan[] } {
	const spans: RecordingSpan[] = [];
	const tracer = {
		startSpan: () => {
			const span = new RecordingSpan();
			spans.push(span);
			return span;
		},
	} as unknown as Tracer;
	return { tracer, spans };
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userMessages(count: number): Message[] {
	return Array.from({ length: count }, (_, index) => ({
		role: "user" as const,
		timestamp: index,
		content: [{ type: "text" as const, text: `message-${index}` }],
	}));
}

test("summary capture does not inspect messages discarded by the telemetry cap", () => {
	const { tracer, spans } = recordingTracer();
	const messages = userMessages(100);
	const accessed: number[] = [];
	const trackedMessages = new Proxy(messages, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) accessed.push(Number(property));
			return Reflect.get(target, property, receiver);
		},
	});
	const telemetry = resolveTelemetry({ tracer, captureMessageContent: "summary" }, "session");
	if (!telemetry) throw new Error("telemetry did not resolve");

	startChatSpan(telemetry, model, {
		stepNumber: 1,
		request: { messages: trackedMessages },
	});

	expect(accessed.some(index => index >= 16)).toBe(false);
	const serialized = spans[0]?.attributes[PiGenAIAttr.RequestMessages];
	expect(typeof serialized).toBe("string");
	const captured = JSON.parse(serialized as string) as Array<{ content: unknown }>;
	expect(captured).toHaveLength(17);
	expect(captured.at(-1)?.content).toEqual({ kind: "truncated", omittedMessages: 84 });
});

test("a hanging onChatUsage hook does not delay chat span completion", async () => {
	const { tracer, spans } = recordingTracer();
	const never = new Promise<void>(() => {});
	const telemetry = resolveTelemetry({ tracer, onChatUsage: () => never }, "session");
	if (!telemetry) throw new Error("telemetry did not resolve");
	const span = startChatSpan(telemetry, model, { stepNumber: 1, request: {} });
	if (!span) throw new Error("chat span did not start");

	let finished = false;
	void finishChatSpan(telemetry, span, assistantMessage(), { stepNumber: 1 }).then(() => {
		finished = true;
	});
	await Promise.resolve();
	await Promise.resolve();

	expect(finished).toBe(true);
	expect(spans[0]?.ended).toBe(true);
});
