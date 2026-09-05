import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai";
import { loadAdvisorTranscriptCosts } from "../advisor/transcript-recorder";
import { GoalRuntime, type GoalRuntimeHost } from "../goals/runtime";
import type { Goal } from "../goals/state";
import type { BashCommandPolicy } from "../tools/bash-allowlist";
import { type ConductorActivity, type ConductorHost, SessionConductor } from "./runtime";
import { loadConductorTranscriptCost } from "./transcript";

registerMockApi("coding-agent/conductor-test");

function makeGoal(id: string, updatedAt: number, status: Goal["status"] = "verifying"): Goal {
	return {
		id,
		objective: [
			"## Objective",
			"Add a greeting endpoint.",
			"",
			"## Success criteria",
			"1. `bun test` passes.",
			"",
			"## Verification",
			"`bun test`",
			"",
			"## Boundaries",
			"`src/` only.",
			"",
			"## Stop conditions",
			"3 attempts.",
		].join("\n"),
		status,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: updatedAt,
		updatedAt,
	};
}

interface Harness {
	conductor: SessionConductor;
	model: MockModel;
	script: { current: () => MockResponse | Promise<MockResponse> };
	goalState: { goal: Goal | undefined };
	notices: Array<{ level: string; message: string }>;
	activities: ConductorActivity[];
	sentMessages: unknown[];
	goalEvents: Array<Goal | null>;
	goalRuntime: GoalRuntime;
	sessionFile: string;
	allowlistHistory: Array<BashCommandPolicy | undefined>;
	agentState: { isStreaming: boolean; promptCacheKey: undefined; telemetry: undefined; messages: unknown[] };
	cleanup(): Promise<void>;
}

async function createHarness(settingOverrides: Record<string, unknown> = {}): Promise<Harness> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-test-"));
	const sessionFile = path.join(tmp, "session.jsonl");
	const goalState: { goal: Goal | undefined } = { goal: undefined };
	const notices: Array<{ level: string; message: string }> = [];
	const activities: ConductorActivity[] = [];
	const sentMessages: unknown[] = [];
	const goalEvents: Array<Goal | null> = [];
	const allowlistHistory: Array<BashCommandPolicy | undefined> = [];

	// MockModel reads `options.handler` once (into `fallback`), so route every call through a mutable script
	// the tests can re-point between phases.
	const script: { current: () => MockResponse | Promise<MockResponse> } = {
		current: () => ({ content: ["no handler scripted"] }),
	};
	const model = createMockModel({ id: "conductor-test", provider: "mock", handler: () => script.current() });

	let conductor: SessionConductor | undefined;
	const goalHost: GoalRuntimeHost = {
		getState: () =>
			goalState.goal
				? {
						enabled: goalState.goal.status !== "complete",
						mode: goalState.goal.status === "complete" ? "exiting" : "active",
						...(goalState.goal.status === "complete" ? { reason: "completed" as const } : {}),
						goal: goalState.goal,
					}
				: undefined,
		setState: state => {
			goalState.goal = state?.goal;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: async event => {
			if (event.type !== "goal_updated") return;
			goalEvents.push(event.goal);
			conductor?.onGoalUpdated(event.goal);
		},
		persist: () => {},
		sendHiddenMessage: async () => {},
	};
	const goalRuntime = new GoalRuntime(goalHost);

	const settings = {
		getModelRole: (role: string) => (role === "conductor" ? "mock/conductor-test" : undefined),
		get: (key: string) => {
			if (key in settingOverrides) return settingOverrides[key];
			if (key === "conductor.gateTimeoutSeconds") return 300;
			if (key === "conductor.maxRejections") return 3;
			return undefined;
		},
		getGroup: (group: string) =>
			group === "retry"
				? { enabled: false, modelFallback: false }
				: group === "contextPromotion"
					? { enabled: false }
					: {},
		getStorage: () => undefined,
	};

	const agentState = {
		isStreaming: false,
		promptCacheKey: undefined,
		telemetry: undefined,
		messages: [] as unknown[],
	};
	const host = {
		agent: { state: agentState },
		sessionManager: { getCwd: () => tmp, getSessionFile: () => sessionFile },
		settings,
		modelRegistry: {
			getAvailable: () => [model],
			resolver: () => "test-key",
			getApiKey: async () => "test-key",
		},
		providerSessionState: new Map(),
		preferWebsockets: undefined,
		onPayload: undefined,
		onResponse: undefined,
		onSseEvent: undefined,
		emitSessionEvent: async () => {},
		convertToLlmForSideRequest: () => [],
		resolveContextPromotionTarget: async () => undefined,
		resolveCompactionModelCandidates: () => [],
		retryFallbackChainKeys: () => [],
		findRetryFallbackCandidates: () => [],
		isRetryFallbackSelectorSuppressed: () => false,
		noteRetryFallbackCooldown: () => {},
		createCodexCompactionContext: () => {
			throw new Error("compaction not expected in conductor tests");
		},
		sessionId: () => "sess-test",
		isDisposed: () => false,
		emitNotice: (level: string, message: string) => {
			notices.push({ level, message });
		},
		sendCustomMessage: async (message: unknown) => {
			sentMessages.push(message);
			return true;
		},
		effectiveServiceTier: () => undefined,
		goalRuntime: () => goalRuntime,
		currentGoal: () => goalState.goal,
		obfuscator: undefined,
		emitConductorActivity: (activity: ConductorActivity) => {
			activities.push(activity);
		},
	} as unknown as ConductorHost;

	conductor = new SessionConductor(host, {
		enabled: true,
		setBashCommandPolicy: policy => allowlistHistory.push(policy),
	});

	return {
		conductor,
		model,
		script,
		goalState,
		notices,
		activities,
		sentMessages,
		goalEvents,
		goalRuntime,
		sessionFile,
		allowlistHistory,
		agentState,
		cleanup: async () => {
			conductor?.stopRuntime();
			await fs.rm(tmp, { recursive: true, force: true });
		},
	};
}

