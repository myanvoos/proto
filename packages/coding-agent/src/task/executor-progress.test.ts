import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import * as sdkModule from "../sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { emptySubagentUsageTotals } from "../session/session-entries";
import { EventBus } from "../utils/event-bus";
import { resolveSoftRequestBudget, runSubprocess } from "./executor";
import { type AgentDefinition, type SubagentProgressPayload, WORKER_SUBAGENT_PROGRESS_CHANNEL } from "./types";

function createMockSession(onPrompt: (emit: (event: AgentSessionEvent) => void) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		get baseSystemPrompt() {
			return this.agent.state.systemPrompt;
		},
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getSubagentUsage: () => emptySubagentUsageTotals() },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt(emit);
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		getToolByName: () => undefined,
		abort: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
		holdIrcWakes: () => () => {},
		setWakeTurnObserver: () => {},
		getAsyncJobOwnerId: () => undefined,
		subscribeRunState: () => () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(emit => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-progress-projection",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { complete: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): sdkModule.CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as unknown as sdkModule.LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

afterEach(() => vi.restoreAllMocks());

const baseAgent: AgentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("subagent progress event projection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps yield output in the run result while omitting it from progress events", async () => {
		const session = yieldEmittingSession();
		const eventBus = new EventBus();
		const progressPayloads: SubagentProgressPayload[] = [];
		eventBus.on(WORKER_SUBAGENT_PROGRESS_CHANNEL, data => {
			progressPayloads.push(data as SubagentProgressPayload);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "progress-projection",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus,
		});

		expect(result.exitCode).toBe(0);
		expect(result.extractedToolData?.yield).toEqual([{ data: { complete: true }, status: "success" }]);
		expect(progressPayloads.length).toBeGreaterThan(0);
		expect(progressPayloads.every(payload => !Object.hasOwn(payload.progress, "extractedToolData"))).toBe(true);
	});
});

describe("subagent teardown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drains the advisor's review of a graceful final turn before disposing the session", async () => {
		const order: string[] = [];
		const session = Object.assign(yieldEmittingSession(), {
			prepareForHeadlessAdvisorDrain: () => {
				order.push("prepare");
			},
			waitForAdvisorCatchup: async () => {
				order.push("catchup");
				return true;
			},
			dispose: async () => {
				order.push("dispose");
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "advisor-drain",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
			eventBus: new EventBus(),
		});

		expect(result.exitCode).toBe(0);
		expect(order).toEqual(["prepare", "catchup", "dispose"]);
	});
});

describe("per-agent request budgets", () => {
	it("uses exact-name overrides without removing bundled fallback ceilings", () => {
		expect(resolveSoftRequestBudget("scout", 200, { scout: 300 })).toBe(300);
		expect(resolveSoftRequestBudget("worker", 800)).toBe(200);
		expect(resolveSoftRequestBudget("scout", 200, { scout: null })).toBe(100);
		expect(resolveSoftRequestBudget("scout", 50)).toBe(50);
		expect(resolveSoftRequestBudget("scout", 200, { scout: 0 })).toBe(0);
		expect(resolveSoftRequestBudget("scout", 0)).toBe(0);
		expect(() => resolveSoftRequestBudget("scout", 200, { scout: -1 })).toThrow("nonnegative integer");
	});

	it("persists extension-startup system prompt blocks for exact cold replay", async () => {
		const session = yieldEmittingSession();
		let savedPrompt: string | string[] | undefined;
		session.sessionManager.appendSessionInit = init => {
			savedPrompt = init.systemPrompt;
			return undefined as never;
		};
		Object.assign(session, {
			extensionRunner: {
				initialize: () => {},
				onError: () => {},
				emit: async () => {
					session.agent.state.systemPrompt = ["extension block", "agent block"];
				},
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "report",
			index: 0,
			id: "extension-prompt-snapshot",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as never,
		});
		expect(savedPrompt).toEqual(["extension block", "agent block"]);
	});
});

it("clamps a per-call :high model to the operator low ceiling before creating the child", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	let childThinking: string | undefined;
	let childCeiling: string | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		childThinking = options?.thinkingLevel;
		childCeiling = options?.thinkingLevelCeiling;
		return createSessionResult(yieldEmittingSession());
	});
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "report",
		index: 0,
		id: "per-call-low",
		modelRequested: true,
		modelOverride: "anthropic/claude-sonnet-4-5:high",
		settings: Settings.isolated({ "orchestrator.maxEffort": Effort.Low }),
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
		} as never,
	});
	expect(result.exitCode).toBe(0);
	expect(childThinking).toBe(Effort.Low);
	expect(childCeiling).toBe(Effort.Low);
});

