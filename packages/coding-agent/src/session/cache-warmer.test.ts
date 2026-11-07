/**
 * The cache warmer's contract: when it schedules a replay, what it does with the
 * replay's outcome, and what the session can read back afterwards. The replay's
 * economics and stream handling are exercised through a scripted provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	CacheWarmer,
	type CacheWarmerDeps,
	type CacheWarmingRefreshEnd,
	type CacheWarmingRefreshStart,
	type CacheWarmStream,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
	type PromptCacheChange,
} from "./cache-warmer";

const SHORT_DELAY_MS = 4.5 * 60_000; // 90% of the 300s short tier
const PROMPT_TOKENS = 100_000;

function makeModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: { supportsLongCacheRetention: true } as Model["compat"],
		...overrides,
	} as Model;
}

function makeUsage(tokens: Partial<Pick<Usage, "cacheRead" | "cacheWrite" | "output" | "cttl">>): Usage {
	const usage: Usage = {
		input: 1,
		output: tokens.output ?? 0,
		cacheRead: tokens.cacheRead ?? 0,
		cacheWrite: tokens.cacheWrite ?? 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(tokens.cttl ? { cttl: tokens.cttl } : {}),
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

function makeMessage(usage: Usage, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage,
		stopReason,
	};
}

type ReplayScript =
	/** Envelope carries `usage`, then the model starts generating (the warmer cuts it off). */
	| { kind: "generate"; usage: Usage }
	/** The replay completes without generating (e.g. a one-token cap on a non-thinking model). */
	| { kind: "done"; usage: Usage }
	/** The provider rejects the replay. */
	| { kind: "error" };

interface ReplayRecord {
	options?: SimpleStreamOptions;
	consumed: AssistantMessageEvent["type"][];
	cutOff: boolean;
}

/** A provider event stream that honors the replay's abort signal like a real stream. */
function scriptedStream(script: ReplayScript, record: ReplayRecord): CacheWarmStream {
	const signal = record.options?.signal;
	const events: AssistantMessageEvent[] = [];
	let final: AssistantMessage;
	if (script.kind === "error") {
		final = makeMessage(makeUsage({}), "error");
		events.push({ type: "error", reason: "error", error: final });
	} else {
		const partial = makeMessage(script.usage);
		events.push({ type: "start", partial });
		if (script.kind === "generate") {
			events.push({ type: "thinking_start", contentIndex: 0, partial });
			events.push({ type: "thinking_delta", contentIndex: 0, delta: "more thinking", partial });
		}
		final = script.kind === "done" ? partial : makeMessage(script.usage, "aborted");
		if (script.kind === "done") events.push({ type: "done", reason: "stop", message: final });
	}
	return {
		async *[Symbol.asyncIterator]() {
			try {
				for (const event of events) {
					if (signal?.aborted) return;
					record.consumed.push(event.type);
					yield event;
				}
			} finally {
				record.cutOff = signal?.aborted === true;
			}
		},
		result: () => Promise.resolve(final),
	};
}

interface Harness {
	warmer: CacheWarmer;
	replays: ReplayRecord[];
	script: ReplayScript;
	promptTokens: number;
	mode: "off" | "streaming" | "idle";
	current: boolean;
	warmed: Array<{ message: AssistantMessage; extensionOverride: boolean }>;
	refreshes: Array<({ type: "start" } & CacheWarmingRefreshStart) | ({ type: "end" } & CacheWarmingRefreshEnd)>;
}

function harness(overrides: Partial<CacheWarmerDeps> = {}): Harness {
	const state: Omit<Harness, "warmer"> = {
		replays: [],
		script: { kind: "generate", usage: makeUsage({ cacheRead: PROMPT_TOKENS }) },
		promptTokens: PROMPT_TOKENS,
		mode: "idle",
		current: true,
		warmed: [],
		refreshes: [],
	};
	const warmer = new CacheWarmer({
		stream: (_model, _context, options) => {
			const record: ReplayRecord = { options, consumed: [], cutOff: false };
			state.replays.push(record);
			return scriptedStream(state.script, record);
		},
		getPromptTokens: () => state.promptTokens,
		getMode: () => state.mode,
		...overrides,
	});
	warmer.onWarmed = (message, extensionOverride) => {
		state.warmed.push({ message, extensionOverride });
	};
	warmer.onRefreshStart = refresh => state.refreshes.push({ type: "start", ...refresh });
	warmer.onRefreshEnd = refresh => state.refreshes.push({ type: "end", ...refresh });
	return Object.assign(state, { warmer });
}

