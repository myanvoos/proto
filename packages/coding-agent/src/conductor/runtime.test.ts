import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai";
import { loadAdvisorTranscriptCosts } from "../advisor/transcript-recorder";
import { GoalRuntime, type GoalRuntimeHost } from "../goals/runtime";
import type { Goal } from "../goals/state";
import { READ_ONLY_EXPLORATORY_COMMANDS } from "../tools/bash-allowlist";
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
	allowlistHistory: Array<readonly string[] | undefined>;
	agentState: { isStreaming: boolean; promptCacheKey: undefined; telemetry: undefined };
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
	const allowlistHistory: Array<readonly string[] | undefined> = [];

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

	const agentState = { isStreaming: false, promptCacheKey: undefined, telemetry: undefined };
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
		setBashCommandAllowlist: allowlist => allowlistHistory.push(allowlist),
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
			expect(h.allowlistHistory[0]).toEqual(READ_ONLY_EXPLORATORY_COMMANDS);
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
			expect(h.allowlistHistory.every(entry => entry === undefined)).toBe(true);
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
