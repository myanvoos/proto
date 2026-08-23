// Gallery fixtures for orchestration, fleet, and goal tools.

import type { FleetDetails } from "../../tools/fleet";
import type { OrchestrateToolDetails } from "../../tools/orchestrate";
import type { GalleryFixture } from "./types";

/** Message/activity timestamps are offsets from load time so gallery ages stay plausible. */
const FIXTURE_NOW = Date.now();

export const agenticFixtures: Record<string, GalleryFixture> = {
	orchestrate_spawn: {
		label: "Orchestrate spawn",
		customRendered: true,
		streamingArgs: {
			agent: "worker",
			name: "AuthLoader",
			prompt: "Inspect packages/server/src/auth/session.ts",
		},
		args: {
			agent: "worker",
			name: "AuthLoader",
			prompt: "Inspect the session-cookie validation flow and report gaps.",
		},
		result: {
			content: [{ type: "text", text: "Spawned worker `AuthLoader`." }],
			details: {
				op: "spawn",
				spawned: { id: "AuthLoader", agent: "worker", jobId: "AuthLoader-t1" },
				screens: [
					{
						id: "AuthLoader",
						agent: "worker",
						state: "running",
						turns: 1,
						queued: 0,
						turnStartedAt: FIXTURE_NOW - 3_000,
						turnMessage: "Inspect the session-cookie validation flow",
						trace: ["read(packages/server/src/auth/session.ts)"],
						outputTail: ["Tracing cookie verification…"],
						lastActivityAt: FIXTURE_NOW,
					},
				],
			} satisfies OrchestrateToolDetails,
		},
	},

	fleet_send: {
		label: "Fleet send",
		renderer: "fleet",
		// Streaming: recipient known; the message body still arriving.
		streamingArgs: { op: "send", to: "AuthLoader", message: "Are you still touching" },
		args: {
			op: "send",
			to: "AuthLoader",
			message: "Are you still touching src/server/auth.ts? I need to add a 401 path.",
			await: true,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Delivered to 1 peer(s):",
						"- AuthLoader: revived",
						"",
						"Reply from AuthLoader:",
						"Done with auth.ts — go ahead, just rebase past my session-store rename.",
					].join("\n"),
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "AuthLoader",
				receipts: [{ to: "AuthLoader", outcome: "revived" }],
				waited: {
					id: "7181122334455667789",
					from: "AuthLoader",
					to: "Main",
					body: "Done with auth.ts — go ahead, just rebase past my session-store rename.",
					ts: FIXTURE_NOW - 5_000,
					replyTo: "7181122334455667788",
				},
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: 'No recipients received the message.\n- RateLimiter: failed — unknown agent "RateLimiter"',
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "RateLimiter",
				receipts: [{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' }],
			} satisfies FleetDetails,
		},
	},

	fleet_wait: {
		label: "Fleet wait",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: { op: "wait", from: "AuthLoader" },
		args: { op: "wait", from: "AuthLoader", timeoutMs: 60_000 },
		result: {
			content: [
				{
					type: "text",
					text: "[7181122334455667790] AuthLoader: session-store rename is merged; auth.ts is yours.",
				},
			],
			details: {
				op: "wait",
				from: "Main",
				waited: {
					id: "7181122334455667790",
					from: "AuthLoader",
					to: "Main",
					body: "session-store rename is merged; auth.ts is yours.",
					ts: FIXTURE_NOW - 30_000,
				},
			} satisfies FleetDetails,
		},
	},

	fleet_inbox: {
		label: "Fleet inbox",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: { op: "inbox" },
		args: { op: "inbox", peek: true },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 unread message(s):",
						"- [7181122334455667791] AuthLoader: fleet table reads unreadCount — ping me when the bus lands.",
						"- [7181122334455667792] RateLimiter (reply to 7181122334455667791): bus is in; receipts carry outcome.",
					].join("\n"),
				},
			],
			details: {
				op: "inbox",
				from: "Main",
				inbox: [
					{
						id: "7181122334455667791",
						from: "AuthLoader",
						to: "Main",
						body: "fleet table reads unreadCount — ping me when the bus lands.",
						ts: FIXTURE_NOW - 4 * 60_000,
					},
					{
						id: "7181122334455667792",
						from: "RateLimiter",
						to: "Main",
						body: "bus is in; receipts carry outcome.",
						ts: FIXTURE_NOW - 60_000,
						replyTo: "7181122334455667791",
					},
				],
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC inbox failed: message store unavailable." }],
			details: { op: "inbox" } satisfies FleetDetails,
		},
	},

	fleet_list: {
		label: "Fleet peers",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: { op: "list" },
		args: { op: "list" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 peer(s):",
						"- AuthLoader [worker · sub · idle] — parent Main, active 2m ago",
						"- RateLimiter [worker · sub · parked] — unread 2, parent Main, active 12m ago",
						"",
						"Parked agents are revived automatically when you message them.",
					].join("\n"),
				},
			],
			details: {
				op: "list",
				from: "Main",
				peers: [
					{
						id: "AuthLoader",
						displayName: "worker",
						kind: "sub",
						status: "idle",
						parentId: "Main",
						unread: 0,
						lastActivity: FIXTURE_NOW - 2 * 60_000,
					},
					{
						id: "RateLimiter",
						displayName: "worker",
						kind: "sub",
						status: "parked",
						parentId: "Main",
						unread: 2,
						lastActivity: FIXTURE_NOW - 12 * 60_000,
					},
				],
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC list failed: agent fleet is unavailable." }],
			details: { op: "list" } satisfies FleetDetails,
		},
	},

	goal: {
		label: "Goal",
		// Streaming: op is "create"; objective text still being typed.
		streamingArgs: { op: "create", objective: "Ship the auth hardening" },
		args: {
			op: "create",
			objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
			token_budget: 500_000,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Goal set. Working toward: Ship the auth hardening pass.",
				},
			],
			details: {
				op: "create",
				remainingTokens: 451_800,
				completionBudgetReport: null,
				goal: {
					id: "goal_8f2a",
					objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
					status: "active",
					tokenBudget: 500_000,
					tokensUsed: 48_200,
					timeUsedSeconds: 312,
					createdAt: 1_749_200_000_000,
					updatedAt: 1_749_200_312_000,
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Goal tool failed: objective is required when op=create." }],
			details: { op: "create" },
		},
	},

	think: {
		label: "Think",
		// Streaming: scratchpad thoughts still arriving.
		streamingArgs: {
			thoughts: "The retry loop re-reads the config after every failure, which explains the doubled latency.",
		},
		args: {
			thoughts:
				"The retry loop re-reads the config after every failure, which explains the doubled latency. Cache the parsed config outside the loop, then re-check the invalidation path.",
		},
		result: {
			content: [{ type: "text", text: "------" }],
			details: { recorded: true },
		},
	},

	fleet_jobs: {
		label: "Fleet jobs",
		renderer: "fleet",
		// Streaming: waiting on a single job id; the second id is still arriving.
		streamingArgs: { op: "wait", ids: ["job_a1"] },
		args: { op: "wait", ids: ["job_a1", "job_b2", "job_c3"] },
		result: {
			content: [{ type: "text", text: "3 jobs settled." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_a1",
						type: "bash",
						status: "completed",
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 pass, 0 fail (18.4s)",
					},
					{
						id: "job_b2",
						type: "worker",
						status: "completed",
						label: "Migrate rate limiter to a sliding window",
						durationMs: 96_700,
						resultText: "Rewrote rate-limit.ts to a token-bucket; added per-account keys.",
					},
					{
						id: "job_c3",
						type: "bash",
						status: "failed",
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome: 2 errors in tokens.ts — noUnusedVariables, useConst",
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "1 job failed." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_d4",
						type: "worker",
						status: "failed",
						label: "Refactor the session store to Redis",
						durationMs: 52_300,
						errorText: "Subagent exited 1: Redis connection string is missing.",
					},
				],
			},
		},
	},
};