async function drain(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

function change(h: Harness): PromptCacheChange | undefined {
	return h.current ? undefined : { kind: "history" };
}

function start(h: Harness, options: SimpleStreamOptions = {}): void {
	h.warmer.start({ model: makeModel(), context: { messages: [] }, options }, () => change(h));
}

async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await drain();
}

describe("cache warming scheduling math", () => {
	test("schedules at 90% of the TTL with a ten-second margin", () => {
		expect(getCacheWarmingDelayMs(300_000)).toBe(270_000);
		expect(getCacheWarmingDelayMs(3600_000)).toBe(3_240_000);
	});

	test("clamps to at least one millisecond and refuses tiny lifetimes", () => {
		expect(getCacheWarmingDelayMs(10_001)).toBe(1);
		expect(getCacheWarmingDelayMs(10_000)).toBeUndefined();
		expect(getCacheWarmingDelayMs(5_000)).toBeUndefined();
	});

	test("reads the tier matching the request retention and the OAuth default", () => {
		// PI_CACHE_RETENTION feeds the default tier; scrub it so the
		// undefined-options assertions hold on any developer/CI environment.
		const savedRetention = process.env.PI_CACHE_RETENTION;
		delete process.env.PI_CACHE_RETENTION;
		try {
			const model = makeModel();
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3_600_000);
			expect(getPromptCacheTtlMs(model, undefined)).toBe(300_000);
			// OAuth seats default to the 1h tier, but an explicit retention still wins.
			expect(getPromptCacheTtlMs(model, undefined, true)).toBe(3_600_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" }, true)).toBe(300_000);
		} finally {
			if (savedRetention !== undefined) process.env.PI_CACHE_RETENTION = savedRetention;
		}
	});

	test("uses the actual short TTL when long retention is unsupported", () => {
		const bedrock = makeModel({
			id: "anthropic.claude-opus-5-5",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
			compat: { supportsLongCacheRetention: false } as Model["compat"],
		});
		expect(getPromptCacheTtlMs(bedrock, { cacheRetention: "long" })).toBe(300_000);

		const converse = makeModel({
			id: "us.anthropic.claude-opus-5-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			compat: {
				promptCacheMode: "explicit",
				supportsLongPromptCacheRetention: false,
				promptCacheMinimumTokens: 0,
				promptCacheMaximumCheckpoints: 2,
			} as Model["compat"],
		});
		expect(getPromptCacheTtlMs(converse, { cacheRetention: "long" })).toBe(300_000);
		(converse.compat as { supportsLongPromptCacheRetention: boolean }).supportsLongPromptCacheRetention = true;
		expect(getPromptCacheTtlMs(converse, { cacheRetention: "long" })).toBe(3_600_000);
	});

	test("never warms a provider that declares no lifetime, or with caching off", () => {
		expect(getPromptCacheTtlMs(makeModel({ api: "openai-completions" }), undefined)).toBeUndefined();
		expect(getPromptCacheTtlMs(makeModel(), { cacheRetention: "none" })).toBeUndefined();
	});

	test("rejects budget-based reasoning replays but preserves adaptive and effort models", () => {
		const model = makeModel();
		model.thinking = { mode: "anthropic-budget-effort", efforts: [Effort.High] };
		expect(isReplayable(model, { reasoning: Effort.High })).toBe(false);
		model.thinking = { mode: "anthropic-adaptive", efforts: [Effort.High] };
		expect(isReplayable(model, { reasoning: Effort.High })).toBe(true);
		expect(isReplayable(model, { reasoning: Effort.High, forceReasoningOff: true })).toBe(true);
		expect(isReplayable(model, undefined)).toBe(true);
	});
});

