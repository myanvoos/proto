import type { FleetDetails } from "../../tools/fleet";
import type { JobsDetails } from "../../tools/jobs";
import type { GalleryFixture } from "./types";

const FIXTURE_NOW = Date.now();
const WORKER_ID = "worker-7181122334455667001";

const runningWorker = {
	id: WORKER_ID,
	label: "AuthLoader",
	agent: "worker",
	lifecycle: "live" as const,
	turnState: "running" as const,
	turns: 1,
	queued: 0,
	turnJobId: `${WORKER_ID}-t1`,
	queuedJobIds: [],
	model: "anthropic/claude-opus-5-5",
	turnStartedAt: FIXTURE_NOW - 3_000,
	turnMessage: "Inspect the session-cookie validation flow",
	trace: ["read(packages/server/src/auth/session.ts)"],
	outputTail: ["Tracing cookie verification…"],
	lastActivityAt: FIXTURE_NOW,
};

export const agenticFixtures: Record<string, GalleryFixture> = {
	fleet_spawn: {
		label: "Fleet spawn",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: {
			op: "spawn",
			label: "AuthLoader",
			message: "Inspect packages/server/src/auth/session.ts",
		},
		args: {
			op: "spawn",
			label: "AuthLoader",
			message: "Inspect the session-cookie validation flow and report gaps.",
		},
		result: {
			content: [{ type: "text", text: `Spawned \`worker\` worker \`${WORKER_ID}\` (label \`AuthLoader\`).` }],
			details: {
				op: "spawn",
				spawned: { id: WORKER_ID, label: "AuthLoader", agent: "worker" },
				receipt: {
					workerId: WORKER_ID,
					label: "AuthLoader",
					turn: 1,
					job: { kind: "job", id: `${WORKER_ID}-t1` },
					status: "accepted",
					mode: "turn",
				},
				screens: [runningWorker],
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: 'Model "nonexistent/model-xyz" did not match any available model. Available: anthropic/claude-opus-5-5.',
				},
			],
			details: { op: "spawn", screens: [] } satisfies FleetDetails,
		},
	},

	fleet_send: {
		label: "Fleet send (tracked)",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: { op: "send", id: WORKER_ID, message: "Also cover the" },
		args: { op: "send", id: WORKER_ID, message: "Also cover the expired-cookie path." },
		result: {
			content: [{ type: "text", text: `Queued turn 2 for busy worker \`${WORKER_ID}\`; receipt: queued.` }],
			details: {
				op: "send",
				receipt: {
					workerId: WORKER_ID,
					label: "AuthLoader",
					turn: 2,
					job: { kind: "job", id: `${WORKER_ID}-t2` },
					status: "queued",
					mode: "queued",
				},
				screens: [{ ...runningWorker, queued: 1, queuedJobIds: [`${WORKER_ID}-t2`] }],
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: `Unknown worker "AuthLoader". Active workers: ${WORKER_ID}` }],
			details: { op: "send", screens: [runningWorker] } satisfies FleetDetails,
		},
	},

	fleet_workers: {
		label: "Fleet workers",
		customRendered: true,
		renderer: "fleet",
		streamingArgs: { op: "list" },
		args: { op: "list" },
		result: {
			content: [
				{ type: "text", text: `- \`${WORKER_ID}\` (label \`AuthLoader\`) [worker] lifecycle=live · turn=running` },
			],
			details: { op: "list", scope: "owned", screens: [runningWorker] } satisfies FleetDetails,
		},
	},

	fleet_message: {
		label: "Fleet message",
		renderer: "fleet",

		streamingArgs: { op: "message", to: "AuthLoader", message: "Are you still touching" },
		args: {
			op: "message",
			to: WORKER_ID,
			message: "Are you still touching src/server/auth.ts? I need to add a 401 path.",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Accepted by 1 peer(s): 1 delivered, 0 queued.",
						`- ${WORKER_ID}: delivered; wake requested; turn start is not confirmed; session revived`,
					].join("\n"),
				},
			],
			details: {
				op: "message",
				senderId: "Main",
				to: WORKER_ID,
				receipts: [{ to: WORKER_ID, outcome: "delivered", effect: "wake_requested", revived: true }],
			} satisfies FleetDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: 'No recipients accepted the message.\n- RateLimiter: rejected — unknown agent "RateLimiter"',
				},
			],
			details: {
				op: "message",
				senderId: "Main",
				to: "RateLimiter",
				receipts: [{ to: "RateLimiter", outcome: "rejected", error: 'unknown agent "RateLimiter"' }],
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
				senderId: "Main",
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
		streamingArgs: { op: "list", scope: "visible" },
		args: { op: "list", scope: "visible" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 peer(s):",
						"- AuthLoader [worker · sub · lifecycle=live · turn=idle] — parent Main, active 2m ago",
						"- RateLimiter [worker · sub · lifecycle=parked · turn=idle] — unread 2, parent Main, active 12m ago",
						"",
						"Parked agents are revived automatically when you message them.",
					].join("\n"),
				},
			],
			details: {
				op: "list",
				scope: "visible",
				senderId: "Main",
				peers: [
					{
						id: "AuthLoader",
						label: "worker",
						kind: "sub",
						lifecycle: "live",
						turnState: "idle",
						parentId: "Main",
						unread: 0,
						lastActivity: FIXTURE_NOW - 2 * 60_000,
					},
					{
						id: "RateLimiter",
						label: "worker",
						kind: "sub",
						lifecycle: "parked",
						turnState: "idle",
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
			details: { op: "list", scope: "visible" } satisfies FleetDetails,
		},
	},

	goal: {
		label: "Goal",

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

	jobs_wait: {
		label: "Jobs wait",
		renderer: "jobs",

		streamingArgs: { op: "wait", targets: [{ kind: "job", id: "job_a1" }] },
		args: {
			op: "wait",
			targets: [
				{ kind: "job", id: "job_a1" },
				{ kind: "job", id: "job_b2" },
				{ kind: "job", id: "job_c3" },
			],
		},
		result: {
			content: [{ type: "text", text: "3 jobs settled." }],
			details: {
				op: "wait",
				jobs: [
					{
						ref: { kind: "job", id: "job_a1" },
						type: "bash",
						status: "completed",
						settled: true,
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 pass, 0 fail (18.4s)",
					},
					{
						ref: { kind: "job", id: "job_b2" },
						type: "worker",
						status: "completed",
						settled: true,
						label: "Migrate rate limiter to a sliding window",
						durationMs: 96_700,
						resultText: "Rewrote rate-limit.ts to a token-bucket; added per-account keys.",
					},
					{
						ref: { kind: "job", id: "job_c3" },
						type: "bash",
						status: "failed",
						settled: true,
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome: 2 errors in tokens.ts — noUnusedVariables, useConst",
					},
				],
			} satisfies JobsDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: 'No owned job job_d4. It expired, belongs to another owner, or has a different kind; list your references with op "list".',
				},
			],
			details: { op: "wait" } satisfies JobsDetails,
		},
	},
};
