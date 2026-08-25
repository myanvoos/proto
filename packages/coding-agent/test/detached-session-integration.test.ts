/**
 * Integration tests for background continuation of main sessions.
 *
 * These exercise the REAL re-attach flow: a genuinely streaming AgentSession
 * (scripted provider stream gated by test-controlled promises) is driven
 * through SelectorController.handleResumeSession and the real
 * DetachedSessionHolder — switchSession is never mocked.
 *
 * Contracts covered:
 * - parking hands the live instance to the holder untouched; its in-flight
 *   turn keeps appending ONLY to its own transcript while the foreground
 *   moves to a different session pair;
 * - re-attaching swaps the parked instance in wholesale without aborting or
 *   re-switching its live turn;
 * - session.detachedMainSessions=false interrupts the turn honestly
 *   ("Interrupted" toast, classic in-place switch);
 * - deleting a session stops its parked instance first and never resurrects
 *   the deleted .jsonl;
 * - a failed cold-target construction leaves no stale holder entry and
 *   preserves the still-live parked turn.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentsViewComponent,
	type AgentsViewDeps,
} from "@oh-my-pi/pi-coding-agent/modes/components/agents-view/agents-view-mode";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { detachedSessionHolder } from "@oh-my-pi/pi-coding-agent/session/detached-session-holder";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface StreamingSession {
	session: AgentSession;
	manager: SessionManager;
	file: string;
	release: () => void;
}

function makeStreamingSession(tempDir: string, replyText: string, settings: Settings): StreamingSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled anthropic model");
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const manager = SessionManager.create(tempDir, tempDir);
	const gate = Promise.withResolvers<void>();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["test"], tools: [] },
		streamFn: () => {
			const response = createAssistantMessage(replyText);
			const stream = new AssistantMessageEventStream();
			void gate.promise.then(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop" as const, message: response });
			});
			return stream;
		},
	});
	const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
	return {
		session,
		manager,
		file: manager.getSessionFile() ?? "",
		release: () => gate.resolve(),
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 20_000; i++) {
		if (predicate()) return;
		await new Promise(resolve => setImmediate(resolve));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function transcript(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ---------------------------------------------------------------------------
// Minimal InteractiveModeContext fake: records what the controller does to the
// view surface without instantiating the TUI.
// ---------------------------------------------------------------------------

interface CtxHarness {
	ctx: InteractiveModeContext;
	attached: AgentSession[];
	statuses: string[];
	errors: string[];
	renderCount: number;
}

function makeCtx(session: AgentSession, settings: Settings): CtxHarness {
	const harness: CtxHarness = {
		ctx: {} as unknown as InteractiveModeContext,
		attached: [],
		statuses: [],
		errors: [],
		renderCount: 0,
	};
	const mutable = {
		session,
		sessionManager: session.sessionManager,
		agent: session.agent,
		settings,
		eventBus: undefined,
		mcpManager: undefined,
		getToolUIContext: () => undefined,
		attachSessionView: async (target: AgentSession) => {
			harness.attached.push(target);
		},
		clearTransientSessionUi: () => {},
		applyCwdChange: async () => {},
		renderInitialMessages: async () => {
			harness.renderCount += 1;
		},
		reloadTodos: async () => {},
		updateEditorBorderColor: () => {},
		showStatus: (message: string) => harness.statuses.push(message),
		showError: (message: string) => harness.errors.push(message),
	};
	harness.ctx = mutable as unknown as InteractiveModeContext;
	return harness;
}

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@detached-session-integration-");
	detachedSessionHolder.clear();
});

afterEach(async () => {
	detachedSessionHolder.clear();
	AgentRegistry.resetGlobalForTests();
	tempDir.removeSync();
});

describe("background continuation (real handleResumeSession flow)", () => {
	it("parks the live turn into its own transcript and builds a distinct foreground pair", async () => {
		const settings = Settings.isolated({ "session.detachedMainSessions": true });
		const a = makeStreamingSession(tempDir.path(), "PARKED-A-REPLY", settings);
		const turnA = a.session.prompt("work on A");
		await waitFor(() => a.session.isStreaming, "session A streaming");

		// Cold target transcript on disk.
		const bFile = path.join(tempDir.path(), "b.jsonl");
		await Bun.write(
			bFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "b",
					cwd: tempDir.path(),
					timestamp: "2026-08-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "hello b", timestamp: 1 } }),
				"",
			].join("\n"),
		);

		const { ctx } = makeCtx(a.session, settings);
		const controller = new SelectorController(ctx);

		const result = await controller.handleResumeSession(bFile);

		expect(result).toBe(true);
		// Foreground moved to a freshly constructed pair targeting B.
		const foreground = ctx.session as AgentSession;
		expect(foreground).not.toBe(a.session);
		expect(path.resolve(foreground.sessionManager.getSessionFile() ?? "")).toBe(path.resolve(bFile));
		// The parked entry owns exactly the old live instance and manager.
		expect(detachedSessionHolder.has(a.file)).toBe(true);
		expect(detachedSessionHolder.peek(a.file)?.session).toBe(a.session);
		expect(detachedSessionHolder.peek(a.file)?.manager).toBe(a.manager);
		// The parked turn is still live and untouched by the switch.
		expect(a.session.isStreaming).toBe(true);

		a.release();
		await turnA;
		await waitFor(() => transcript(a.file).includes("PARKED-A-REPLY"), "parked reply flushed");

		// Parked output landed ONLY in its own transcript.
		expect(transcript(bFile).includes("PARKED-A-REPLY")).toBe(false);
		expect(transcript(foreground.sessionManager.getSessionFile() ?? "").includes("PARKED-A-REPLY")).toBe(false);

		await foreground.dispose();
		await a.session.dispose();
	});

	it("re-attach swaps the parked instance in without aborting or re-switching its live turn", async () => {
		const settings = Settings.isolated({ "session.detachedMainSessions": true });
		const a = makeStreamingSession(tempDir.path(), "ATTACH-A-REPLY", settings);
		const b = makeStreamingSession(tempDir.path(), "ATTACH-B-REPLY", settings);
		const turnA = a.session.prompt("work on A");
		const turnB = b.session.prompt("work on B");
		await waitFor(() => a.session.isStreaming && b.session.isStreaming, "both sessions streaming");

		// Simulate an earlier detach: B is parked and still thinking.
		detachedSessionHolder.park(b.file, b.session, b.manager);

		const { ctx, attached, statuses } = makeCtx(a.session, settings);
		const controller = new SelectorController(ctx);
		const abortSpy = spyOn(b.session, "abort");
		const switchSpy = spyOn(b.session, "switchSession");

		const result = await controller.handleResumeSession(b.file);

		expect(result).toBe(true);
		// Wholesale swap-in: the taken instance became the foreground...
		expect(ctx.session).toBe(b.session);
		expect(attached).toEqual([b.session]);
		// ...without any abort and without routing through switchSession.
		expect(abortSpy).not.toHaveBeenCalled();
		expect(switchSpy).not.toHaveBeenCalled();
		expect(b.session.isStreaming).toBe(true);
		expect(statuses.some(status => status.startsWith("Parked"))).toBe(true);

		a.release();
		b.release();
		await Promise.all([turnA, turnB]);

		// Each turn's output stayed in its own transcript.
		const bTranscript = transcript(b.file);
		expect(bTranscript.includes("ATTACH-B-REPLY")).toBe(true);
		expect(bTranscript.includes("ATTACH-A-REPLY")).toBe(false);
		const aTranscript = transcript(a.file);
		expect(aTranscript.includes("ATTACH-A-REPLY")).toBe(true);
		expect(aTranscript.includes("ATTACH-B-REPLY")).toBe(false);

		await a.session.dispose();
		await b.session.dispose();
	});

	it("detachedMainSessions=false interrupts the streaming turn and toasts Interrupted", async () => {
		const settings = Settings.isolated({ "session.detachedMainSessions": false });
		const a = makeStreamingSession(tempDir.path(), "INTERRUPTED-A-REPLY", settings);
		const turnA = a.session.prompt("work on A");
		await waitFor(() => a.session.isStreaming, "session A streaming");

		const bFile = path.join(tempDir.path(), "ib.jsonl");
		await Bun.write(
			bFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "ib",
					cwd: tempDir.path(),
					timestamp: "2026-08-01T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "hello ib", timestamp: 1 } }),
				"",
			].join("\n"),
		);

		const h = makeCtx(a.session, settings);
		const controller = new SelectorController(h.ctx);
		const abortSpy = spyOn(a.session, "abort");

		const result = await controller.handleResumeSession(bFile);

		expect(result).toBe(true);
		// Gate off: no parking, honest interrupt, classic in-place switch.
		expect(detachedSessionHolder.has(a.file)).toBe(false);
		expect(abortSpy).toHaveBeenCalled();
		expect(h.ctx.session).toBe(a.session);
		expect(h.statuses.some(status => status.startsWith("Interrupted"))).toBe(true);
		// Cold in-place load renders explicitly (no wholesale swap-in happened).
		expect(h.renderCount).toBe(1);

		a.release();
		await turnA.catch(() => {});

		await a.session.dispose();
	});

	it("failed cold-target construction leaves no stale holder entry and preserves the live turn", async () => {
		const settings = Settings.isolated({ "session.detachedMainSessions": true });
		const a = makeStreamingSession(tempDir.path(), "FAILED-SWITCH-A-REPLY", settings);
		const turnA = a.session.prompt("work on A");
		await waitFor(() => a.session.isStreaming, "session A streaming");

		const { ctx, attached } = makeCtx(a.session, settings);
		const controller = new SelectorController(ctx);
		const constructionError = new Error("construction failed");
		const sdkSpy = spyOn(sdk, "createAgentSession").mockRejectedValue(constructionError);

		try {
			await expect(controller.handleResumeSession(path.join(tempDir.path(), "missing.jsonl"))).rejects.toThrow(
				"construction failed",
			);
		} finally {
			sdkSpy.mockRestore();
		}

		// Rollback: no stale entry, foreground identity unchanged, turn alive.
		expect(detachedSessionHolder.has(a.file)).toBe(false);
		expect(ctx.session).toBe(a.session);
		expect(attached).toEqual([]);
		expect(a.session.isStreaming).toBe(true);

		a.release();
		await turnA;
		await waitFor(() => transcript(a.file).includes("FAILED-SWITCH-A-REPLY"), "preserved reply flushed");
		await a.session.dispose();
	});
});

// ---------------------------------------------------------------------------
// Delete integration: the agents view /kill path must stop a parked instance
// before artifact deletion so the .jsonl cannot resurrect.
// ---------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;

function rendered(view: AgentsViewComponent, width = 140): string {
	return view.render(width).join("\n").replace(ANSI, "");
}

async function yieldToLoop(): Promise<void> {
	await new Promise(resolve => setImmediate(resolve));
}

async function typeInto(view: AgentsViewComponent, text: string): Promise<void> {
	for (const ch of text) view.handleInput(ch);
	await yieldToLoop();
}

function makeSessionInfo(filePath: string, id: string): SessionInfo {
	return {
		path: filePath,
		id,
		cwd: tempDir.path(),
		title: `${id} title`,
		created: new Date("2026-08-01T00:00:00Z"),
		modified: new Date("2026-08-01T01:00:00Z"),
		messageCount: 3,
		size: 512,
		firstMessage: `${id} first message`,
		allMessagesText: `${id} first message`,
	};
}

describe("deleting a session with a parked live instance", () => {
	beforeEach(() => {
		initTheme();
	});

	it("stops the parked turn before artifact deletion and never resurrects the file", async () => {
		const settings = Settings.isolated({ "session.detachedMainSessions": true });
		const victim = makeStreamingSession(tempDir.path(), "VICTIM-REPLY", settings);
		const turn = victim.session.prompt("keep writing");
		await waitFor(() => victim.session.isStreaming, "parked victim streaming");
		detachedSessionHolder.park(victim.file, victim.session, victim.manager);
		const abortSpy = spyOn(victim.session, "abort");

		const listSpy = spyOn(SessionManager, "listAll").mockResolvedValue([makeSessionInfo(victim.file, "victim")]);
		const deps = {
			ui: { terminal: { rows: 40 } },
			keybindings: { getKeys: () => [] },
			currentSessionFile: null,
			cwd: tempDir.path(),
			version: "test",
			modelName: "test-model",
			providerName: "test-provider",
			requestRender: () => {},
			close: () => {},
			focusAgent: async () => {},
			newSession: () => {},
			renameCurrentSession: async () => {},
			deleteCurrentSession: async () => {},
			promptAfterResume: async () => {},
			showError: () => {},
			showStatus: () => {},
		} as unknown as AgentsViewDeps;
		const view = new AgentsViewComponent(deps);
		try {
			await waitFor(() => rendered(view).includes("victim title"), "rows loaded");
			view.handleInput(" "); // arm reply composer on the victim row
			await typeInto(view, "/kill");
			view.handleInput("\r");
			await waitFor(() => !existsSync(victim.file), "transcript deleted");
		} finally {
			listSpy.mockRestore();
			view.dispose();
		}

		// The parked instance was stopped (aborted, awaited), not merely forgotten.
		expect(detachedSessionHolder.has(victim.file)).toBe(false);
		expect(abortSpy).toHaveBeenCalledTimes(1);

		// Releasing the (aborted) turn must not recreate the deleted file.
		victim.release();
		await turn.catch(() => {});
		await yieldToLoop();
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(existsSync(victim.file)).toBe(false);
		await victim.session.dispose().catch(() => {});
	});
});
