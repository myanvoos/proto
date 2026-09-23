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

	async function run(errorMessage: string, waitForUsageReset: boolean) {
		const sleeps: number[] = [];
		vi.spyOn(utils, "sleepLong").mockImplementation(async delayMs => {
			sleeps.push(delayMs);
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
					calls === 1 ? reply({ content: [], stopReason: "error", errorStatus: 429, errorMessage }) : reply({});
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
				"retry.waitForUsageReset": waitForUsageReset,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt("go");
		await session.waitForIdle();
		return { calls, sleeps, last: session.messages.at(-1) as AssistantMessage };
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

	it("fails fast on a usage limit with no provider reset timing even when enabled", async () => {
		const result = await run("402 Insufficient balance", true);

		expect(result.calls).toBe(1);
		expect(result.last.stopReason).toBe("error");
	});
});
