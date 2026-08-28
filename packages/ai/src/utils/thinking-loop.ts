import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

const EXACT_TAIL_WINDOW = 4096;

const EXACT_MAX_UNIT = 1024;

const EXACT_CHECK_STRIDE = 128;

const EXACT_SHORT_MAX_UNIT = 60;
const EXACT_SHORT_MIN_REPEATED_CHARS = 180;

const EXACT_LONG_MIN_REPEATED_CHARS = 1024;

const SEGMENT_CHAR_CAP = 700;

const SEGMENT_MIN_NORM_CHARS = 60;

const SEGMENT_WINDOW = 16;

const SEGMENT_SIMILARITY = 0.8;

const SEGMENT_MIN_COUNT = 8;

const SEGMENT_MIN_CLUSTER = 4;

const LEX_NOVELTY_WINDOW = 8;

const LEX_STALL_NOVELTY_FLOOR = 0.2;

const LEX_STALL_MIN_RUN = 8;

const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

export function isLoopGuardedModel(model: Model<Api>, options?: StreamOptions): boolean {
	if (options?.loopGuard?.enabled === false) return false;
	switch (modelFamilyToken(model.id)) {
		case "gemini":
		case "deepseek":
		case "grok":
			return true;
		default:
			return false;
	}
}

export class ThinkingLoopDetector {
	#tail = "";

	#exactScannedAt = 0;

	#pending = "";

	#window: Set<string>[] = [];

	#count = 0;

	#wordWindow: Set<string>[] = [];

	#lexStallRun = 0;

	#anchorWindow: Set<string>[] = [];

	constructor(private readonly semanticHeuristics = true) {}

	push(delta: string): string | null {
		if (!delta) return null;

		this.#tail += delta;
		if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
		this.#exactScannedAt += delta.length;
		if (this.#exactScannedAt >= EXACT_CHECK_STRIDE || delta.length >= EXACT_CHECK_STRIDE) {
			this.#exactScannedAt = 0;
			const exact = detectExactSuffixCycle(this.#tail);
			if (exact) {
				const [unit, times] = exact;
				return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
			}
		}

		if (!this.semanticHeuristics) return null;

		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}

			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

	flush(): string | null {
		const exact = detectExactSuffixCycle(this.#tail);
		if (exact) {
			const [unit, times] = exact;
			return `repeated an exact ${unit.length}-character cycle ${times}× back-to-back`;
		}
		if (!this.semanticHeuristics || !this.#pending) return null;
		let rest = this.#pending;
		this.#pending = "";
		while (rest.length > 0) {
			const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
			rest = rest.slice(chunk.length);
			const hit = this.#consumeSegment(chunk);
			if (hit) return hit;
		}
		return null;
	}

	#consumeSegment(raw: string): string | null {
		const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		const words = new Set<string>(normalized.split(" ").filter(Boolean));
		const priorVocab = new Set<string>();
		for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w);
		let unseen = 0;
		for (const w of words) if (!priorVocab.has(w)) unseen++;
		const novelty = priorVocab.size === 0 ? 1 : unseen / words.size;

		const anchors = new Set<string>();

		for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase());
		let newAnchor = false;
		for (const anchor of anchors) {
			if (this.#anchorWindow.every(seen => !seen.has(anchor))) {
				newAnchor = true;
				break;
			}
		}

		if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) {
			this.#lexStallRun++;
		} else {
			this.#lexStallRun = 0;
		}

		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		this.#wordWindow.push(words);
		if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift();
		this.#anchorWindow.push(anchors);
		if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift();
		this.#count++;

		if (this.#count >= SEGMENT_MIN_COUNT) {
			if (cluster >= SEGMENT_MIN_CLUSTER) {
				return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
			}
			if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
				return `${this.#lexStallRun} low-information segments recycling recent wording`;
			}
		}
		return null;
	}
}

export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 24;

export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

export class GeminiHeaderRunDetector {
	#pending = "";

