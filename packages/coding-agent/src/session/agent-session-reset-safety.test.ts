import { afterEach, expect, spyOn, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ResetCreditAccountStatus, ResetCreditTarget, UsageReport } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
	resetAccountLockKey,
} from "./codex-auto-reset";
import { resetLockPath } from "./reset-fence";
import { SessionManager } from "./session-manager";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing test model");
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of active.splice(0)) await close();
});

async function fixture(options: { sibling?: string; coordinator?: CodexAutoRedeemCoordinator } = {}) {
	const temp = TempDir.createSync("proto-reset-session-");
	const auth = await AuthStorage.create(":memory:");
	const accounts = ["active", ...(options.sibling ? [options.sibling] : [])];
	await auth.set(
		"anthropic",
		accounts.map(accountId => ({
			type: "oauth" as const,
			access: "test",
			refresh: "test",
			expires: Date.now() + 3_600_000,
			accountId,
			email: `${accountId}@example.com`,
			orgId: "org",
		})),
	);
	const selected = options.sibling ?? "active";
	const credentialId = auth
		.listStoredCredentials("anthropic")
		.find(entry => entry.credential.type === "oauth" && entry.credential.accountId === selected)?.id;
	if (credentialId === undefined) throw new Error("Missing stored test account");
	const target: ResetCreditTarget = {
		provider: "anthropic",
		credentialId,
		accountId: selected,
		email: `${selected}@example.com`,
		orgId: "org",
		creditId: "grant",
	};
	const now = Date.now();
	const status: ResetCreditAccountStatus = {
		...target,
		active: selected === "active",
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: "grant",
		credits: [
			{
				id: "grant",
				program: "juniper_tide",
				usable: true,
				remainingCount: 1,
				requiresLimit: true,
				clears: ["anthropic:5h"],
				blocking: ["anthropic:5h"],
				expiresAt: new Date(now + 3_600_000).toISOString(),
			},
		],
	};
	const report: UsageReport = {
		provider: "anthropic",
		fetchedAt: now,
		metadata: { email: target.email, accountId: target.accountId, orgId: "org" },
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", shared: true, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: now + 2 * 3_600_000 },
				amount: { usedFraction: 1, unit: "percent" },
			},
		],
	};
	const provider = createMockModel({
		responses: [
			{ content: [], stopReason: "error", errorMessage: "429 Usage limit reached" },
			{ content: ["finished"], stopReason: "stop" },
		],
	});
	const coordinator = options.coordinator ?? createCodexAutoRedeemCoordinator();
	coordinator.resetLockPath ??= temp.join("agent.db");
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: provider.stream,
			getApiKey: () => "test",
		}),
		sessionManager: SessionManager.inMemory(temp.path()),
		codexResetCoordinator: coordinator,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": false,
			"claudeResets.autoRedeem": "yes",
			"claudeResets.keepCredits": 0,
			"claudeResets.salvageHorizonHours": 0,
			"codexResets.autoRedeem": "no",
		}),
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
	});
	const identity = spyOn(auth, "getOAuthAccountIdentity").mockReturnValue({
		accountId: "active",
		email: "active@example.com",
		orgId: "org",
	});
	const usage = spyOn(auth, "fetchUsageReports").mockResolvedValue([report]);
	const listing = spyOn(auth, "listResetCredits").mockResolvedValue([status]);
	const mark = spyOn(auth, "markUsageLimitReached").mockResolvedValue({ switched: false });
	active.push(async () => {
		await session.dispose();
		identity.mockRestore();
		usage.mockRestore();
		listing.mockRestore();
		mark.mockRestore();
		auth.close();
		await temp.remove();
	});
	return { session, auth, target, status, report, coordinator, provider, temp };
}

test("manual saved-reset spends share the automatic account fence across sessions", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let consumes = 0;
	const redeem = spyOn(f.auth, "redeemResetCredit").mockImplementation(async () => {
		consumes++;
		entered.resolve();
		await release.promise;
		return { ok: true, code: "reset" };
	});
	try {
		const first = f.session.redeemResetCredit(f.target);
		await entered.promise;
		const second = f.session.redeemResetCredit(f.target);
		release.resolve();
		expect((await Promise.all([first, second])).map(outcome => outcome.code)).toEqual(["reset", "already_redeemed"]);
		expect(consumes).toBe(1);
	} finally {
		redeem.mockRestore();
	}
});

test("automatic restoration rechecks the visible credential pool after planning and releases an unspent attempt", async () => {
	const f = await fixture();
	let visible = true;
	const stored = f.auth.listStoredCredentials.bind(f.auth);
	const list = spyOn(f.auth, "listStoredCredentials").mockImplementation(provider =>
		visible ? stored(provider) : [],
	);
	const reload = spyOn(f.auth, "reload").mockImplementation(async () => {
		visible = false;
	});
	let consumes = 0;
	const redeem = spyOn(f.auth, "redeemResetCredit").mockImplementation(async () => {
		consumes++;
		return { ok: true, code: "reset" };
	});
	try {
		await f.session.prompt("work");
		await f.session.waitForIdle();
		expect(consumes).toBe(0);
		expect(f.coordinator.attemptedKeys.size).toBe(0);
		expect(f.coordinator.lastAttemptAtByAccount.size).toBe(0);
	} finally {
		list.mockRestore();
		reload.mockRestore();
		redeem.mockRestore();
	}
});

test("a recent peer reset marker cannot be adopted for an account outside the visible pool", async () => {
	const f = await fixture();
	const key = resetAccountLockKey(f.target);
	if (!key) throw new Error("Missing key");
	await Bun.write(resetLockPath(key, f.coordinator.resetLockPath), `reset:${Date.now()}`);
	const list = spyOn(f.auth, "listStoredCredentials").mockReturnValue([]);
	try {
		await f.session.prompt("work");
		await f.session.waitForIdle();
		expect(f.provider.calls).toHaveLength(1);
	} finally {
		list.mockRestore();
	}
});

test("a joiner replans when the shared pass restored a different visible account despite reused credential row ids", async () => {
	const coordinator = createCodexAutoRedeemCoordinator();
	const a = await fixture({ sibling: "runner", coordinator });
	const b = await fixture({ sibling: "joiner", coordinator });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const consumeA = spyOn(a.auth, "redeemResetCredit").mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return { ok: true, code: "reset" };
	});
	let spentB = 0;
	const consumeB = spyOn(b.auth, "redeemResetCredit").mockImplementation(async () => {
		spentB++;
		return { ok: true, code: "reset" };
	});
	try {
		const first = a.session.prompt("first");
		await entered.promise;
		const second = b.session.prompt("second");
		release.resolve();
		await Promise.all([first, second]);
		await Promise.all([a.session.waitForIdle(), b.session.waitForIdle()]);
		expect(a.target.credentialId).toBe(b.target.credentialId);
		expect(spentB).toBe(1);
		expect(a.provider.calls).toHaveLength(2);
		expect(b.provider.calls).toHaveLength(2);
	} finally {
		consumeA.mockRestore();
		consumeB.mockRestore();
	}
});
