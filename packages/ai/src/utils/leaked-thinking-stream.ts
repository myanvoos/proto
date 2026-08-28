import { isAnthropicServerToolHistoryBlock } from "../providers/anthropic-wire";
import type {
	AnthropicServerToolContent,
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import {
	clearStreamingPartialJson,
	copyCursorExecResolved,
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "./stream-markup-healing";

type StreamingToolCall = ToolCall & StreamingPartialJsonCarrier;

function cloneToolCall(source: StreamingToolCall): StreamingToolCall {
	const block: StreamingToolCall = { ...source, arguments: source.arguments };
	const partialJson = getStreamingPartialJson(source);
	if (partialJson !== undefined) setStreamingPartialJson(block, partialJson);
	copyCursorExecResolved(block, source);
	return block;
}

function syncToolCall(target: StreamingToolCall, source: StreamingToolCall): void {
	Object.assign(target, source);
	const partialJson = getStreamingPartialJson(source);
	if (partialJson === undefined) clearStreamingPartialJson(target);
	else setStreamingPartialJson(target, partialJson);
	copyCursorExecResolved(target, source);
}

export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: LeakedThinkingProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new LeakedThinkingProjector(out, event.partial);
						break;
					case "text_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.text(
							event.contentIndex,
							event.delta,
							block?.type === "text" ? block.textSignature : undefined,
						);
						break;
					}
					case "thinking_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.thinking(
							event.contentIndex,
							event.delta,
							block?.type === "thinking" ? block.thinkingSignature : undefined,
						);
						break;
					}
					case "thinking_end": {
						const block = event.partial.content[event.contentIndex];
						projector?.thinkingEnd(
							event.contentIndex,
							block?.type === "thinking" ? block.thinkingSignature : undefined,
						);
						break;
					}
					case "image_end":
						projector ??= new LeakedThinkingProjector(out, event.partial);
						projector.image(event.contentIndex, event.content);
						break;
					case "toolcall_start": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.toolStart(event.contentIndex, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_delta": {
						const block = event.partial.content[event.contentIndex];
						projector?.toolDelta(event.contentIndex, event.delta, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_end":
						projector?.toolEnd(event.contentIndex, event.toolCall);
						break;
					case "done": {
						projector ??= new LeakedThinkingProjector(out, event.message);
						const content = projector.finish(event.message);
						out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
						return;
					}
					case "error": {
						projector ??= new LeakedThinkingProjector(out, event.error);
						const content = projector.finish(event.error);
						out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
						return;
					}
				}
			}

			if (!out.done) {
				const result = await inner.result();
				projector ??= new LeakedThinkingProjector(out, result);
				const content = projector.finish(result);
				out.end({ ...result, content });
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type OpenBlock = { index: number } | undefined;
type ProjectedContent = AssistantMessage["content"][number];
type AnchoredContent = { block: ProjectedContent; sourceIndex: number; order: number };

class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;

	#fedTextLengths = new Map<number, number>();

	#activeTextSourceIndex: number | undefined;

	#sourceAnchors = new Map<ProjectedContent, number>();

	#lastTextSignature: string | undefined;

	#toolBlocks = new Map<number, { index: number; block: StreamingToolCall }>();

	#thinkingBlocks = new Map<number, number>();

	#pendingThinkingEnds = new Set<number>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	text(srcIndex: number, delta: string, signature: string | undefined): void {
		const startsSource = this.#activeTextSourceIndex !== srcIndex;
		if (this.#activeTextSourceIndex !== undefined && startsSource) {
			this.#flushHealer();
			this.#closeText();
			this.#closeThinking();
		}
		this.#activeTextSourceIndex = srcIndex;
		this.#fedTextLengths.set(srcIndex, (this.#fedTextLengths.get(srcIndex) ?? 0) + delta.length);
		if (startsSource || signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature, srcIndex);
	}

	thinking(srcIndex: number, delta: string, signature: string | undefined): void {
		let index = this.#thinkingBlocks.get(srcIndex);
		if (index === undefined) {
			if (this.#thinking && this.#pendingThinkingEnds.has(this.#thinking.index)) this.#closeThinking();
			index = this.#openThinking(srcIndex);
			this.#thinkingBlocks.set(srcIndex, index);
			this.#pendingThinkingEnds.add(index);
		}
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

	thinkingEnd(srcIndex: number, signature: string | undefined): void {
		const index = this.#thinkingBlocks.get(srcIndex);
		if (index === undefined) {
			if (signature) this.#projectSignedThinking(srcIndex, "", signature);
			return;
		}
		if (signature !== undefined) {
			(this.#partial.content[index] as ThinkingContent).thinkingSignature = signature;
		}
		if (!this.#pendingThinkingEnds.delete(index)) return;
		if (this.#thinking?.index === index) this.#thinking = undefined;
		this.#emitThinkingEnd(index);
	}

	#projectSignedThinking(srcIndex: number, thinking: string, signature: string): void {
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push({ type: "thinking", thinking, thinkingSignature: signature });
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#thinkingBlocks.set(srcIndex, index);
		this.#out.push({ type: "thinking_start", contentIndex: index, partial: this.#partial });
		this.#emitThinkingEnd(index);
	}

	image(srcIndex: number, content: ImageContent): void {
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push(content);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#out.push({
			type: "image_end",
			contentIndex: index,
			content,
			partial: this.#partial,
		});
	}

	toolStart(srcIndex: number, source: StreamingToolCall | undefined): void {
		if (!source) return;
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(source);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#toolBlocks.set(srcIndex, { index, block });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	toolDelta(srcIndex: number, delta: string, source: StreamingToolCall | undefined): void {
		let entry = this.#toolBlocks.get(srcIndex);
		if (!entry && source) {
			this.toolStart(srcIndex, source);
			entry = this.#toolBlocks.get(srcIndex);
		}
		if (!entry) return;
		if (source) syncToolCall(entry.block, source);
		this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	toolEnd(srcIndex: number, toolCall: ToolCall): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (entry) {
			syncToolCall(entry.block, toolCall);
			this.#out.push({
				type: "toolcall_end",
				contentIndex: entry.index,
				toolCall: entry.block,
				partial: this.#partial,
			});
			this.#toolBlocks.delete(srcIndex);
			return;
		}

		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(toolCall);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

	finish(message: AssistantMessage): AssistantMessage["content"] {
		for (const [srcIndex] of this.#thinkingBlocks) {
			const block = message.content[srcIndex];
			this.thinkingEnd(srcIndex, block?.type === "thinking" ? block.thinkingSignature : undefined);
		}

		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const block = message.content[srcIndex];
			if (block?.type !== "thinking" || !block.thinkingSignature) continue;
			if (this.#thinkingBlocks.has(srcIndex)) continue;
			this.#projectSignedThinking(srcIndex, block.thinking, block.thinkingSignature);
		}
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const block = message.content[srcIndex];
			if (block?.type !== "text") continue;
			const fedLength = this.#fedTextLengths.get(srcIndex) ?? 0;
			if (block.text.length <= fedLength) continue;
			if (this.#activeTextSourceIndex !== undefined && this.#activeTextSourceIndex !== srcIndex) {
				this.#flushHealer();
				this.#closeText();
				this.#closeThinking();
			}
			this.#activeTextSourceIndex = srcIndex;
			this.#lastTextSignature = block.textSignature;
			this.#apply(this.#healer.feedEvents(block.text.slice(fedLength)), this.#lastTextSignature, srcIndex);
		}
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		return this.#mergeServerToolHistory(message);
	}

	#apply(events: readonly StreamMarkupHealingEvent[], signature: string | undefined, srcIndex: number): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature, srcIndex);
			else if (event.type === "thinking") this.#emitHealedThinking(event.thinking, srcIndex);
		}
	}

	#emitText(text: string, signature: string | undefined, srcIndex: number): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			const block: TextContent =
				signature === undefined ? { type: "text", text: "" } : { type: "text", text: "", textSignature: signature };
			this.#partial.content.push(block);
			this.#text = { index: this.#partial.content.length - 1 };
			this.#anchor(this.#text.index, srcIndex);
			this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		} else if (signature !== undefined) {
			(this.#partial.content[this.#text.index] as TextContent).textSignature = signature;
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	#emitHealedThinking(text: string, srcIndex: number): void {
		if (text.length === 0) return;
		const index = this.#openThinking(srcIndex);
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += text;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.#partial });
	}

	#openThinking(srcIndex: number): number {
		this.#closeText();
		if (!this.#thinking) {
			this.#partial.content.push({ type: "thinking", thinking: "" });
			this.#thinking = { index: this.#partial.content.length - 1 };
			this.#anchor(this.#thinking.index, srcIndex);
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
		}
		return this.#thinking.index;
	}

	#flushHealer(): void {
		const srcIndex = this.#activeTextSourceIndex;
		if (srcIndex !== undefined) {
			this.#apply(this.#healer.flushEvents(), this.#lastTextSignature, srcIndex);
		}
		this.#activeTextSourceIndex = undefined;
	}

	#anchor(index: number, srcIndex: number): void {
		const block = this.#partial.content[index];
		if (block) this.#sourceAnchors.set(block, srcIndex);
	}

	#mergeServerToolHistory(message: AssistantMessage): AssistantMessage["content"] {
		const pendingCalls = new Map<string, number>();
		const pairedIndexes = new Set<number>();
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const content = message.content[srcIndex];
			if (content?.type !== "anthropicServerTool" || !isAnthropicServerToolHistoryBlock(content.block)) continue;
			if (content.block.type === "server_tool_use") {
				pendingCalls.set(content.block.id, srcIndex);
				continue;
			}
			const callIndex = pendingCalls.get(content.block.tool_use_id);
			if (callIndex === undefined) continue;
			pairedIndexes.add(callIndex);
			pairedIndexes.add(srcIndex);
			pendingCalls.delete(content.block.tool_use_id);
		}

		const anchored: AnchoredContent[] = this.#partial.content.map((block, order) => ({
			block,
			sourceIndex: this.#sourceAnchors.get(block) ?? message.content.length + order,
			order,
		}));
		for (const srcIndex of pairedIndexes) {
			const content = message.content[srcIndex];
			if (content?.type !== "anthropicServerTool") continue;
			const cloned: AnthropicServerToolContent = {
				type: "anthropicServerTool",
				block: structuredClone(content.block),
			};
			anchored.push({ block: cloned, sourceIndex: srcIndex, order: srcIndex });
		}
		anchored.sort((left, right) => left.sourceIndex - right.sourceIndex || left.order - right.order);
		return anchored.map(({ block }) => block);
	}
	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		this.#out.push({ type: "text_end", contentIndex: this.#text.index, content: block.text, partial: this.#partial });
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const index = this.#thinking.index;
		this.#thinking = undefined;
		if (this.#pendingThinkingEnds.has(index)) return;
		this.#emitThinkingEnd(index);
	}

	#emitThinkingEnd(index: number): void {
		const block = this.#partial.content[index] as ThinkingContent;
		this.#out.push({
			type: "thinking_end",
			contentIndex: index,
			content: block.thinking,
			partial: this.#partial,
		});
	}
}