it("refuses a per-call model whose lowest supported effort exceeds the ceiling", async () => {
	const fixture = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!fixture) throw new Error("Missing bundled fixture model");
	if (!fixture.thinking) throw new Error("Missing fixture thinking controls");
	const model = { ...fixture, thinking: { ...fixture.thinking, efforts: [Effort.High] } };
	const create = vi.spyOn(sdkModule, "createAgentSession");
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "report",
		index: 0,
		id: "floor-refused",
		modelRequested: true,
		model,
		settings: Settings.isolated({ "orchestrator.maxEffort": Effort.Low }),
		modelRegistry: { getAvailable: () => [model] } as never,
	});
	expect(result.exitCode).toBe(1);
	expect(result.error).toContain("cannot run at or below");
	expect(create).not.toHaveBeenCalled();
});

it("server-side streaming steps reach the request budget and get a final report turn", async () => {
	let prompts = 0;
	let aborts = 0;
	const session = Object.assign(
		createMockSession(emit => {
			if (++prompts === 1) {
				emit({
					type: "message_start",
					message: { role: "assistant", content: [] },
				} as unknown as AgentSessionEvent);
				for (let i = 0; i < 3; i++)
					emit({
						type: "tool_execution_end",
						toolCallId: `server-${i}`,
						toolName: "read",
						result: { content: [] },
						isError: false,
					});
			} else {
				emit({
					type: "tool_execution_end",
					toolCallId: "final",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: "partial findings" } },
					isError: false,
				});
			}
		}),
		{
			abort: async () => {
				aborts++;
			},
		},
	);
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "investigate",
		index: 0,
		id: "server-budget",
		settings: Settings.isolated({ "orchestrator.agentSoftRequestBudget": { worker: 2 } }),
		modelRegistry: {} as never,
	});
	expect(prompts).toBe(2);
	expect(aborts).toBeGreaterThan(0);
	expect(result.requests).toBe(3);
	expect(result.output).toBe("partial findings");
});

it("a terminal yield still validating prevents a sibling streaming step from budget-aborting the report", async () => {
	let aborts = 0;
	let beforeAccepted = -1;
	let prompts = 0;
	const session = Object.assign(
		createMockSession(emit => {
			prompts++;
			emit({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent);
			emit({ type: "tool_execution_start", toolCallId: "final", toolName: "yield" } as unknown as AgentSessionEvent);
			for (let i = 0; i < 3; i++)
				emit({
					type: "tool_execution_end",
					toolCallId: `sibling-${i}`,
					toolName: "read",
					result: { content: [] },
					isError: false,
				});
			beforeAccepted = aborts;
			emit({
				type: "tool_execution_end",
				toolCallId: "final",
				toolName: "yield",
				result: { content: [], details: { status: "success", data: "accepted report" } },
				isError: false,
			});
		}),
		{
			abort: async () => {
				aborts++;
			},
		},
	);
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "report",
		index: 0,
		id: "pending-yield-budget",
		settings: Settings.isolated({ "orchestrator.agentSoftRequestBudget": { worker: 1 } }),
		modelRegistry: {} as never,
	});
	expect(beforeAccepted).toBe(0);
	expect(prompts).toBe(1);
	expect(result.exitCode).toBe(0);
	expect(result.output).toBe("accepted report");
});

const createRealAgentSession = sdkModule.createAgentSession;

for (const shared of [false, true]) {
	it(`${shared ? "verified" : "unverified"} resolved child routes ${shared ? "inherit" : "do not inherit"} the sibling prompt-cache key on the provider request`, async () => {
		const modelFor = (verified: boolean) =>
			buildModel({
				provider: verified ? "muse-code" : "anthropic",
				id: verified ? "muse-spark-1.3" : "claude-sonnet-4-5",
				name: "cache-route-fixture",
				api: "openai-responses",
				baseUrl: "https://cache.test/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-child-cache-"));
		const auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "fixture-key");
		auth.setRuntimeApiKey("muse-code", "fixture-key");
		const settings = Settings.isolated();
		const registry = new ModelRegistry(auth, path.join(dir, "models.yml"), { settings });
		const provider = createMockModel({
			handler: {
				content: [{ type: "toolCall", name: "yield", arguments: { result: { complete: true } } }],
				stopReason: "toolUse",
			},
		});
		// Discovery/extension startup can replace a preliminary model before the child session is returned.
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options =>
			createRealAgentSession({
				...options,
				model: modelFor(shared),
				authStorage: auth,
				modelRegistry: registry,
				getApiKey: async () => "fixture-key",
				streamFn: provider.stream,
				disableExtensionDiscovery: true,
				enableMCP: false,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			}),
		);
		try {
			const result = await runSubprocess({
				cwd: dir,
				agent: baseAgent,
				task: "report",
				index: 0,
				id: `cache-route-${shared}`,
				model: modelFor(!shared),
				parentPromptCacheKey: "parent-lineage",
				settings,
				modelRegistry: registry,
			});
			expect(result.error).toBeUndefined();
			expect(provider.calls[0]?.options?.promptCacheKey).toBe(shared ? "parent-lineage:worker" : undefined);
			expect(provider.calls[0]?.context.tools?.some(tool => tool.name === "yield")).toBe(true);
		} finally {
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
