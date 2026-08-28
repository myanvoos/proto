import { isDeepseekModelIdOrName } from "@oh-my-pi/pi-catalog/identity";

import { createInbandScanner } from "../dialect/factory";
import { QwenXmlInbandScanner } from "../dialect/qwen-xml";
import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent, InbandScanner } from "../dialect/types";

const KIMI_SECTION_END = "<|tool_calls_section_end|>";
const DSML_TOOL_CALLS_CLOSE_FULLWIDTH = "</｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE_ASCII = "</|DSML|tool_calls>";

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

export type StreamMarkupHealingPattern = "kimi" | "dsml" | "qwen" | "thinking";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;

	readonly #toolScanner: InbandScanner | undefined;

	readonly #thinkingScanner = new ThinkingInbandScanner();
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
		this.#toolScanner =
			options.pattern === "kimi"
				? createInbandScanner("kimi")
				: options.pattern === "dsml"
					? createInbandScanner("xml", { xmlTagset: "dsml" })
					: options.pattern === "qwen"
						? new QwenXmlInbandScanner()
						: undefined;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#markSectionClosed(text);
		if (!this.#toolScanner) return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
		return this.#convertScannerEvents(this.#healThinking(this.#toolScanner.feed(text)));
	}

	feedEventsWithoutCalls(text: string): StreamMarkupHealingEvent[] {
		const events = this.feedEvents(text);
		let out: StreamMarkupHealingEvent[] | undefined;
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!;
			if (event.type === "toolCall") {
				out ??= events.slice(0, i);
			} else if (out) {
				out.push(event);
			}
		}
		return out ?? events;
	}

	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#toolScanner ? this.#healThinking(this.#toolScanner.flush()) : [];
		tail.push(...this.#thinkingScanner.flush());
		return this.#convertScannerEvents(tail);
	}

	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#markSectionClosed(text: string): void {
		if (this.#sectionTerminated || !this.#toolScanner) return;
		if (this.#pattern === "kimi") {
			this.#sectionTerminated = text.includes(KIMI_SECTION_END);
			return;
		}
		if (this.#pattern === "qwen") {
			this.#sectionTerminated = text.includes("</tool_calls>");
			return;
		}
		this.#sectionTerminated =
			text.includes(DSML_TOOL_CALLS_CLOSE_FULLWIDTH) || text.includes(DSML_TOOL_CALLS_CLOSE_ASCII);
	}

	#healThinking(toolEvents: readonly InbandScanEvent[]): InbandScanEvent[] {
		const out: InbandScanEvent[] = [];
		for (const event of toolEvents) {
			if (event.type === "text") out.push(...this.#thinkingScanner.feed(event.text));
			else out.push(event);
		}
		return out;
	}

	#convertScannerEvents(events: readonly InbandScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "toolEnd":
					out.push({
						type: "toolCall",
						call: {
							id: generateHealedToolCallId(),
							name: event.name,
							arguments: JSON.stringify(event.arguments),
						},
					});
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "toolStart":
				case "toolArgDelta":
					break;
			}
		}
		return out;
	}
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	if (!isDeepseekModelIdOrName(modelId)) return false;
	return (
		provider === "ollama" ||
		provider === "ollama-cloud" ||
		provider === "nvidia" ||
		provider === "deepseek" ||
		provider === "fireworks" ||
		provider === "nanogpt" ||
		provider === "opencode-go" ||
		provider === "openrouter"
	);
}

export function getStreamMarkupHealingPattern(provider: string, modelId: string): StreamMarkupHealingPattern {
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return "thinking";
}
