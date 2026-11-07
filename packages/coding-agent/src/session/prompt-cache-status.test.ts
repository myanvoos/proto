/**
 * What the status line and `/session` read about the prompt cache: the live
 * entry the warmer confirmed, and the entry a reopened session infers from its
 * branch. Display-only behavior is asserted at the session boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { SecretObfuscator } from "../secrets";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { CacheWarmer } from "./cache-warmer";
import { CACHE_WARM_USAGE_CUSTOM_TYPE } from "./session-entries";
import { SessionManager } from "./session-manager";

const SHORT_TTL_MS = 300_000;
/** 90% of the 5-minute lifetime: when the warmer refreshes. */
const REFRESH_DELAY_MS = 270_000;

function usage(tokens: Partial<Pick<Usage, "cacheRead" | "cacheWrite" | "cttl">>): Usage {
	const cacheRead = tokens.cacheRead ?? 0;
	const cacheWrite = tokens.cacheWrite ?? 0;
	return {
		input: 1,
		output: 1,
		cacheRead,
		cacheWrite,
		totalTokens: 2 + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(tokens.cttl ? { cttl: tokens.cttl } : {}),
	};
}

function reply(model: Model, replyUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: replyUsage,
	};
}

describe("AgentSession prompt-cache status", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let settings: Settings;
	let session: AgentSession;
	let warmer: CacheWarmer;
	let model: Model;
	/** What a warm refresh reads back: a hit by default. */
	let refreshUsage: Usage;
	let refreshStopReason: StopReason;
	/** Holds a warm refresh back before the provider sends it (a wait for a provider slot). */
	let refreshGate: Promise<void> | undefined;
	/** Holds a sent warm refresh's response back. */
	let responseGate: Promise<void> | undefined;

	async function createSession(sessionModel: Model): Promise<void> {
		warmer?.cancel();
		authStorage?.close();
		const agentDir = tempDir.path();
		const storage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage = storage;
		storage.setRuntimeApiKey("anthropic", "test-key");
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		warmer = new CacheWarmer({
			getMode: () => settings.get("providers.cacheWarming"),
			getPromptTokens: () => 100_000,
			stream: async (_model, _context, options) => {
				await refreshGate;
				await options?.onPayload?.({});
				await responseGate;
				const message: AssistantMessage = { ...reply(sessionModel, refreshUsage), stopReason: refreshStopReason };
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: "stop" as const, message };
					},
					result: () => Promise.resolve(message),
				};
			},
		});
		openSession(sessionModel, SessionManager.create(agentDir, agentDir));
	}

	function openSession(sessionModel: Model, sessionManager: SessionManager): void {
		session = new AgentSession({
			agent: new Agent({ initialState: { model: sessionModel, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			cacheWarmer: warmer,
			modelRegistry: new ModelRegistry(authStorage!),
			obfuscator: new SecretObfuscator([]),
		});
	}

	/** One main-loop request to `model` whose response wrote the prompt cache. */
	function send(): number {
		const sentAt = Date.now();
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
		warmer.onResponse(reply(model, usage({ cacheWrite: 50_000 })));
		return sentAt;
	}

	async function drain(): Promise<void> {
		for (let i = 0; i < 100; i++) await Promise.resolve();
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@proto-prompt-cache-status-");
		model = getBundledModel("anthropic", "claude-sonnet-4-5");
		refreshUsage = usage({ cacheRead: 100_000 });
		refreshStopReason = "stop";
		refreshGate = undefined;
		responseGate = undefined;
		await createSession(model);
	});

	afterEach(async () => {
		warmer.cancel();
		vi.useRealTimers();
		authStorage?.close();
		authStorage = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	it("stays warm through the entry's lifetime and turns cold the instant it lapses", () => {
		const sentAt = send();
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS - 1)).toMatchObject({
			state: "warm",
			inferred: false,
			touchedAt: sentAt,
			ttlMs: SHORT_TTL_MS,
		});
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "cold",
			reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
		});
	});

	it("follows a warm refresh that hits, persists its outcome, and turns cold when one misses", async () => {
		const sentAt = send();
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		const refreshedAt = sentAt + REFRESH_DELAY_MS;
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "warm",
			touchedAt: refreshedAt,
			warming: { state: "scheduled" },
		});
		// The persisted refresh carries its send time and outcome, which a reopened session counts from.
		const warmUsage = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === CACHE_WARM_USAGE_CUSTOM_TYPE);
		expect(warmUsage).toMatchObject({
			data: { purpose: "cache-warm", cacheRefresh: { sentAt: refreshedAt, hit: true } },
		});
		// A paid refresh is part of the session's usage totals.
		expect(session.sessionManager.getUsageStatistics().totalTokens).toBeGreaterThan(100_000);

		refreshUsage = usage({});
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
			state: "cold",
			reason: { kind: "refresh-missed" },
		});
	});

	it("keeps the entry warm from a refresh that wrote the prefix again, and stops refreshing", async () => {
		const sentAt = send();
		refreshUsage = usage({ cacheRead: 20_000, cacheWrite: 80_000 });
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		const refreshedAt = sentAt + REFRESH_DELAY_MS;

		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "warm",
			touchedAt: refreshedAt,
			cachedTokens: 100_001,
			warming: { state: "inactive", reason: "refresh missed the cache" },
		});
	});

	it("turns cold when a tool's wire fields changed under the same name", () => {
		const lookup = {
			name: "lookup",
			label: "Lookup",
			description: "Look up a value",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			execute: async () => ({ content: [], details: {} }),
		};
		session.agent.setTools([lookup]);
		const sentAt = send();
		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({ state: "warm" });

		for (const change of [
			{ strict: true },
			{ customWireName: "lookup_v2" },
			{ customFormat: { syntax: "regex" as const, definition: "[a-z]+" } },
			{ examples: [{ caption: "Find a user", call: { query: "user:42" } }] },
		]) {
			session.agent.setTools([lookup]);
			const armedAt = send();
			session.agent.setTools([{ ...lookup, ...change }]);
			expect(session.getPromptCacheStatus(armedAt + 1)).toMatchObject({
				state: "cold",
				reason: { kind: "tools" },
			});
		}
	});

	it("turns cold when the model changed since the last send, naming both models", () => {
		const sentAt = send();
		const other = getBundledModel("anthropic", "claude-opus-4-5");
		session.agent.setModel(other);

		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({
			state: "cold",
			reason: { kind: "model", from: model.name, to: other.name },
		});
	});

	it("is hidden for a session without a cache warmer, as every subagent is", () => {
		const subagent = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry: session.modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});
		subagent.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));

		expect(subagent.getPromptCacheStatus(Date.now() + 1)).toBeUndefined();
	});

	it("shows nothing cached after /clear, whose new transcript reads no earlier prefix", async () => {
		session.agent.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		const sentAt = send();
		session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000 })));
		expect(session.getPromptCacheStatus(sentAt + 1)).toMatchObject({ state: "warm" });

		expect(await session.resetSessionContext()).toBeDefined();
		expect(session.getPromptCacheStatus(sentAt + 1)).toBeUndefined();
	});

	it("counts a request's lifetime from when the provider sent it, not from a wait for a provider slot", () => {
		const context = { messages: [] };
		session.startCacheWarming(model, context, { cacheRetention: "short" });
		vi.advanceTimersByTime(30_000);
		const sentAt = Date.now();
		session.markPromptCacheDispatched(context);
		warmer.onResponse(reply(model, usage({ cacheWrite: 50_000 })));

		expect(session.getPromptCacheStatus(sentAt)).toMatchObject({ state: "warm", touchedAt: sentAt });
	});

	it("holds expiry off while a refresh the provider sent before it is in flight", async () => {
		const response = Promise.withResolvers<void>();
		responseGate = response.promise;
		const sentAt = send();
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();

		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS + 1_000)).toMatchObject({
			state: "warm",
			warming: { state: "refreshing" },
		});
		response.resolve();
		await drain();
	});

	it("keeps a lapsed entry cold when its refresh only goes out after the lapse", async () => {
		const slot = Promise.withResolvers<void>();
		refreshGate = slot.promise;
		const response = Promise.withResolvers<void>();
		responseGate = response.promise;
		const sentAt = send();
		vi.advanceTimersByTime(REFRESH_DELAY_MS);
		await drain();
		// The provider slot frees only after the entry lapsed.
		vi.advanceTimersByTime(SHORT_TTL_MS - REFRESH_DELAY_MS + 1_000);
		slot.resolve();
		await drain();

		expect(session.getPromptCacheStatus(Date.now())).toMatchObject({
			state: "cold",
			reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
		});
		response.resolve();
		await drain();
	});

	it("infers the entry from the newest cached reply's send time and its model's lifetime", () => {
		const sentAt = Date.now();
		session.sessionManager.appendMessage(reply(model, usage({ cacheWrite: 50_000, cttl: { ephemeral5m: 50_000 } })));

		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS - 1)).toMatchObject({
			state: "warm",
			inferred: true,
			tier: "short",
			touchedAt: sentAt,
		});
		expect(session.getPromptCacheStatus(sentAt + SHORT_TTL_MS)).toMatchObject({
			state: "cold",
			reason: { kind: "expired", at: sentAt + SHORT_TTL_MS },
		});
	});

	it("reads a compaction after the newest cached reply as cold", () => {
		const replyId = session.sessionManager.appendMessage(reply(model, usage({ cacheRead: 50_000 })));
		session.sessionManager.appendCompaction("summary", undefined, replyId, 50_000);

		expect(session.getPromptCacheStatus(Date.now() + 1)).toMatchObject({
			state: "cold",
			inferred: true,
			reason: { kind: "compaction" },
		});
	});
});
