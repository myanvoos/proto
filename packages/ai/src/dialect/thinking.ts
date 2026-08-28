import { partialSuffixOverlapAny } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandScanner } from "./types";

type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

const TAGS: readonly Tag[] = [
	{ open: "<think>", close: "</think>" },
	{ open: "<thinking>", close: "</thinking>" },
	{ open: "<scratchpad>", close: "</scratchpad>" },
	{ open: "```thinking\n", close: "```", fenced: true },
	{ open: "<|channel>thought\n", close: "<channel|>" },
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" },
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" },
];
const OPENS = TAGS.map(tag => tag.open);

export class ThinkingInbandScanner implements InbandScanner {
	#buffer = "";
	#closeTag = "";
	#thinking = "";

	#fenced: FencedThinkingScanner | undefined;

	#codeTicks = 0;

	#codeFenced = false;

	#lineIndent = 0;

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		return events;
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const close = this.#buffer.indexOf(this.#closeTag);
				if (close === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [this.#closeTag]);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, close), events);
				this.#buffer = this.#buffer.slice(close + this.#closeTag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				continue;
			}
			if (this.#codeTicks > 0) {
				if (this.#emitCode(final, events)) continue;
				break;
			}

			const hit = scanVisible(this.#buffer, final);
			if (hit.kind === "none") {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				break;
			}
			if (hit.index > 0) this.#emitText(this.#buffer.slice(0, hit.index), events);
			if (hit.kind === "hold") {
				this.#buffer = this.#buffer.slice(hit.index);
				break;
			}
			if (hit.kind === "code") {
				const fenced = hit.ticks >= 3 && this.#lineIndent >= 0 && this.#lineIndent <= 3;
				this.#emitText(this.#buffer.slice(hit.index, hit.index + hit.ticks), events);
				this.#buffer = this.#buffer.slice(hit.index + hit.ticks);
				this.#codeTicks = hit.ticks;
				this.#codeFenced = fenced;
				continue;
			}
			this.#buffer = this.#buffer.slice(hit.index + hit.tag.open.length);
			this.#closeTag = hit.tag.close;
			this.#thinking = "";
			if (hit.tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	#emitCode(final: boolean, events: InbandScanEvent[]): boolean {
		if (this.#codeFenced) {
			const end = findFenceCloseEnd(this.#buffer, this.#codeTicks, final);
			if (end !== -1) {
				this.#emitText(this.#buffer.slice(0, end), events);
				this.#buffer = this.#buffer.slice(end);
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return true;
			}
			if (final) {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return false;
			}

			const lastNl = this.#buffer.lastIndexOf("\n");
			if (lastNl !== -1) {
				this.#emitText(this.#buffer.slice(0, lastNl + 1), events);
				this.#buffer = this.#buffer.slice(lastNl + 1);
			}
			return false;
		}
		const close = findBacktickRun(this.#buffer, 0, this.#codeTicks);
		if (close !== -1 && (final || close + this.#codeTicks < this.#buffer.length)) {
			this.#emitText(this.#buffer.slice(0, close + this.#codeTicks), events);
			this.#buffer = this.#buffer.slice(close + this.#codeTicks);
			this.#codeTicks = 0;
			return true;
		}

		const hold = final ? 0 : trailingBacktickRun(this.#buffer);
		this.#emitText(this.#buffer.slice(0, this.#buffer.length - hold), events);
		this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
		if (final) this.#codeTicks = 0;
		return false;
	}

	#emitText(text: string, events: InbandScanEvent[]): void {
		if (text.length === 0) return;
		events.push({ type: "text", text });
		this.#lineIndent = trailingLineIndent(text, this.#lineIndent);
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

type VisibleHit =
	| { readonly kind: "tag"; readonly index: number; readonly tag: Tag }
	| { readonly kind: "code"; readonly index: number; readonly ticks: number }
	| { readonly kind: "hold"; readonly index: number }
	| { readonly kind: "none" };

function scanVisible(buffer: string, final: boolean): VisibleHit {
	for (let i = 0; i < buffer.length; i++) {
		const tag = TAGS.find(candidate => buffer.startsWith(candidate.open, i));
		if (tag) return { kind: "tag", index: i, tag };
		if (!final) {
			const rest = buffer.slice(i);
			if (OPENS.some(open => open.length > rest.length && open.startsWith(rest))) {
				return { kind: "hold", index: i };
			}
		}
		if (buffer[i] === "`") {
			const ticks = backtickRun(buffer, i);
			if (!final && i + ticks === buffer.length) return { kind: "hold", index: i };
			return { kind: "code", index: i, ticks };
		}
	}
	return { kind: "none" };
}

function backtickRun(buffer: string, from: number): number {
	let end = from;
	while (end < buffer.length && buffer[end] === "`") end++;
	return end - from;
}

function findBacktickRun(buffer: string, from: number, ticks: number): number {
	for (let i = buffer.indexOf("`", from); i !== -1; i = buffer.indexOf("`", i)) {
		const run = backtickRun(buffer, i);
		if (run === ticks) return i;
		i += run;
	}
	return -1;
}

function trailingBacktickRun(buffer: string): number {
	let start = buffer.length;
	while (start > 0 && buffer[start - 1] === "`") start--;
	return buffer.length - start;
}

function trailingLineIndent(text: string, prior: number): number {
	const lastNl = text.lastIndexOf("\n");
	let indent = lastNl === -1 ? prior : 0;
	for (let i = lastNl + 1; i < text.length; i++) {
		if (indent === -1) break;
		indent = text[i] === " " ? indent + 1 : -1;
	}
	return indent;
}

function findFenceCloseEnd(buffer: string, ticks: number, final: boolean): number {
	for (let start = 0; start <= buffer.length; ) {
		const nl = buffer.indexOf("\n", start);
		const terminated = nl !== -1;
		const line = buffer.slice(start, terminated ? nl : buffer.length).trim();
		if (line.length >= ticks && isAllBackticks(line) && (terminated || final)) {
			return terminated ? nl + 1 : buffer.length;
		}
		if (!terminated) break;
		start = nl + 1;
	}
	return -1;
}

function isAllBackticks(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text[i] !== "`") return false;
	return text.length > 0;
}
