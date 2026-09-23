import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent } from "../dialect/types";
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
					case "text_end": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.textEnd(
							event.contentIndex,
							event.content,
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

class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	#healer = new ThinkingInbandScanner({ impliedOpen: true });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;

	#fedText = new Map<number, string>();
	#endedTextSources = new Set<number>();

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
		this.#fedText.set(srcIndex, (this.#fedText.get(srcIndex) ?? "") + delta);
		if (startsSource || signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feed(delta), this.#lastTextSignature, srcIndex);
	}

	textEnd(srcIndex: number, content: string, signature: string | undefined): void {
		const fed = this.#fedText.get(srcIndex) ?? "";
		const alreadyEnded = this.#endedTextSources.has(srcIndex);
		this.#endedTextSources.add(srcIndex);
		if (!content.startsWith(fed) || (alreadyEnded && content !== fed)) {
			this.#replaceText(srcIndex, content, signature);
			return;
		}
		if (content.length > fed.length) this.text(srcIndex, content.slice(fed.length), signature);
		if (this.#activeTextSourceIndex === srcIndex) {
			this.#lastTextSignature = signature;
			this.#flushHealer();
		}
		for (const block of this.#partial.content) {
			if (block.type !== "text" || this.#sourceAnchors.get(block) !== srcIndex) continue;
			if (signature === undefined) delete block.textSignature;
			else block.textSignature = signature;
		}
		if (this.#text && this.#sourceAnchors.get(this.#partial.content[this.#text.index]) === srcIndex)
			this.#closeText();
		if (this.#thinking && this.#sourceAnchors.get(this.#partial.content[this.#thinking.index]) === srcIndex)
			this.#closeThinking();
	}

	#replaceText(srcIndex: number, content: string, signature: string | undefined): void {
		// A terminal snapshot can replace, not merely extend, the streamed draft.
		// Re-run markup healing from a clean state so stale tag/parser state cannot
		// turn the replacement into thinking or retain removed draft fragments.
		const healer = new ThinkingInbandScanner({ impliedOpen: true });
		const replacement: (TextContent | ThinkingContent)[] = [];
		const leadsMessage = !this.#partial.content.some(block => {
			const source = this.#sourceAnchors.get(block);
			return source !== undefined && source < srcIndex;
		});
		for (const event of [...healer.feed(content), ...healer.flush()]) {
			const last = replacement.at(-1);
			if (event.type === "impliedThinkingEnd") {
				// Same rule as #closeImpliedThinking: only a lone leading text block was reasoning.
				if (leadsMessage && replacement.length === 1 && last?.type === "text" && last.text.trim().length > 0)
					replacement[0] = { type: "thinking", thinking: last.text };
			} else if (event.type === "text") {
				if (last?.type === "text") last.text += event.text;
				else
					replacement.push({
						type: "text",
						text: event.text,
						...(signature !== undefined ? { textSignature: signature } : {}),
					});
			} else if (event.type === "thinkingDelta") {
				if (last?.type === "thinking") last.thinking += event.delta;
				else replacement.push({ type: "thinking", thinking: event.delta });
			}
		}
		if (replacement.length === 0)
			replacement.push({ type: "text", text: "", ...(signature !== undefined ? { textSignature: signature } : {}) });
		const previous = this.#partial.content;
		const next: ProjectedContent[] = [];
		let inserted = false;
		for (const block of previous) {
			const source = this.#sourceAnchors.get(block);
			if (!inserted && source !== undefined && source >= srcIndex) {
				next.push(...replacement);
				inserted = true;
			}
			if (source === srcIndex) this.#sourceAnchors.delete(block);
			else next.push(block);
		}
		if (!inserted) next.push(...replacement);
		for (const block of replacement) this.#sourceAnchors.set(block, srcIndex);
		const indexes = new Map(next.map((block, index) => [block, index]));
		const remap = (index: number): number | undefined => indexes.get(previous[index]);
		const textIndex = this.#text ? remap(this.#text.index) : undefined;
		const thinkingIndex = this.#thinking ? remap(this.#thinking.index) : undefined;
		this.#text = textIndex === undefined ? undefined : { index: textIndex };
		this.#thinking = thinkingIndex === undefined ? undefined : { index: thinkingIndex };
		for (const [source, entry] of this.#toolBlocks) {
			const index = remap(entry.index);
			if (index === undefined) this.#toolBlocks.delete(source);
			else entry.index = index;
		}
		for (const [source, previousIndex] of this.#thinkingBlocks) {
			const index = remap(previousIndex);
			if (index === undefined) this.#thinkingBlocks.delete(source);
			else this.#thinkingBlocks.set(source, index);
		}
		this.#pendingThinkingEnds = new Set(
			[...this.#pendingThinkingEnds].flatMap(index => {
				const mapped = remap(index);
				return mapped === undefined ? [] : [mapped];
			}),
		);
		if (this.#activeTextSourceIndex === srcIndex) {
			this.#healer = new ThinkingInbandScanner({ impliedOpen: true });
			this.#activeTextSourceIndex = undefined;
		}
		this.#fedText.set(srcIndex, content);
		// Keep previous event snapshots and their indices intact; subsequent events
		// use the remapped current snapshot, including any tool still streaming.
		this.#partial = { ...this.#partial, content: next };
		for (const block of replacement) {
			const contentIndex = indexes.get(block)!;
			if (block.type === "text")
				this.#out.push({ type: "text_end", contentIndex, content: block.text, partial: this.#partial });
			else this.#emitThinkingEnd(contentIndex);
		}
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
			this.textEnd(srcIndex, block.text, block.textSignature);
		}
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		return this.#finalContent(message);
	}

	#apply(events: readonly InbandScanEvent[], signature: string | undefined, srcIndex: number): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature, srcIndex);
			else if (event.type === "thinkingDelta") this.#emitHealedThinking(event.delta, srcIndex);
			else if (event.type === "impliedThinkingEnd") this.#closeImpliedThinking(srcIndex);
		}
	}

	/**
	 * A bare reasoning close with no open: when the open text block is the message's
	 * only content, it was reasoning behind a template-prefilled opener, so re-project
	 * it as a closed thinking block at the same index (`thinking_start` at an index
	 * replaces the block for event-replaying consumers). Anywhere else the tag is a
	 * stray and is dropped so it never reaches the stored turn.
	 */
	#closeImpliedThinking(srcIndex: number): void {
		if (this.#text?.index !== 0 || this.#partial.content.length !== 1) return;
		const text = (this.#partial.content[0] as TextContent).text;
		if (text.trim().length === 0) return;
		this.#closeText();
		const block: ThinkingContent = { type: "thinking", thinking: text };
		this.#partial.content[0] = block;
		this.#anchor(0, srcIndex);
		this.#out.push({ type: "thinking_start", contentIndex: 0, partial: this.#partial });
		this.#out.push({ type: "thinking_delta", contentIndex: 0, delta: text, partial: this.#partial });
		this.#emitThinkingEnd(0);
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
			this.#apply(this.#healer.flush(), this.#lastTextSignature, srcIndex);
		}
		this.#activeTextSourceIndex = undefined;
	}

	#anchor(index: number, srcIndex: number): void {
		const block = this.#partial.content[index];
		if (block) this.#sourceAnchors.set(block, srcIndex);
	}

	#finalContent(message: AssistantMessage): AssistantMessage["content"] {
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

		const textBySource = new Map<number, ProjectedContent[]>();
		for (const block of this.#partial.content) {
			const sourceIndex = this.#sourceAnchors.get(block);
			if (sourceIndex === undefined || message.content[sourceIndex]?.type !== "text") continue;
			const blocks = textBySource.get(sourceIndex) ?? [];
			blocks.push(block);
			textBySource.set(sourceIndex, blocks);
		}
		const content: AssistantMessage["content"] = [];
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const block = message.content[srcIndex];
			if (block.type === "text") {
				content.push(...(textBySource.get(srcIndex) ?? [{ ...block, text: "" }]));
			} else if (block.type === "toolCall") {
				content.push(cloneToolCall(block));
			} else if (block.type === "anthropicServerTool") {
				if (!pairedIndexes.has(srcIndex)) continue;
				const cloned: AnthropicServerToolContent = {
					type: "anthropicServerTool",
					block: structuredClone(block.block),
				};
				content.push(cloned);
			} else {
				content.push({ ...block });
			}
		}
		return content;
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