function programPropose() {
	return {
		content: [
			{
				type: "toolCall" as const,
				name: "program",
				arguments: {
					op: "create",
					objective: [
						"## Objective",
						"Add a greeting endpoint.",
						"",
						"## Success criteria",
						"1. `bun test` passes.",
						"",
						"## Verification",
						"`bun test`",
						"",
						"## Boundaries",
						"`src/` only.",
						"",
						"## Stop conditions",
						"3 attempts.",
					].join("\n"),
				},
			},
		],
		usage: { input: 10, output: 5, cost: { total: 0.01 } },
	};
}

function cueAccept() {
	return {
		content: [
			{
				type: "toolCall" as const,
				name: "cue",
				arguments: { op: "verify", verdict: "accept", evidence: "tests pass; artifacts present" },
			},
		],
		usage: { input: 10, output: 5, cost: { total: 0.01 } },
	};
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
		await Bun.sleep(5);
	}
}

describe("SessionConductor gate", () => {
	test("discards a ruling whose pended claim was replaced mid-audit, then audits and accepts the new claim", async () => {
		const h = await createHarness();
		try {
			const goalX = makeGoal("g1", 1000);
			const goalY = makeGoal("g2", 2000);
			h.goalState.goal = goalX;

			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				if (calls === 2) {
					// The claim for g1 is replaced by g2 while turn 1's accept ruling is already recorded.
					h.goalState.goal = goalY;
					h.conductor.onGoalUpdated(goalY);
				}
				if (calls === 3) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(goalX);

			// Four provider calls prove a second audit ran; the fresh accept is what completed g2.
			await waitFor(() => h.goalState.goal?.status === "complete" && calls >= 4, "goal g2 accepted after re-audit");
			expect(calls).toBe(4);
			expect(h.goalState.goal?.id).toBe("g2");
			expect(h.goalState.goal?.status).toBe("complete");
			expect(h.notices.filter(n => n.message.includes("Conductor verified the completion claim"))).toHaveLength(1);
			// Exactly one commit event: the fresh audit's accept. A stale accept would have completed g2 during
			// turn 1, collapsing the run to two provider calls and no second audit.
			expect(h.goalEvents).toHaveLength(1);
			expect(h.goalEvents[0]?.id).toBe("g2");
		} finally {
			await h.cleanup();
		}
	});

	test("discards a ruling when the same goal re-pends mid-audit, then audits the fresh pend", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);

			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				if (calls === 2) {
					// Abort → resume → re-claim: same goal id, fresh pend (updatedAt bump).
					const repended = makeGoal("g1", 1500);
					h.goalState.goal = repended;
					h.conductor.onGoalUpdated(repended);
				}
				if (calls === 3) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);

			await waitFor(() => h.goalState.goal?.status === "complete" && calls >= 4, "re-pended claim accepted");
			expect(calls).toBe(4);
			expect(h.goalState.goal?.id).toBe("g1");
			expect(h.goalState.goal?.status).toBe("complete");
		} finally {
			await h.cleanup();
		}
	});

	test("/conduct off then on re-arms a still-pended claim instead of stranding it", async () => {
		const h = await createHarness();
		try {
			const goal = makeGoal("g1", 1000);
			h.goalState.goal = goal;

			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls <= 3) {
					// Three verification attempts never rule (escalation path).
					return { content: ["still investigating"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
				}
				if (calls === 4) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(goal);
			await waitFor(() => h.notices.some(n => n.message.includes("Conductor escalation")), "escalation notice");
			expect(h.conductor.getStats().escalated).toBe(true);
			expect(h.conductor.getStats().pendingGoalId).toBe("g1");

			h.conductor.setEnabled(false);
			expect(h.conductor.getStats().pendingGoalId).toBeUndefined();

			// Before the fix this left the claim stranded: no pend tracked, no wake, and #pendCompletion refuses a
			// second pend, so the goal could never leave "verifying".
			h.conductor.setEnabled(true);
			expect(h.conductor.getStats().pendingGoalId).toBe("g1");

			await waitFor(() => h.goalState.goal?.status === "complete", "pended claim verified after re-enable");
			expect(calls).toBeGreaterThanOrEqual(5);
			expect(h.notices.filter(n => n.message.includes("Conductor verified the completion claim"))).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	test("verification spend is recorded live and restorable from the conductor transcript", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);

			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.goalState.goal?.status === "complete", "goal accepted");

			// Live accounting: one cue round + one stop round, each $0.01.
			expect(h.conductor.getCost()).toBeCloseTo(0.02, 5);

			// Restore path: the same number comes back from the recorded __conductor.jsonl transcript.
			await waitFor(async () => {
				const restored = await loadConductorTranscriptCost(h.sessionFile);
				return restored > 0;
			}, "transcript cost recorded");
			const restored = await loadConductorTranscriptCost(h.sessionFile);
			expect(restored).toBeCloseTo(0.02, 5);
			h.conductor.clearCost();
			h.conductor.restoreCost(restored);
			expect(h.conductor.getCost()).toBeCloseTo(0.02, 5);

			// No transcript → 0 (fresh sessions must not report phantom spend).
			expect(await loadConductorTranscriptCost(path.join(path.dirname(h.sessionFile), "absent.jsonl"))).toBe(0);
			expect(await loadConductorTranscriptCost(undefined)).toBe(0);
		} finally {
			await h.cleanup();
		}
	});

	test("recorded transcript keeps conductor spend out of advisor cost totals", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.goalState.goal?.status === "complete", "goal accepted");
			await waitFor(async () => (await loadConductorTranscriptCost(h.sessionFile)) > 0, "transcript written");

			const advisorCosts = await loadAdvisorTranscriptCosts(h.sessionFile);
			expect(advisorCosts.size).toBe(0);
			expect(await loadConductorTranscriptCost(h.sessionFile)).toBeCloseTo(0.02, 5);
		} finally {
			await h.cleanup();
		}
	});
});

