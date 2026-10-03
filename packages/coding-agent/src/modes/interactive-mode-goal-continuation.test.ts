import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { convertToLlm } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import type { ChecklistPhase } from "../tools/checklist";
import { InteractiveMode } from "./interactive-mode";
import { initTheme } from "./theme/theme";
import type { SubmittedUserInput } from "./types";

const CONTINUATION_DELAY_MS = 800;

/** Session events reach InteractiveMode through a few promise hops; drain them without wall-clock waits. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("goal continuation", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	// Each continuation run calls (unregistered) bash with the next command, then stops once it sees the result.
	let commands: string[];

	beforeEach(async () => {
		commands = [];
		const mock = createMockModel({
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["checked"] }
					: { content: [{ type: "toolCall", name: "bash", arguments: { command: commands.shift() ?? "true" } }] },
		});
		await initTheme();
		await Settings.init({ inMemory: true });
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["test"],
					tools: [],
					messages: [],
				},
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		await session.goalRuntime.createGoal({ objective: "Ship the release" });
		await drainMicrotasks();
		expect(mode.goalModeEnabled).toBe(true);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
	});

	/** Arm the input waiter and let the continuation delay elapse; returns the auto-submitted input, if any. */
	async function nextContinuation(): Promise<SubmittedUserInput | undefined> {
		vi.useFakeTimers();
		let resolved: SubmittedUserInput | undefined;
		const waiter = mode.getUserInput().then(input => {
			resolved = input;
		});
		vi.advanceTimersByTime(CONTINUATION_DELAY_MS);
		vi.useRealTimers();
		await drainMicrotasks();
		if (!resolved) {
			mode.onInputCallback?.(mode.startPendingSubmission({ text: "user takes over" }));
			await waiter;
			return undefined;
		}
		return resolved;
	}

	/** Run a submitted continuation the way the main loop does; its run calls bash with `command`. */
	async function runContinuation(input: SubmittedUserInput, command: string): Promise<void> {
		commands.push(command);
		expect(mode.markPendingSubmissionStarted(input)).toBe(true);
		await session.promptCustomMessage({
			customType: "goal-continuation",
			content: input.text,
			display: false,
			attribution: "agent",
		});
		mode.finishPendingSubmission(input);
		await drainMicrotasks();
	}

	function setChecklist(phases: ChecklistPhase[]): void {
		session.setChecklistPhases(phases);
	}

	it("waits for the user when every open checklist item is blocked", async () => {
		setChecklist([
			{
				name: "Approval",
				tasks: [
					{ content: "Prepare the proposal", status: "completed" },
					{ content: "Apply the approved change", status: "blocked" },
				],
			},
		]);
		expect(await nextContinuation()).toBeUndefined();
	});

	it("keeps continuing while actionable work remains beside blocked work", async () => {
		setChecklist([
			{
				name: "Release",
				tasks: [
					{ content: "Get approval", status: "blocked" },
					{ content: "Run independent checks", status: "pending" },
				],
			},
		]);
		expect((await nextContinuation())?.customType).toBe("goal-continuation");
	});

	it("stops once a continuation repeats the previous one's tool activity", async () => {
		const first = await nextContinuation();
		expect(first?.customType).toBe("goal-continuation");
		await runContinuation(first!, "bun test");

		const second = await nextContinuation();
		expect(second?.customType).toBe("goal-continuation");
		await runContinuation(second!, "bun run check");

		const third = await nextContinuation();
		expect(third?.customType).toBe("goal-continuation");
		await runContinuation(third!, "bun run check");

		expect(await nextContinuation()).toBeUndefined();
	});
});