	#count = 0;

	#fired = false;

	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const line = this.#pending.slice(0, nl).trim();
			this.#pending = this.#pending.slice(nl + 1);
			if (line !== "" && isReasoningSummaryHeader(line) && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n");
		}
		return false;
	}

	get count(): number {
		return this.#count;
	}

	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}

export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const semanticHeuristics = isLoopGuardedModel(model, options);
	const thinkingDetector = new ThinkingLoopDetector(semanticHeuristics);
	const textDetector = new ThinkingLoopDetector(semanticHeuristics);
	const checkAssistantContent = options?.loopGuard?.checkAssistantContent !== false;

	void (async () => {
		let thinkingArmed = true;
		let textArmed = checkAssistantContent;
		let textStarted = false;
		try {
			for await (const event of inner) {
				let detail: string | null = null;
				if (event.type === "thinking_delta") {
					if (!textStarted) {
						thinkingArmed = true;
						detail = thinkingDetector.push(event.delta);
					}
				} else if (event.type === "thinking_end") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
				} else if (event.type === "text_start") {
				} else if (event.type === "text_delta") {
					if (event.delta.length > 0) {
						thinkingArmed = false;
						textStarted = true;
					}
					if (textArmed) {
						detail = textDetector.push(event.delta);
					}
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
					textArmed = false;
				} else if (event.type === "done") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
					if (textArmed) {
						detail = detail || textDetector.flush();
					}
				}
				if (detail) {
					logger.warn("Thinking loop detected; aborting stream for retry.", {
						model: model.id,
						provider: model.provider,
						detail,
					});
					controller.abort(
						AIError.attach(new Error(THINKING_LOOP_ERROR_MARKER), AIError.create(AIError.Flag.ThinkingLoop)),
					);
					outer.push({
						type: "error",
						reason: "error",
						error: buildThinkingLoopError(model, detail),
					});
					return;
				}
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (err) {
					outer.fail(err);
				}
			}
		} catch (err) {
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}

export function withThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (process.env.PI_NO_THINKING_LOOP_GUARD === "1" || options?.loopGuard?.enabled === false) {
		return dispatch(options);
	}
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...(options ?? {}), signal } as O;
	return guardThinkingLoopStream(dispatch(merged), model, controller, options);
}

function buildThinkingLoopError(model: Model<Api>, detail: string): AssistantMessage {
	return {
		role: "assistant",

		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",

		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`,
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
		timestamp: Date.now(),
	};
}

function detectExactSuffixCycle(text: string): [unit: string, count: number] | null {
	if (text.length < EXACT_SHORT_MIN_REPEATED_CHARS) return null;
	const reversed = text.split("").reverse().join("");
	const z = new Uint16Array(reversed.length);
	let left = 0;
	let right = 0;
	for (let i = 1; i < reversed.length; i++) {
		if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]);
		while (i + z[i] < reversed.length && reversed[z[i]] === reversed[i + z[i]]) z[i]++;
		if (i + z[i] - 1 > right) {
			left = i;
			right = i + z[i] - 1;
		}
	}

	const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(reversed.length / 3));
	for (let len = 2; len <= maxUnit; len++) {
		const count = 1 + Math.floor(z[len] / len);
		const minCount = len <= EXACT_SHORT_MAX_UNIT ? 4 : 3;
		const minChars = len <= EXACT_SHORT_MAX_UNIT ? EXACT_SHORT_MIN_REPEATED_CHARS : EXACT_LONG_MIN_REPEATED_CHARS;
		if (count < minCount || len * count < minChars) continue;
		const unit = text.slice(-len);
		if (/\p{L}|\p{Extended_Pictographic}/u.test(unit)) return [unit, count];
	}
	return null;
}

function normalizeSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(token => /[a-z]/.test(token))
		.join(" ")
		.trim();
}

function trigramShingles(normalized: string): Set<string> {
	const words = normalized.split(" ").filter(Boolean);
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
