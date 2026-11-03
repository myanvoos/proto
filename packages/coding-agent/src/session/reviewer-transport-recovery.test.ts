import { afterEach, expect, spyOn, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ReviewerRuntime } from "../advisor/runtime";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AuthStorage } from "./auth-storage";
import { convertToLlm } from "./messages";
import { parseRetryFallbackSelector } from "./retry-fallback-chains";
import { ReviewerTransport, type ReviewerTransportHost } from "./reviewer-transport";
import { SessionManager } from "./session-manager";

function model(id: string, provider: "anthropic" | "openai" = "anthropic"): Model {
	const value = getBundledModel(provider, id);
	if (!value) throw new Error(`Missing test model ${provider}/${id}`);
	return value;
}
const primary = model("claude-sonnet-4-5");
const backup = model("claude-opus-4-5");
const third = model("claude-haiku-4-5");
const foreign = model("gpt-4.1", "openai");
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of active.splice(0)) await dispose();
});

async function fixture(fallbacks = true, compaction = false) {
	const temp = TempDir.createSync("proto-reviewer-recovery-");
	const auth = await AuthStorage.create(":memory:");
	await auth.set("anthropic", [
		{ type: "api_key", key: "one" },
		{ type: "api_key", key: "two" },
	]);
	await auth.set("openai", [
		{ type: "api_key", key: "one" },
		{ type: "api_key", key: "two" },
	]);
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": compaction,
		"retry.modelFallback": fallbacks,
		"retry.fallbackRevertPolicy": "cooldown-expiry",
	});
	const cooldowns: string[] = [];
	const candidates = new Map([
		[primary.id, [backup]],
		[backup.id, [third]],
	]);
	const host: ReviewerTransportHost = {
		agent: new Agent({ initialState: { model: primary, tools: [] } }),
		sessionManager: SessionManager.inMemory(temp.path()),
		settings,
		modelRegistry: registry,
		providerSessionState: new Map(),
		preferWebsockets: undefined,
		onPayload: undefined,
		onResponse: undefined,
		onSseEvent: undefined,
		emitSessionEvent: async () => {},
		convertToLlmForSideRequest: convertToLlm,
		resolveContextPromotionTarget: async () => undefined,
		resolveCompactionModelCandidates: () => [],
		retryFallbackChainKeys: () => ["advisor"],
		findRetryFallbackCandidates: (_role, _selector, current) =>
			(candidates.get(current?.id ?? "") ?? []).map(candidate => {
				const parsed = parseRetryFallbackSelector(`${candidate.provider}/${candidate.id}`);
				if (!parsed) throw new Error("Invalid fixture selector");
				return parsed;
			}),
		isRetryFallbackSelectorSuppressed: () => false,
		noteRetryFallbackCooldown: selector => {
			cooldowns.push(selector);
		},
		createCodexCompactionContext: options => ({ ...options, operationId: "test", strategy: "memento" }),
		sessionId: () => "test",
	};
	const transport = new ReviewerTransport(host, {
		identity: {
			role: "advisor",
			name: "test",
			slug: "test",
			sessionLabelSuffix: "advisor",
			transcriptFilename: "__test.jsonl",
			telemetryName: "advisor",
			noticeLabel: "advisor",
		},
		model: primary,
		thinkingLevel: ThinkingLevel.Off,
		signature: "test",
		systemPrompt: ["Test"],
		adviseTool: {
			name: "advise",
			label: "Advise",
			description: "Test",
			parameters: type({}),
			execute: async () => ({ content: [] }),
		},
		toolNames: [],
		toolPool: [],
		providerSessionIds: new Map(),
		resolveProviderSessionId: () => undefined,
		streamFn: undefined,
		transformProviderContext: undefined,
		serviceTierResolver: () => undefined,
		recorderClosed: Promise.resolve(),
		createRuntime: agent => new ReviewerRuntime(agent, { snapshotMessages: () => [] }),
	});
	active.push(async () => {
		transport.runtime.dispose();
		await transport.recorder.close();
		auth.close();
		await temp.remove();
	});
	return { transport, auth, cooldowns, candidates, settings, host };
}

function failure(model: Model, errorMessage: string, refusal = false): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage,
		...(refusal ? { stopDetails: { type: "refusal" } } : {}),
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const signal = () => new AbortController().signal;

test("a primary context refusal pins its fallback without cooling the primary until reviewed history is compacted", async () => {
	const f = await fixture();
	const refused = failure(primary, "Refusal (cyber)", true);
	expect(await f.transport.recoverTurn(new Error(refused.errorMessage), [refused], signal())).toBe(true);
	expect(f.cooldowns).toEqual([]);
	await f.transport.maintainContext({ role: "user", content: "review", timestamp: 2 }, signal());
	expect(f.transport.model.id).toBe(backup.id);
	f.transport.resetRuntime("ordinary-reset");
	await f.transport.maintainContext({ role: "user", content: "review", timestamp: 2 }, signal());
	expect(f.transport.model.id).toBe(backup.id);
	f.transport.resetRuntime("compaction", { compacted: true });
	await f.transport.maintainContext({ role: "user", content: "new summary", timestamp: 3 }, signal());
	expect(f.transport.model.id).toBe(primary.id);
});

