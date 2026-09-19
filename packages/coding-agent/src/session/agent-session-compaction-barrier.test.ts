/**
 * Custom-message prompts must park on the manual-compaction barrier.
 *
 * Skill invocations, collab peer prompts, RPC/ACP messages and the CLI initial
 * message all reach the session through promptCustomMessage(). While a manual
 * /compact owns the session it has disconnected the agent and aborted the turn;
 * a custom prompt that dispatches during that window starts a turn against the
 * disconnected session. prompt() already awaits the cleanup barrier, so the
 * regression is visible as an asymmetry between the two entrypoints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionMaintenance } from "./session-maintenance";
import { SessionManager } from "./session-manager";

describe("AgentSession manual-compaction barrier", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let restoreBarrier: (() => void) | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		restoreBarrier?.();
		restoreBarrier = undefined;
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession(): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	/** Bun's spyOn cannot stub accessors; swap the descriptor and restore it per test. */
	function stubBarrier(barrier: Promise<void> | undefined): void {
		const proto = SessionMaintenance.prototype;
		const original = Object.getOwnPropertyDescriptor(proto, "manualCompactionCleanup");
		if (!original) throw new Error("Expected SessionMaintenance.manualCompactionCleanup accessor");
		restoreBarrier = () => Object.defineProperty(proto, "manualCompactionCleanup", original);
		Object.defineProperty(proto, "manualCompactionCleanup", { ...original, get: () => barrier });
	}

	/** Deterministic settle point: drain the microtask queue, never the wall clock. */
	async function flushMicrotasks(): Promise<void> {
		for (let index = 0; index < 200; index++) await Promise.resolve();
	}

	function trackDispatch(): string[] {
		const dispatched: string[] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			const messages = Array.isArray(message) ? message : [message];
			for (const entry of messages) {
				if (typeof entry === "string") {
					dispatched.push("text");
					continue;
				}
				dispatched.push(entry.role === "custom" ? entry.customType : entry.role);
			}
		});
		return dispatched;
	}

	it("holds a custom prompt until the manual compaction cleanup resolves", async () => {
		createSession();
		const dispatched = trackDispatch();

		const cleanup = Promise.withResolvers<void>();
		stubBarrier(cleanup.promise);

		const peerPrompt = session.promptCustomMessage({
			customType: "collab-prompt",
			content: "peer redirect",
			display: true,
			attribution: "user",
		});

		await flushMicrotasks();
		expect(dispatched).toEqual([]);

		cleanup.resolve();
		await peerPrompt;
		expect(dispatched).toEqual(["collab-prompt"]);
	});

	it("dispatches a custom prompt immediately when no manual compaction is in flight", async () => {
		createSession();
		const dispatched = trackDispatch();

		await session.promptCustomMessage({
			customType: "skill-prompt",
			content: "run the skill",
			display: true,
			attribution: "user",
		});

		expect(dispatched).toEqual(["skill-prompt"]);
	});
});