describe("cache warmer lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("cuts the replay off at the first generated block and re-arms on a cache hit", async () => {
		const h = harness();
		start(h);
		expect(h.warmer.status.state).toBe("scheduled");
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		expect(h.replays[0]?.options?.maxTokens).toBe(1);
		expect(h.replays[0]?.cutOff).toBe(true);
		expect(h.replays[0]?.consumed).toEqual(["start", "thinking_start"]);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]?.message.usage.cacheRead).toBe(PROMPT_TOKENS);
		expect(h.warmed[0]?.message.usage.cost.total).toBeGreaterThan(0);
		expect(h.warmer.status.state).toBe("scheduled");
		expect(h.refreshes.map(event => event.type)).toEqual(["start", "end"]);
		expect(h.refreshes[1]).toMatchObject({ outcome: "hit", usage: h.warmed[0]?.message.usage });
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(2);
	});

	test("stops after a refresh that re-wrote the prefix, but keeps the entry it wrote", async () => {
		const h = harness();
		h.script = { kind: "done", usage: makeUsage({ cacheWrite: PROMPT_TOKENS, output: 1 }) };
		start(h);
		const sentAt = Date.now() + SHORT_DELAY_MS;
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		// The paid miss is still recorded.
		expect(h.warmed).toHaveLength(1);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "refresh missed the cache" });
		expect(h.refreshes[1]).toMatchObject({
			outcome: "miss",
			usage: h.warmed[0]?.message.usage,
			warmingStopReason: "refresh missed the cache",
		});
		// What the rewrite wrote, the next request reads: a new lifetime from its send.
		expect(h.warmer.confirmedEntry).toMatchObject({ touchedAt: sentAt, refreshMissed: false });
		await advance(SHORT_DELAY_MS * 4);
		expect(h.replays).toHaveLength(1);
	});

	test("stops after a failed refresh instead of retrying every interval", async () => {
		const rejected = harness();
		rejected.script = { kind: "error" };
		start(rejected);
		await advance(SHORT_DELAY_MS);
		expect(rejected.warmer.status).toMatchObject({ state: "inactive", reason: "refresh failed" });
		expect(rejected.refreshes.map(event => event.type)).toEqual(["start", "end"]);
		expect(rejected.refreshes[1]).toMatchObject({
			outcome: "error",
			usage: rejected.warmed[0]?.message.usage,
			warmingStopReason: "refresh failed",
		});

		const thrown = harness({
			stream: () => {
				throw new Error("network down");
			},
		});
		start(thrown);
		await advance(SHORT_DELAY_MS);
		expect(thrown.warmer.status).toMatchObject({ state: "inactive", reason: "refresh failed" });
		expect(thrown.warmed).toEqual([]);
	});

	test("stops with the below-threshold reason for a tiny context", async () => {
		const h = harness();
		h.promptTokens = 1_000;
		start(h);
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(0);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
		expect(h.refreshes).toEqual([]);
	});

	test("idle phase uses a continuation probability", async () => {
		const h = harness();
		start(h);
		await advance(SHORT_DELAY_MS);
		expect(h.replays).toHaveLength(1);
		h.warmer.onAgentSettled();
		await advance(SHORT_DELAY_MS);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
	});

	test("streaming mode stops once the run settles, while idle keeps warming", async () => {
		const streaming = harness();
		streaming.mode = "streaming";
		start(streaming);
		await advance(SHORT_DELAY_MS);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status).toMatchObject({ state: "inactive", reason: "agent run settled" });

		const idle = harness();
		start(idle);
		idle.warmer.onAgentSettled();
		expect(idle.warmer.status.state).toBe("scheduled");
	});

	test("counts the entry's lifetime from the dispatch hook, not from arming", () => {
		const h = harness();
		h.mode = "off";
		const dispatched = h.warmer.start(
			{ model: makeModel(), context: { messages: [] }, options: {} },
			() => undefined,
		);
		vi.advanceTimersByTime(30_000);
		dispatched();
		expect(h.warmer.cacheEntry).toBeUndefined();
		expect(h.warmer.confirmedEntry).toBeUndefined();
		// The pending entry is only published once a response confirms cache usage.
		h.warmer.onResponse(makeMessage(makeUsage({ cacheWrite: PROMPT_TOKENS })));
		expect(h.warmer.cacheEntry?.touchedAt).toBe(Date.now());
	});
});