describe("SessionConductor gate timeouts", () => {
	test("the idle gate never fires while the primary streams or the audit runs", async () => {
		const h = await createHarness({ "conductor.gateTimeoutSeconds": 1 });
		try {
			const goal = makeGoal("g1", 1000);
			h.goalState.goal = goal;

			let calls = 0;
			let releaseAudit: (() => void) | undefined;
			const auditGate = new Promise<void>(resolve => {
				releaseAudit = resolve;
			});
			h.script.current = () => {
				calls++;
				if (calls === 1) return auditGate.then(() => cueAccept());
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			// The claim pends mid-turn: the primary is still streaming its wrap-up. Before the idle-watchdog
			// change the gate armed here and fired at 1s, escalating a claim whose audit had not even started.
			h.agentState.isStreaming = true;
			h.conductor.onGoalUpdated(goal);
			await Bun.sleep(1300);
			expect(h.notices.filter(n => n.message.includes("Conductor escalation"))).toHaveLength(0);

			// The turn settles and the audit takes over: it runs past the gate period unpunished.
			h.agentState.isStreaming = false;
			h.conductor.onPrimaryTurnEnd(undefined);
			await Bun.sleep(400);
			expect(h.notices.filter(n => n.message.includes("Conductor escalation"))).toHaveLength(0);

			releaseAudit?.();
			await waitFor(() => h.goalState.goal?.status === "complete", "pended claim accepted after long audit");
			expect(h.notices.filter(n => n.message.includes("Conductor verified the completion claim"))).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	test("a pended claim nothing will verify escalates when the idle gate expires", async () => {
		const h = await createHarness({ "conductor.gateTimeoutSeconds": 1 });
		try {
			const goal = makeGoal("g1", 1000);
			h.goalState.goal = goal;
			h.script.current = () => ({ content: ["unused"], usage: { input: 10, output: 5, cost: { total: 0.01 } } });

			h.agentState.isStreaming = true;
			h.conductor.onGoalUpdated(goal);
			// Turn end claims a continuation hand-off while the goal is verifying: no continuation can fire and no
			// audit starts, so the claim would strand silently — the idle gate is what surfaces it.
			h.agentState.isStreaming = false;
			h.conductor.onPrimaryTurnEnd(true);

			await waitFor(() => h.notices.some(n => n.message.includes("Conductor escalation")), "idle gate escalation");
			expect(h.goalState.goal?.status).toBe("verifying");
			expect(h.conductor.getStats().escalated).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("commissioning is not bounded by the gate timeout", async () => {
		const h = await createHarness({ "conductor.gateTimeoutSeconds": 1 });
		try {
			let calls = 0;
			h.script.current = async () => {
				calls++;
				if (calls === 1) {
					// A healthy but slow investigation: under the old wall clock this aborted as a timeout.
					await Bun.sleep(1500);
					return programPropose();
				}
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			const outcome = await h.conductor.commission("add a greeting endpoint");

			expect(outcome.status).toBe("proposed");
			if (outcome.status !== "proposed") throw new Error("expected a proposed contract");
			expect(outcome.objective).toContain("## Verification");
		} finally {
			await h.cleanup();
		}
	});
});

describe("SessionConductor streaming display", () => {
	test("a verification run streams activity from running to completed with live progress", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.goalState.goal?.status === "complete", "goal accepted");

			expect(h.activities.length).toBeGreaterThanOrEqual(2);
			const first = h.activities[0]!;
			expect(first.status).toBe("running");
			expect(first.mode).toBe("verify");
			// The label is the contract's objective, collapsed to one line — what the HUD shows while it streams.
			expect(first.label.startsWith("## Objective")).toBe(true);
			expect(first.label.length).toBeLessThanOrEqual(80);
			expect(first.sessionFile?.endsWith("__conductor.jsonl")).toBe(true);
			expect(first.progress.modelRole).toBe("conductor");
			expect(first.progress.status).toBe("running");

			const last = h.activities[h.activities.length - 1]!;
			expect(last.status).toBe("completed");
			// Live accounting from the streamed turns: one assistant request, its usage, and the `cue` tool call.
			expect(last.progress.requests).toBeGreaterThanOrEqual(1);
			expect(last.progress.tokens).toBeGreaterThan(0);
			expect(last.progress.cost).toBeGreaterThan(0);
			expect(last.progress.toolCount).toBe(1);
			expect(last.progress.recentTools).toHaveLength(1);
			expect(last.progress.recentTools[0]?.tool).toBe("cue");
			// Terminal snapshots carry no in-flight tool.
			expect(last.progress.currentTool).toBeUndefined();
			expect(last.progress.durationMs).toBeGreaterThanOrEqual(0);
		} finally {
			await h.cleanup();
		}
	});

	test("an escalated verification reports a failed terminal status", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			h.script.current = () => ({
				// Three attempts, none calling `cue` → escalation.
				content: ["still investigating"],
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			});

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.notices.some(n => n.message.includes("Conductor escalation")), "escalation notice");

			const last = h.activities[h.activities.length - 1]!;
			expect(last.status).toBe("failed");
			expect(last.mode).toBe("verify");
			expect(h.activities[0]!.status).toBe("running");
		} finally {
			await h.cleanup();
		}
	});

	test("commissioning streams activity from running to completed", async () => {
		const h = await createHarness();
		try {
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return programPropose();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			const outcome = await h.conductor.commission("add a greeting endpoint");
			expect(outcome.status).toBe("proposed");

			expect(h.activities.length).toBeGreaterThanOrEqual(2);
			expect(h.activities[0]!.status).toBe("running");
			expect(h.activities[0]!.mode).toBe("commission");
			// The label previews the rough ask, not a contract heading.
			expect(h.activities[0]!.label).toBe("add a greeting endpoint");
			const last = h.activities[h.activities.length - 1]!;
			expect(last.status).toBe("completed");
			expect(last.progress.toolCount).toBe(1);
			expect(last.progress.recentTools[0]?.tool).toBe("program");
		} finally {
			await h.cleanup();
		}
	});
});

describe("SessionConductor bash allowlist", () => {
	test("commissioning arms the exploratory allowlist and teardown disarms it", async () => {
		const h = await createHarness();
		try {
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return programPropose();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			const outcome = await h.conductor.commission("add a greeting endpoint");

			expect(outcome.status).toBe("proposed");
			const policy = h.allowlistHistory[0];
			expect(policy?.("rg --files").allowed).toBe(true);
			expect(policy?.("rm -rf .").allowed).toBe(false);
			expect(h.allowlistHistory.at(-1)).toBeUndefined();
		} finally {
			await h.cleanup();
		}
	});

	test("verification turns never hold the commissioning allowlist", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.goalState.goal?.status === "complete", "goal accepted");
			const policy = h.allowlistHistory.find(entry => entry !== undefined);
			expect(policy).toBeDefined();
			expect(policy?.("bun test").allowed).toBe(true);
			expect(policy?.("bun test && rm -rf .").allowed).toBe(false);
		} finally {
			await h.cleanup();
		}
	});
});

