import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { STREAMING_REVEAL_FRAME_MS, StreamingRevealController } from "./streaming-reveal";

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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

class RecordingComponent {
	messages: AssistantMessage[] = [];

	updateContent(message: AssistantMessage): void {
		this.messages.push(message);
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

function latestText(component: RecordingComponent): string {
	const block = component.messages.at(-1)?.content[0];
	if (block?.type !== "text") throw new Error("Expected a text block");
	return block.text;
}

function setup(smooth: () => boolean = () => true) {
	const component = new RecordingComponent();
	const controller = new StreamingRevealController({
		getSmoothStreaming: smooth,
		getHideThinkingBlock: () => false,
		getProseOnlyThinking: () => true,
		requestRender: () => {},
	});
	controller.begin(component, makeMessage([{ type: "text", text: "" }]), false);
	return { component, controller };
}

const text = (value: string) => makeMessage([{ type: "text", text: value }]);

describe("StreamingRevealController", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces caught-up deltas into at most one render per reveal frame", () => {
		vi.useFakeTimers();
		const { component, controller } = setup();
		let value = "abcdefghij";
		controller.setTarget(text(value), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 10);
		expect(latestText(component)).toBe(value);

		const before = component.messages.length;
		for (let i = 0; i < 30; i++) {
			value += "x";
			controller.setTarget(text(value), false);
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS / 5);
		}
		expect(component.messages.length - before).toBeLessThanOrEqual(7);

		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 20);
		expect(latestText(component)).toBe(value);
		const drained = component.messages.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		expect(component.messages.length).toBe(drained);
		controller.stop();
	});

	it("renders the tool-call boundary synchronously even with a drain pending", () => {
		vi.useFakeTimers();
		const { component, controller } = setup();
		controller.setTarget(text("hi"), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.setTarget(text("yo"), false);
		expect(latestText(component)).toBe("hi");

		const pending = component.messages.length;
		controller.setTarget(text("yo"), true);
		expect(component.messages.length).toBe(pending + 1);
		expect(latestText(component)).toBe("yo");
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 4);
		expect(component.messages.length).toBe(pending + 1);
		controller.stop();
	});

	it("reveals leading text immediately when the stream begins at a tool-call boundary", () => {
		vi.useFakeTimers();
		const component = new RecordingComponent();
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => false,
			getProseOnlyThinking: () => true,
			requestRender: () => {},
		});
		controller.begin(component, text("leading text before the tool"), true);
		expect(latestText(component)).toBe("leading text before the tool");
		controller.stop();
	});

	it("cancels a pending drain when smooth streaming is turned off", () => {
		vi.useFakeTimers();
		let smooth = true;
		const { component, controller } = setup(() => smooth);
		controller.setTarget(text("hi"), false);
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		controller.setTarget(text("yo"), false);

		smooth = false;
		controller.setTarget(text("abcdefghij"), false);
		expect(latestText(component)).toBe("abcdefghij");
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		expect(latestText(component)).toBe("abcdefghij");
		controller.stop();
	});
});
