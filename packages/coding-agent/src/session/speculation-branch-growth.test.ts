/**
 * Background speculative compaction arms a summary off a snapshot leaf. Turns committed after that snapshot used to
 * be ignored at claim time: applying the stale summary kept the old tail plus the new turns, missed the recovery
 * band, tripped the dead-end pause, and let the context overflow at the provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../config/settings";
import { SessionMaintenance, type SessionMaintenanceHost } from "./session-maintenance";
import { SessionManager } from "./session-manager";

const CONTEXT_WINDOW = 100_000;
const THRESHOLD = 50_000;
const SPECULATION_BAND_START = THRESHOLD - 8_192;

function assistant(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("armed speculative compaction and post-snapshot growth", () => {
	let model: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;

	beforeEach(() => {
		const bundled = getBundledModel("openai", "gpt-5");
		if (!bundled) throw new Error("Expected bundled openai/gpt-5");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
		sessionManager = SessionManager.inMemory();
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": true,
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"compaction.selfSummary": false,
		});
		const base: Partial<SessionMaintenanceHost> = {
			agent,
			sessionManager,
			settings,
			modelRegistry: {
				getAvailable: () => [model],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as SessionMaintenanceHost["modelRegistry"],
			extensionRunner: undefined,
			model: () => model,
			isDisposed: () => false,
			isStreaming: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			nonMessageTokenSource: () => ({}),
			emitSessionEvent: async () => {},
			obfuscateTextForProvider: text => text,
			obfuscatePreparationForProvider: preparation => preparation,
			convertToLlmForSideRequest: messages => messages as never,
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			scheduleCompactionContinuation: () => false,
		};
		// Remaining host capabilities are side-effect sinks for this contract.
		const host = new Proxy(base, {
			get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
		}) as SessionMaintenanceHost;
		maintenance = new SessionMaintenance(host);

		const text = "conversation ".repeat(8_000);
		sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		sessionManager.appendMessage(assistant("response ".repeat(8_000), model));
		sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		sessionManager.appendMessage(assistant("final response", model));
	});

	afterEach(() => {
		maintenance.cancelSpeculation();
		vi.restoreAllMocks();
	});

	async function waitForArmed(): Promise<void> {
		for (let i = 0; i < 200 && maintenance.speculationState !== "armed"; i++) await Bun.sleep(1);
		expect(maintenance.speculationState).toBe("armed");
	}

	it("discards an armed summary the branch outgrew and compacts the current branch instead", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForArmed();
		expect(compactSpy).toHaveBeenCalledTimes(1);

		// A large turn lands after the snapshot: the armed summary would now keep ~45k tokens of new tail.
		sessionManager.appendMessage(assistant("large-tail-token ".repeat(45_000), model));

		await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD + 40_000 });

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("applies an armed summary when nothing landed after its snapshot", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForArmed();

		await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 1");
	});
});