describe("SessionConductor no-call retries", () => {
	test("commissioning retries from a clean context after a turn without a program call", async () => {
		const h = await createHarness();
		try {
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) {
					// Degenerate turn: the model stops without ever calling `program`.
					return { content: ["still investigating"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
				}
				if (calls === 2) return programPropose();
				// Post-tool continuation: one plain stop ends the turn.
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			const outcome = await h.conductor.commission("add a greeting endpoint");

			expect(outcome.status).toBe("proposed");
			// Attempt 1 (degenerate) + attempt 2 (program) + the post-tool continuation round.
			expect(calls).toBeGreaterThanOrEqual(3);
			// Attempt 2 must not see attempt 1's failed turn: a clean context, not a stacked history.
			expect(h.model.calls[1]?.context.messages.map(message => message.role)).toEqual(["user"]);
		} finally {
			await h.cleanup();
		}
	});

	test("commissioning failure reason describes the turns that produced no contract", async () => {
		const h = await createHarness();
		try {
			h.script.current = () => ({
				content: ["still investigating"],
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			});

			const outcome = await h.conductor.commission("add a greeting endpoint");

			expect(outcome.status).toBe("failed");
			if (outcome.status !== "failed") throw new Error("expected a failed commissioning outcome");
			expect(outcome.reason).toContain("after 3 attempts");
			expect(outcome.reason).toContain("without a `program` call");
			expect(outcome.reason).toContain("stop=stop");
		} finally {
			await h.cleanup();
		}
	});

	test("verification retries from a clean context after a turn without a cue call", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) {
					return { content: ["still investigating"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
				}
				if (calls === 2) return cueAccept();
				// Post-tool continuation: one plain stop ends the turn.
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => h.goalState.goal?.status === "complete", "goal accepted after clean-context retry");
			expect(h.model.calls[1]?.context.messages.map(message => message.role)).toEqual(["user"]);
			expect(h.notices.filter(n => n.message.includes("Conductor verified the completion claim"))).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});
});