test("an intermediate fallback refusal does not pin an overloaded primary", async () => {
	const f = await fixture();
	const overloaded = failure(primary, "503 Service Unavailable");
	expect(await f.transport.recoverTurn(new Error(overloaded.errorMessage), [overloaded], signal())).toBe(true);
	const refused = failure(backup, "Refusal (cyber)", true);
	expect(await f.transport.recoverTurn(new Error(refused.errorMessage), [refused], signal())).toBe(true);
	expect(f.transport.model.id).toBe(third.id);
	expect(f.cooldowns).toHaveLength(2);
	await f.transport.maintainContext({ role: "user", content: "review", timestamp: 3 }, signal());
	expect(f.transport.model.id).toBe(primary.id);
});

test("repeated predicted credential switches stop at one pool traversal and success or abandonment rearms recovery", async () => {
	const f = await fixture(false);
	const mark = spyOn(f.auth, "markUsageLimitReached").mockResolvedValue({ switched: true });
	try {
		const failed = failure(primary, "usage_limit_reached");
		expect(await f.transport.recoverTurn(new Error(failed.errorMessage), [failed], signal())).toBe(true);
		f.transport.noteTurnSucceeded();
		expect(await f.transport.recoverTurn(new Error(failed.errorMessage), [failed], signal())).toBe(true);
		f.transport.noteTurnAbandoned();
		expect(await f.transport.recoverTurn(new Error(failed.errorMessage), [failed], signal())).toBe(true);
		expect(await f.transport.recoverTurn(new Error(failed.errorMessage), [failed], signal())).toBe(false);
	} finally {
		mark.mockRestore();
	}
});

test("a fallback provider has its own credential-switch budget in the same failing batch", async () => {
	const f = await fixture(false);
	const mark = spyOn(f.auth, "markUsageLimitReached").mockResolvedValue({ switched: true });
	try {
		const first = failure(primary, "usage_limit_reached");
		expect(await f.transport.recoverTurn(new Error(first.errorMessage), [first], signal())).toBe(true);
		f.transport.setModel(foreign, ThinkingLevel.Off);
		const next = failure(foreign, "usage_limit_reached");
		expect(await f.transport.recoverTurn(new Error(next.errorMessage), [next], signal())).toBe(true);
		// Returning to the first provider does not start a second traversal of its same failing pool.
		f.transport.setModel(primary, ThinkingLevel.Off);
		expect(await f.transport.recoverTurn(new Error(first.errorMessage), [first], signal())).toBe(false);
	} finally {
		mark.mockRestore();
	}
});

test("a new conversation releases a primary refusal pin", async () => {
	const f = await fixture();
	const refused = failure(primary, "Refusal (cyber)", true);
	await f.transport.recoverTurn(new Error(refused.errorMessage), [refused], signal());
	f.transport.resetForConversationBoundary();
	await f.transport.maintainContext({ role: "user", content: "different conversation", timestamp: 4 }, signal());
	expect(f.transport.model.id).toBe(primary.id);
});

test("account-policy rotation shares the per-provider quota switch bound instead of requeueing forever", async () => {
	const f = await fixture(false);
	const rotate = spyOn(f.auth, "rotateSessionCredential").mockResolvedValue(true);
	const mark = spyOn(f.auth, "markUsageLimitReached").mockResolvedValue({ switched: true });
	try {
		const denied = { ...failure(primary, "403 oauth_not_allowed_for_organization"), errorStatus: 403 };
		expect(await f.transport.recoverTurn(new Error(denied.errorMessage), [denied], signal())).toBe(true);
		const limited = failure(primary, "usage_limit_reached");
		expect(await f.transport.recoverTurn(new Error(limited.errorMessage), [limited], signal())).toBe(false);
		f.transport.resetRuntime("fresh-batch");
		expect(await f.transport.recoverTurn(new Error(denied.errorMessage), [denied], signal())).toBe(true);
	} finally {
		rotate.mockRestore();
		mark.mockRestore();
	}
});

test("advisor promotion recalculates schema overhead for a model whose tool catalog is hosted server-side", async () => {
	const f = await fixture(true, true);
	f.settings.set("compaction.thresholdPercent", 50);
	f.settings.set("contextPromotion.enabled", true);
	f.transport.setModel({ ...primary, contextWindow: 100 }, ThinkingLevel.Off);
	f.transport.agent.setTools([
		{
			name: "large",
			label: "Large",
			description: "schema overhead ".repeat(300),
			parameters: type({ payload: "string" }),
			execute: async () => ({ content: [] }),
		},
	]);
	const promoted = { ...backup, contextWindow: 200, toolSchemasInContext: false };
	f.host.resolveContextPromotionTarget = async () => promoted;
	const shouldReprime = await f.transport.maintainContext({ role: "user", content: "review", timestamp: 1 }, signal());
	expect(
		f.transport.model.id,
		JSON.stringify({
			compaction: f.settings.getGroup("compaction"),
			promotion: f.settings.getGroup("contextPromotion"),
			shouldReprime,
		}),
	).toBe(promoted.id);
	expect(shouldReprime).toBe(false);
});
