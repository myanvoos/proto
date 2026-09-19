import type { Message, Model } from "@oh-my-pi/pi-ai";
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
import { type AgentTelemetry, resolveTelemetry, startChatSpan } from "../packages/agent/src/telemetry";
import { formatArtifact, runSuite } from "./harness";

class BenchmarkSpan implements Span {
	attributes: Attributes = {};

	spanContext(): SpanContext {
		return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
	}

	setAttribute(_key: string, _value: SpanAttributeValue): this {
		return this;
	}

	setAttributes(_attributes: SpanAttributes): this {
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

	end(): void {}

	isRecording(): boolean {
		return true;
	}

	recordException(_exception: Exception): void {}
}

const tracer = {
	startSpan: () => new BenchmarkSpan(),
} as unknown as Tracer;
const model = getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");

interface Fixture {
	readonly telemetry: AgentTelemetry;
	readonly model: Model;
	readonly messages: readonly Message[];
}

function buildFixture(messageCount: number): Fixture {
	const telemetry = resolveTelemetry({ tracer, captureMessageContent: "summary" }, "bench");
	if (!telemetry) throw new Error("telemetry did not resolve");
	const messages: Message[] = Array.from({ length: messageCount }, (_, index) => ({
		role: "user",
		timestamp: index,
		content: [{ type: "text", text: `message-${index}-${"x".repeat(120)}` }],
	}));
	return { telemetry, model, messages };
}

const artifact = await runSuite("agent-telemetry", [
	{
		name: "messages-1k",
		runs: 15,
		setup: () => buildFixture(1_000),
		run: (fixture: never) => {
			const value = fixture as Fixture;
			startChatSpan(value.telemetry, value.model, { stepNumber: 1, request: { messages: value.messages } });
		},
	},
	{
		name: "messages-10k",
		runs: 10,
		setup: () => buildFixture(10_000),
		run: (fixture: never) => {
			const value = fixture as Fixture;
			startChatSpan(value.telemetry, value.model, { stepNumber: 1, request: { messages: value.messages } });
		},
	},
	{
		name: "messages-100k",
		runs: 5,
		setup: () => buildFixture(100_000),
		run: (fixture: never) => {
			const value = fixture as Fixture;
			startChatSpan(value.telemetry, value.model, { stepNumber: 1, request: { messages: value.messages } });
		},
	},
]);
console.log(formatArtifact(artifact));