describe("SessionConductor transition suspension", () => {
	test("suspendForTransition aborts an in-flight audit, blocks restarts, and re-arms on release", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return { ...cueAccept(), delayMs: 30_000 };
				if (calls === 2) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onGoalUpdated(h.goalState.goal);
			await waitFor(() => calls === 1, "in-flight verification request");

			await h.conductor.suspendForTransition();

			// The aborted audit must not retry or restart while the transition holds the conductor: a restarted turn
			// would stream into the conversation being rewritten and its recorder would target the old session file.
			await Bun.sleep(50);
			expect(calls).toBe(1);
			expect(h.goalState.goal?.status).toBe("verifying");

			h.conductor.resumeFromTransition();
			await waitFor(() => h.goalState.goal?.status === "complete", "re-armed audit completes");
			// Request 2 rules accept; request 3 is the plain post-tool continuation that settles the turn.
			expect(calls).toBe(3);
			expect(h.notices.some(n => n.message.includes("Conductor verified the completion claim"))).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("commissioning is refused while a transition suspension is active", async () => {
		const h = await createHarness();
		try {
			await h.conductor.suspendForTransition();
			const outcome = await h.conductor.commission("add a greeting endpoint");
			expect(outcome.status).toBe("busy");
			expect(outcome).toMatchObject({ reason: "A session transition is in progress." });
			expect(h.model.calls).toHaveLength(0);
		} finally {
			await h.cleanup();
		}
	});

	test("suspensions nest: a pended claim is audited only after the last release", async () => {
		const h = await createHarness();
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueAccept();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			await h.conductor.suspendForTransition();
			await h.conductor.suspendForTransition();

			h.conductor.onGoalUpdated(h.goalState.goal);
			await Bun.sleep(50);
			expect(calls).toBe(0);

			h.conductor.resumeFromTransition();
			await Bun.sleep(50);
			expect(calls).toBe(0);

			h.conductor.resumeFromTransition();
			await waitFor(() => h.goalState.goal?.status === "complete", "claim audited after last release");
			expect(calls).toBe(2);
		} finally {
			await h.cleanup();
		}
	});

	test("the idle watchdog does not fire while a suspension holds the conductor", async () => {
		const h = await createHarness({ "conductor.gateTimeoutSeconds": 0.05 });
		try {
			h.goalState.goal = makeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				return { content: ["no verdict"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			await h.conductor.suspendForTransition();
			h.conductor.onGoalUpdated(h.goalState.goal);
			await Bun.sleep(150);
			// An armed watchdog would have escalated by now (timeout truncates to 0ms); a suspended one must not.
			expect(calls).toBe(0);
			expect(h.conductor.getStats().escalated).toBe(false);

			h.conductor.resumeFromTransition();
			await waitFor(() => calls >= 1, "audit starts after release");
			expect(h.conductor.getStats().pendingGoalId).toBe("g1");
		} finally {
			await h.cleanup();
		}
	});
});

function cueNext(prompt?: string, extra: Record<string, unknown> = {}) {
	return {
		content: [
			{
				type: "toolCall" as const,
				name: "cue",
				arguments: { op: "next", ...(prompt === undefined ? {} : { prompt }), ...extra },
			},
		],
		usage: { input: 10, output: 5, cost: { total: 0.01 } },
	};
}

function activeGoal(id: string, updatedAt: number, overrides: Partial<Goal> = {}): Goal {
	return { ...makeGoal(id, updatedAt, "active"), ...overrides };
}

function assistantTurn(text: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 1, output: 1, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("SessionConductor epochs", () => {
	test("wakes after minEpochTurns settled turns and delivers the authored iteration prompt", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 2 });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			(h.agentState.messages as unknown[]).push(
				assistantTurn("Implementing milestone 1"),
				assistantTurn("Tests green"),
			);

			let calls = 0;
			h.script.current = () => {
				calls++;
				return calls === 1
					? cueNext("Focus on milestone 2; milestone 1 is verified.")
					: { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};

			h.conductor.onPrimaryTurnEnd(false);
			expect(h.sentMessages).toHaveLength(0);

			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.sentMessages.length > 0, "epoch prompt delivered");

			const epochMessage = h.sentMessages[0] as { customType: string; content: string; display: boolean };
			expect(epochMessage.customType).toBe("conductor-epoch");
			expect(epochMessage.content).toContain("Focus on milestone 2");
			expect(epochMessage.display).toBe(false);
			expect(h.conductor.getStats().epochCount).toBe(1);
			// The decision journal reaches /conduct status.
			expect(h.conductor.formatStatus()).toContain("Epochs: 1 ruled");
			expect(h.conductor.formatStatus()).toContain("prompt: Focus on milestone 2");
			// The cadence restarts: the delivered prompt resets the turn counter.
			h.conductor.onPrimaryTurnEnd(false);
			expect(h.sentMessages).toHaveLength(1);
		} finally {
			await h.cleanup();
		}
	});

	test("does not wake before the cadence spacing or without an active goal", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 3 });
		try {
			let calls = 0;
			h.script.current = () => {
				calls++;
				return cueNext();
			};

			h.goalState.goal = activeGoal("g1", 1000);
			h.conductor.onPrimaryTurnEnd(false);
			h.conductor.onPrimaryTurnEnd(true); // continuation hand-off: counted, never wakes
			expect(calls).toBe(0);
			expect(h.conductor.getStats().epochCount).toBe(0);

			// No active goal: no counting, no wake.
			h.goalState.goal = undefined;
			h.conductor.onPrimaryTurnEnd(false);
			h.goalState.goal = activeGoal("g1", 1000);
			h.conductor.onPrimaryTurnEnd(false);
			expect(calls).toBe(0);

			// Third settled turn of the stretch satisfies the spacing.
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => calls >= 1, "epoch wakes at the spacing boundary");
		} finally {
			await h.cleanup();
		}
	});

	test("a budget threshold crossing queues a wake reason that reaches the journal", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = activeGoal("g1", 1000, { tokenBudget: 100 });
			// At creation the tracker adopts the goal's current fraction without queuing anything.
			h.conductor.onGoalUpdated(h.goalState.goal);
			const spent = { ...h.goalState.goal, tokensUsed: 60, updatedAt: 1500 };
			h.goalState.goal = spent;
			h.conductor.onGoalUpdated(spent);

			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) return cueNext(undefined, { note: "watch the flaky test" });
				if (calls === 3) return cueNext();
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.conductor.getJournal().length >= 1, "threshold wake journaled");

			const entry = h.conductor.getJournal()[0];
			expect(entry?.wakeReasons.some(reason => reason.includes("budget 50% used"))).toBe(true);
			expect(entry?.note).toBe("watch the flaky test");
			expect(entry?.action).toBe("template");
			// Crossing the same threshold again never re-queues; the next one (80%) does.
			const more = { ...spent, tokensUsed: 70, updatedAt: 1600 };
			h.goalState.goal = more;
			h.conductor.onGoalUpdated(more);
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.conductor.getJournal().length >= 2, "next epoch after continued spend");
			expect(h.conductor.getJournal()[1]?.wakeReasons ?? []).toHaveLength(0);
		} finally {
			await h.cleanup();
		}
	});

	test("never wakes while a completion claim is pending", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = makeGoal("g1", 1000, "verifying");
			let calls = 0;
			h.script.current = () => {
				calls++;
				return cueAccept();
			};
			h.conductor.onPrimaryTurnEnd(false);
			await Bun.sleep(50);
			expect(calls).toBe(0);
			expect(h.sentMessages).toHaveLength(0);
		} finally {
			await h.cleanup();
		}
	});

	test("an authored prompt identical to the previous epoch is deduped, not re-delivered", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1 || calls === 3) return cueNext("Stay on milestone 2.");
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.sentMessages.length >= 1, "first epoch prompt delivered");
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.conductor.getJournal().length >= 2, "second epoch ruled");
			await Bun.sleep(50);
			expect(h.sentMessages).toHaveLength(1);
			expect(h.conductor.getJournal()[1]?.action).toBe("deduped");
		} finally {
			await h.cleanup();
		}
	});

	test("repeated dropped epochs halt epoch steering with a warning (loop fallback)", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				// Every attempt ends without a cue call: the turn carries nothing worth keeping.
				return { content: ["pondering"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			for (let i = 0; i < 3; i++) {
				h.conductor.onPrimaryTurnEnd(false);
				await waitFor(() => h.conductor.getStats().droppedEpochs >= i + 1, `epoch ${i + 1} dropped`);
			}
			await waitFor(() => h.notices.some(n => n.message.includes("epoch steering is paused")), "halt notice");
			expect(h.conductor.getStats().epochsHalted).toBe(true);

			// Halted steering does not start further epoch turns.
			const callsAtHalt = calls;
			h.conductor.onPrimaryTurnEnd(false);
			await Bun.sleep(50);
			expect(calls).toBe(callsAtHalt);
			// The verification gate is unaffected by the epoch halt.
			expect(h.conductor.isHealthy()).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("fallback=pause pauses the stretch when an epoch is dropped", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1, "conductor.fallback": "pause" });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			h.script.current = () => ({
				content: ["pondering"],
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			});
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.goalState.goal?.status === "paused", "stretch paused by fallback");
			expect(h.notices.some(n => n.message.includes("conductor.fallback = pause"))).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("epoch turns run on the exploratory bash allowlist, not the unrestricted verification grant", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			h.script.current = () => cueNext();
			let calls = 0;
			h.script.current = () => {
				calls++;
				return calls === 1
					? cueNext()
					: { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.conductor.getStats().epochCount >= 1, "epoch ruled");
			expect(h.allowlistHistory.some(policy => policy?.("rg --files").allowed === true)).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("an epoch escalate ruling halts the conductor", async () => {
		const h = await createHarness({ "conductor.minEpochTurns": 1 });
		try {
			h.goalState.goal = activeGoal("g1", 1000);
			let calls = 0;
			h.script.current = () => {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{
								type: "toolCall" as const,
								name: "cue",
								arguments: { op: "escalate", question: "The contract is unachievable; pick a smaller scope." },
							},
						],
						usage: { input: 10, output: 5, cost: { total: 0.01 } },
					};
				}
				return { content: ["done"], usage: { input: 10, output: 5, cost: { total: 0.01 } } };
			};
			h.conductor.onPrimaryTurnEnd(false);
			await waitFor(() => h.notices.some(n => n.message.includes("Conductor escalation")), "escalation");
			expect(h.conductor.getStats().escalated).toBe(true);
		} finally {
			await h.cleanup();
		}
	});
});
