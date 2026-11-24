import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as utils from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const model: Model<"openai-completions"> = buildModel({
	id: "quota-model",
	name: "Quota Model",
	api: "openai-completions",
	provider: "quota-test",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const TWO_HOURS_MS = 2 * 3_600_000;

function reply(extra: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "recovered" }],
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
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

// Google RPC errors carry an authoritative Go-duration reset in structured
// metadata; the display message can name a much shorter wait.
const THIRTY_MINUTE_QUOTA_ERROR = `429 Cloud Code Assist API error: ${JSON.stringify({
	error: {
		status: "RESOURCE_EXHAUSTED",
		message: "Resets in 2s.",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "RATE_LIMIT_EXCEEDED",
				domain: "cloudcode-pa.googleapis.com",
				metadata: { quotaResetDelay: "30m" },
			},
		],
	},
})}`;

describe("retry.waitForUsageReset", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		vi.restoreAllMocks();
	});

	async function run(
		errorMessage: string,
		waitForUsageReset: boolean | undefined,
		errorsBeforeSuccess = 1,
		extraSettings: Record<string, unknown> = {},
	) {
		const sleeps: number[] = [];
		vi.spyOn(utils, "sleepLong").mockImplementation(async delayMs => {
			sleeps.push(delayMs);
		});
		vi.spyOn(utils, "sleepUntil").mockImplementation(async deadlineMs => {
			sleeps.push(Math.max(0, deadlineMs - Date.now()));
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				calls++;
				const message =
					calls <= errorsBeforeSuccess
						? reply({ content: [], stopReason: "error", errorStatus: 429, errorMessage })
						: reply({});
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 100,
				"retry.modelFallback": false,
				...(waitForUsageReset === undefined ? {} : { "retry.waitForUsageReset": waitForUsageReset }),
				...extraSettings,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const retryFinalErrors: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && event.finalError !== undefined) retryFinalErrors.push(event.finalError);
		});
		await session.prompt("go");
		await session.waitForIdle();
		return { calls, sleeps, last: session.messages.at(-1) as AssistantMessage, retryFinalErrors };
	}

	it("sleeps through a provider-stated usage-limit reset past retry.maxDelayMs", async () => {
		const result = await run(`429 Usage limit reached. retry-after-ms=${TWO_HOURS_MS}`, true);

		expect(result.calls).toBe(2);
		expect(result.sleeps.some(delayMs => delayMs > 100 && delayMs <= TWO_HOURS_MS + 60_000)).toBe(true);
		expect(result.last.stopReason).toBe("stop");
	});

	it("fails fast past retry.maxDelayMs when the setting is off", async () => {
		const result = await run(`429 Usage limit reached. retry-after-ms=${TWO_HOURS_MS}`, false);

		expect(result.calls).toBe(1);
		expect(result.last.stopReason).toBe("error");
	});

	it("waits out a provider-stated reset by default when the setting is unset", async () => {
		const result = await run(`429 Usage limit reached. retry-after-ms=${TWO_HOURS_MS}`, undefined);

		expect(result.calls).toBe(2);
		expect(result.sleeps.some(delayMs => delayMs > 100 && delayMs <= TWO_HOURS_MS + 60_000)).toBe(true);
		expect(result.last.stopReason).toBe("stop");
	});

	it("keeps waiting provider-stated resets past retry-budget exhaustion", async () => {
		const result = await run(`429 Usage limit reached. retry-after-ms=${TWO_HOURS_MS}`, true, 3, {
			"retry.maxRetries": 1,
		});

		expect(result.calls).toBe(4);
		expect(result.sleeps.length).toBe(3);
		expect(result.sleeps.every(delayMs => delayMs > 100)).toBe(true);
		expect(result.last.stopReason).toBe("stop");
	});

	it("fails fast on a usage limit with no provider reset timing even when enabled", async () => {
		const result = await run("402 Insufficient balance", true);

		expect(result.calls).toBe(1);
		expect(result.last.stopReason).toBe("error");
	});

	it("waits out a structured 30-minute quota reset within retry.maxDelayMs", async () => {
		// The 2s display text must not override the authoritative 30m metadata.
		const result = await run(THIRTY_MINUTE_QUOTA_ERROR, false, 1, { "retry.maxDelayMs": 2_000_000 });

		expect(result.sleeps.some(delayMs => delayMs >= 1_800_000)).toBe(true);
		expect(result.calls).toBe(2);
		expect(result.last.stopReason).toBe("stop");
	});

	it("waits past a structured quota reset cap when the opt-in is set", async () => {
		// With retry.waitForUsageReset, the authoritative 30m metadata outranks
		// the configured cap instead of failing the turn.
		const result = await run(THIRTY_MINUTE_QUOTA_ERROR, true, 1, { "retry.maxDelayMs": 1_000_000 });

		expect(result.sleeps.some(delayMs => delayMs >= 1_800_000)).toBe(true);
		expect(result.calls).toBe(2);
		expect(result.last.stopReason).toBe("stop");
	});

	it("fails fast on a structured 30-minute quota reset past retry.maxDelayMs", async () => {
		const result = await run(THIRTY_MINUTE_QUOTA_ERROR, false, 1, { "retry.maxDelayMs": 1_000_000 });

		expect(result.sleeps).toEqual([]);
		expect(result.calls).toBe(1);
		expect(result.last.stopReason).toBe("error");
		expect(
			result.retryFinalErrors.some(error => error.includes("1800000ms wait, exceeds retry.maxDelayMs (1000000ms)")),
		).toBe(true);
	});

	it("fails fast on an out-of-credit balance even when retry.maxDelayMs covers the quota guess", async () => {
		// The 30-minute QUOTA_EXHAUSTED heuristic fits under this cap, so a billing
		// cap that only checked the cap would sleep a window that never reopens.
		const message =
			"402 the organization is out of credit, add more to continue (type=insufficient_quota param=insufficient_quota)";
		const result = await run(message, true, 1, { "retry.maxDelayMs": 2_000_000 });

		expect(result.sleeps).toEqual([]);
		expect(result.calls).toBe(1);
		expect(result.last.stopReason).toBe("error");
		expect(result.last.errorMessage).toContain("out of credit");
	});
});
