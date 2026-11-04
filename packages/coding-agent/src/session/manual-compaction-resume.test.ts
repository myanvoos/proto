/**
 * A manual /compact aborts the live turn, tool loop included. Before the fix the agent then sat idle on the
 * half-finished loop until the user typed "continue". The compaction now resumes the turn it interrupted once the
 * summary lands, unless the user's own next prompt — parked on the compaction barrier — takes the session first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { ExtensionRunner } from "../extensibility/extensions";
import { runExtensionCompact } from "../extensibility/extensions/compact-handler";
import { ExtensionRuntime } from "../extensibility/extensions/loader";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

interface CompactorControl {
	/** Holds `session_before_compact` open so a test can act while the compaction is in flight. */
	gate?: Promise<void>;
	cancel?: boolean;
	/** Extension slash commands handled locally, by name. */
	commands?: Record<string, () => void | Promise<void>>;
	/** Parks a prompt inside its awaited `before_agent_start` hook, before its message reaches the agent. */
	agentStart?: { entered: PromiseWithResolvers<void>; release: Promise<void> };
}

describe("manual compaction resumes the turn it interrupted", () => {
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;
	let dispatched: AgentMessage[][];

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		dispatched = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	/** Override only compaction controls; keep the real runner lifecycle and timer cleanup. */
	function extensionRunner(
		control: CompactorControl,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	): ExtensionRunner {
		const stub = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async (event: { type: string }) => {
				if (event.type !== "session_before_compact") return undefined;
				await control.gate;
				if (control.cancel) return { cancel: true };
				return {
					compaction: {
						summary: "[Session Goal]\n- compacted",
						shortSummary: "compacted",
						firstKeptEntryId: "",
						tokensBefore: 1_000,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => {
				if (!control.agentStart) return undefined;
				control.agentStart.entered.resolve();
				await control.agentStart.release;
				return undefined;
			},
			getCommand: (name: string) => {
				const handler = control.commands?.[name];
				return handler ? { handler: async () => handler() } : undefined;
			},
			createCommandContext: () => ({}),
			emitError: () => {},
		};
		return Object.assign(
			new ExtensionRunner([], new ExtensionRuntime(), process.cwd(), sessionManager, modelRegistry),
			stub,
		);
	}

	function createSession(control: CompactorControl = {}, settings: Record<string, unknown> = {}): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = new ModelRegistry(authStorage!);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.selfSummary": false,
				"compaction.keepRecentTokens": 1,
				...settings,
			}),
			modelRegistry,
			extensionRunner: extensionRunner(control, sessionManager, modelRegistry),
		});
		for (let turn = 0; turn < 3; turn++) {
			sessionManager.appendMessage({ role: "user", content: `question ${turn}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer ${turn}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			dispatched.push((Array.isArray(message) ? message : [message]) as AgentMessage[]);
		});
	}

	/** Put a turn in flight that the compaction's abort ends. */
	function startTurn(): void {
		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
	}

	function resumeNudges(): AgentMessage[] {
		return dispatched.flat().filter(message => message.role === "developer" && message.attribution === "agent");
	}

	function userPrompts(): string[] {
		return dispatched
			.flat()
			.filter(message => message.role === "user")
			.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
	}

	it("resumes an interrupted turn with the auto-continue nudge once the summary is committed", async () => {
		createSession();
		startTurn();

		await session.compact();
		await session.waitForIdle();

		expect(dispatched).toHaveLength(1);
		expect(resumeNudges()).toHaveLength(1);
	});

	it("starts no turn when the compaction interrupted nothing", async () => {
		createSession();

		await session.compact();
		await session.waitForIdle();

		expect(dispatched).toEqual([]);
	});

	it("leaves the turn stopped when compaction.autoContinue is off", async () => {
		createSession({}, { "compaction.autoContinue": false });
		startTurn();

		await session.compact();
		await session.waitForIdle();

		expect(dispatched).toEqual([]);
	});

	it("does not resume after a hook cancels the compaction", async () => {
		createSession({ cancel: true });
		startTurn();

		await expect(session.compact()).rejects.toThrow();
		await session.waitForIdle();

		expect(dispatched).toEqual([]);
	});

	it("reports an overlapping extension compaction through onError exactly once", async () => {
		const gate = Promise.withResolvers<void>();
		createSession({ gate: gate.promise });
		const errors: string[] = [];
		const compaction = runExtensionCompact(session, undefined);

		try {
			await runExtensionCompact(session, { onError: error => errors.push(error.message) });
			expect(errors).toEqual(["Compaction already in progress"]);
		} finally {
			gate.resolve();
			await compaction;
		}
	});

	it("preserves cancellation rejection for extension callers without onError", async () => {
		createSession({ cancel: true });

		await expect(runExtensionCompact(session, undefined)).rejects.toMatchObject({
			name: "CompactionCancelledError",
		});
	});

	it("does not report an extension completion callback exception as a failed compaction", async () => {
		createSession();
		const errors: string[] = [];

		await expect(
			runExtensionCompact(session, {
				onComplete: () => {
					throw new Error("Extension completion failed");
				},
				onError: error => errors.push(error.message),
			}),
		).rejects.toThrow("Extension completion failed");
		expect(errors).toEqual([]);
	});

	it("resumes after a no-op rejection, which leaves history unchanged", async () => {
		createSession();
		await session.compact();
		startTurn();

		await expect(session.compact()).rejects.toThrow("Already compacted");
		await session.waitForIdle();

		expect(resumeNudges()).toHaveLength(1);
	});

	it("lets a prompt parked on the compaction barrier take the session instead of the resume", async () => {
		const gate = Promise.withResolvers<void>();
		createSession({ gate: gate.promise });
		startTurn();

		const compaction = session.compact();
		await Bun.sleep(0);
		const parked = session.prompt("new direction");
		gate.resolve();
		await compaction;
		await parked;
		await session.waitForIdle();

		expect(userPrompts()).toEqual([expect.stringContaining("new direction")]);
		expect(resumeNudges()).toEqual([]);
	});

	it("hands the resume back when the parked prompt was a locally handled command", async () => {
		const gate = Promise.withResolvers<void>();
		const ran: string[] = [];
		createSession({ gate: gate.promise, commands: { local: () => void ran.push("local") } });
		startTurn();

		const compaction = session.compact();
		await Bun.sleep(0);
		const parked = session.prompt("/local");
		gate.resolve();
		await compaction;
		expect(await parked).toBe(false);
		await session.waitForIdle();

		expect(ran).toEqual(["local"]);
		expect(userPrompts()).toEqual([]);
		expect(resumeNudges()).toHaveLength(1);
	});

	it("does not resume when compaction lands while a prompt is still in setup", async () => {
		// The session reports busy while a prompt is in async setup, but the agent owns no turn yet. The
		// compaction abort drops that prompt; resuming would run the model on the previous transcript.
		const release = Promise.withResolvers<void>();
		const control: CompactorControl = {
			agentStart: { entered: Promise.withResolvers<void>(), release: release.promise },
		};
		createSession(control);

		const pending = session.prompt("new request");
		await control.agentStart?.entered.promise;
		expect(session.isStreaming).toBe(true);
		expect(session.agent.state.isStreaming).toBe(false);

		const compaction = session.compact();
		release.resolve();
		await compaction;
		await pending;
		await session.waitForIdle();

		expect(resumeNudges()).toEqual([]);
	});
});
