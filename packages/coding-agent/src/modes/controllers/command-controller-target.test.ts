import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { captureSessionCommandTarget } from "../../session/command-target";
import { detachedSessionHolder } from "../../session/detached-session-holder";
import { SessionManager } from "../../session/session-manager";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { CommandController } from "./command-controller";
import { adoptIndependentRoot } from "./foreground-session";

initThemeSync();
const sessions: AgentSession[] = [];
const stores: AuthStorage[] = [];
const directories: string[] = [];
const noop = () => {};

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(rootManager: SessionManager = SessionManager.inMemory()) {
	const authStorage = await AuthStorage.create(":memory:");
	stores.push(authStorage);
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled test model");
	const createSession = (manager: SessionManager = SessionManager.inMemory()) => {
		const agent = new Agent({ initialState: { model, tools: [], messages: [], systemPrompt: [] } });
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		return session;
	};
	const root = createSession(rootManager);
	const child = createSession();
	const output: Component[] = [];
	const notices: string[] = [];
	let resets = 0;
	let flushes = 0;
	let viewedSession = child;
	let focusedAgentId: string | undefined = "child";
	const ctx = {
		session: root,
		sessionManager: root.sessionManager,
		get viewSession() {
			return viewedSession;
		},
		get focusedAgentId() {
			return focusedAgentId;
		},
		unfocusSession: async () => {
			viewedSession = root;
			focusedAgentId = undefined;
		},
		attachSessionView: async (session: AgentSession) => {
			viewedSession = session;
			focusedAgentId = undefined;
		},
		settings,
		statusContainer: new Container(),
		statusLine: { invalidate: noop },
		ui: { terminal: { columns: 120 }, requestRender: noop, requestComponentRender: noop },
		presentCommandOutput: (components: Component | Component[]) =>
			output.push(...(Array.isArray(components) ? components : [components])),
		present: (components: Component[]) => output.push(...components),
		showWarning: (message: string) => notices.push(message),
		showError: (message: string) => notices.push(message),
		showStatus: (message: string) => notices.push(message),
		clearTransientSessionUi: noop,
		resetTranscript: () => {
			resets++;
		},
		updateEditorBorderColor: noop,
		flushCompactionQueue: async () => {
			flushes++;
		},
	} as unknown as InteractiveModeContext;
	return {
		root,
		child,
		ctx,
		output,
		notices,
		createSession,
		controller: new CommandController(ctx),
		focus: (session: AgentSession) => {
			viewedSession = session;
			focusedAgentId = session === ctx.session ? undefined : "child";
		},
		text: () => Bun.stripANSI(output.flatMap(component => component.render(120)).join("\n")),
		resets: () => resets,
		flushes: () => flushes,
	};
}

test("idle child inspection does not consult a busy root's context, tools, jobs, advisor or quota", async () => {
	const f = await fixture();
	f.root.agent.state.isStreaming = true;
	vi.spyOn(f.root, "getContextBreakdown").mockImplementation(() => {
		throw new Error("root context leaked");
	});
	vi.spyOn(f.root, "getXdevToolEntries").mockImplementation(() => {
		throw new Error("root tools leaked");
	});
	vi.spyOn(f.root, "getAsyncJobSnapshot").mockImplementation(() => {
		throw new Error("root jobs leaked");
	});
	vi.spyOn(f.root, "getAdvisorStats").mockImplementation(() => {
		throw new Error("root advisor leaked");
	});
	vi.spyOn(f.root, "fetchUsageReports").mockImplementation(() => {
		throw new Error("root quota leaked");
	});
	vi.spyOn(f.child, "getXdevToolEntries").mockReturnValue([{ name: "child_only", summary: "Child-visible tool" }]);
	vi.spyOn(f.child, "getAsyncJobSnapshot").mockReturnValue({
		running: [],
		recent: [{ id: "child-owned-job", type: "bash", status: "completed", label: "Child work", startTime: 1 }],
		delivery: { queued: 0, delivering: false, pendingJobIds: [], retainedBytes: 0, unresolvedCalls: 0, dropped: 0 },
	});
	vi.spyOn(f.child, "fetchUsageReports").mockResolvedValue([
		{ provider: "child-quota", fetchedAt: Date.now(), limits: [] },
	]);
	f.controller.handleContextCommand();
	f.controller.handleToolsCommand();
	await f.controller.handleJobsCommand();
	await f.controller.handleAdvisorStatusCommand();
	await f.controller.handleUsageCommand();
	expect(f.notices).toEqual([]);
	expect(f.text()).toContain("Context Usage");
	expect(f.text()).toContain("child_only");
	expect(f.text()).toContain("child-owned-job");
	expect(f.text()).toContain("Advisor is disabled");
	expect(f.text()).toContain("Child Quota");
	f.root.agent.state.isStreaming = false;
});

test("child rename persists only to the selected manager and suppresses a stale completion", async () => {
	const f = await fixture();
	await f.root.sessionManager.setSessionName("root original", "user");
	await f.controller.handleRenameCommand("child renamed");
	expect(f.child.sessionManager.getSessionName()).toBe("child renamed");
	expect(f.root.sessionManager.getSessionName()).toBe("root original");
	const pending = Promise.withResolvers<boolean>();
	vi.spyOn(f.child.sessionManager, "setSessionName").mockReturnValue(pending.promise);
	const operation = f.controller.handleRenameCommand("late child name");
	f.focus(f.root);
	f.notices.length = 0;
	pending.resolve(true);
	await operation;
	expect(f.notices).toEqual([]);
	expect(f.root.sessionManager.getSessionName()).toBe("root original");
});

test("a captured target cannot reset a different focus or a newer history head", async () => {
	const f = await fixture();
	const reset = vi.spyOn(f.child, "resetSessionContext");
	const target = captureSessionCommandTarget(f.child);
	f.focus(f.root);
	await f.controller.handleResetContextCommand(target);
	f.focus(f.child);
	f.child.sessionManager.appendMessage({ role: "user", content: "new history", timestamp: 1 });
	await f.controller.handleResetContextCommand(target);
	expect(reset).not.toHaveBeenCalled();
	expect(f.resets()).toBe(0);
});

test("resetting the child leaves root history intact and does not redraw a later focus", async () => {
	const f = await fixture();
	f.root.sessionManager.appendMessage({ role: "user", content: "root history", timestamp: 1 });
	const rootEntries = f.root.sessionManager.getEntries();
	const pending = Promise.withResolvers<{ droppedCount: number }>();
	const reset = vi.spyOn(f.child, "resetSessionContext").mockReturnValue(pending.promise);
	const operation = f.controller.handleResetContextCommand();
	f.focus(f.root);
	pending.resolve({ droppedCount: 3 });
	await operation;
	expect(reset).toHaveBeenCalledTimes(1);
	expect(f.root.sessionManager.getEntries()).toEqual(rootEntries);
	expect(f.resets()).toBe(0);
	expect(f.output).toEqual([]);
});

test("usage and advisor lookups cannot publish into a newly focused session", async () => {
	const f = await fixture();
	const pending = Promise.withResolvers<null>();
	vi.spyOn(f.child, "fetchUsageReports").mockReturnValue(pending.promise);
	const stats = f.child.getAdvisorStats();
	vi.spyOn(f.child, "getAdvisorStats").mockReturnValue({ ...stats, configured: true });
	const usage = f.controller.handleUsageCommand();
	const advisor = f.controller.handleAdvisorStatusCommand();
	f.focus(f.root);
	pending.resolve(null);
	await Promise.all([usage, advisor]);
	expect(f.output).toEqual([]);
	expect(f.notices).toEqual([]);
});

test("manual compaction uses child history and never clears the next focus's status or queue", async () => {
	const f = await fixture();
	for (const content of ["first", "second"]) {
		f.child.sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
	}
	const pending = Promise.withResolvers<never>();
	const compact = vi.spyOn(f.child, "compact").mockReturnValue(pending.promise);
	const rootCompact = vi.spyOn(f.root, "compact");
	const operation = f.controller.handleCompactCommand();
	f.focus(f.root);
	f.ctx.statusContainer.disposeChildren();
	const nextStatus = new Text("root busy", 0, 0);
	f.ctx.statusContainer.addChild(nextStatus);
	pending.reject(new Error("child compaction failed"));
	expect(await operation).toBe("failed");
	expect(compact).toHaveBeenCalledTimes(1);
	expect(rootCompact).not.toHaveBeenCalled();
	expect(f.ctx.statusContainer.children).toEqual([nextStatus]);
	expect(f.flushes()).toBe(0);
	expect(f.notices).toEqual([]);
});

test("fork adopts a new root returned by the selected child without mutating either source session", async () => {
	const f = await fixture();
	const forked = f.createSession();
	const rootId = f.root.sessionManager.getSessionId();
	const childId = f.child.sessionManager.getSessionId();
	const rootFork = vi.spyOn(f.root, "fork");
	const childFork = vi.spyOn(f.child, "fork").mockResolvedValue(forked);
	const disposeRoot = vi.spyOn(f.root, "dispose");
	const disposeChild = vi.spyOn(f.child, "dispose");
	await f.controller.handleForkCommand();
	expect(childFork).toHaveBeenCalledTimes(1);
	expect(rootFork).not.toHaveBeenCalled();
	expect(f.ctx.session).toBe(forked);
	expect(f.ctx.viewSession).toBe(forked);
	expect(f.root.sessionManager.getSessionId()).toBe(rootId);
	expect(f.child.sessionManager.getSessionId()).toBe(childId);
	expect(disposeRoot).not.toHaveBeenCalled();
	expect(disposeChild).not.toHaveBeenCalled();
});

test("fork finishing after a focus change preserves its record without replacing the current session", async () => {
	const f = await fixture();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "controller-fork-"));
	directories.push(directory);
	const forked = f.createSession(SessionManager.create(directory, directory));
	forked.sessionManager.appendMessage({ role: "user", content: "fork history", timestamp: 1 });
	await forked.sessionManager.ensureOnDisk();
	await forked.sessionManager.flush();
	const file = forked.sessionManager.getSessionFile();
	if (!file) throw new Error("Fork fixture must have durable history");
	const pending = Promise.withResolvers<AgentSession>();
	vi.spyOn(f.child, "fork").mockReturnValue(pending.promise);
	const release = vi.spyOn(forked, "dispose");
	const operation = f.controller.handleForkCommand();
	f.focus(f.root);
	pending.resolve(forked);
	await operation;
	expect(f.ctx.session).toBe(f.root);
	expect(f.ctx.viewSession).toBe(f.root);
	expect(release).toHaveBeenCalledTimes(1);
	const reopened = await SessionManager.open(file);
	try {
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ content: "fork history" }),
			}),
		);
	} finally {
		await reopened.close();
	}
	expect(f.output).toEqual([]);
});

test("independent root adoption parks the original root and leaves the focused child alive", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "controller-adopt-"));
	directories.push(directory);
	const f = await fixture(SessionManager.create(directory, directory));
	f.root.sessionManager.appendMessage({ role: "user", content: "source root", timestamp: 1 });
	const file = f.root.sessionManager.getSessionFile();
	if (!file) throw new Error("Source root must have a session file");
	const forked = f.createSession();
	const releaseRoot = vi.spyOn(f.root, "dispose");
	const releaseChild = vi.spyOn(f.child, "dispose");
	try {
		expect(await adoptIndependentRoot(f.ctx, forked, captureSessionCommandTarget(f.child))).toBe(true);
		expect(f.ctx.session).toBe(forked);
		expect(f.ctx.viewSession).toBe(forked);
		expect(f.ctx.focusedAgentId).toBeUndefined();
		expect(detachedSessionHolder.peek(file)?.session).toBe(f.root);
		expect(releaseRoot).not.toHaveBeenCalled();
		expect(releaseChild).not.toHaveBeenCalled();
	} finally {
		detachedSessionHolder.take(file);
	}
});

test("root replacement during parking cannot be overwritten or parked under the previous root's file", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "controller-adopt-race-"));
	directories.push(directory);
	const f = await fixture(SessionManager.create(directory, directory));
	f.root.sessionManager.appendMessage({ role: "user", content: "source root", timestamp: 1 });
	await f.root.sessionManager.ensureOnDisk();
	const file = f.root.sessionManager.getSessionFile();
	if (!file) throw new Error("Source root must have a session file");
	const pending = Promise.withResolvers<void>();
	vi.spyOn(f.root.sessionManager, "ensureOnDisk").mockReturnValue(pending.promise);
	const forked = f.createSession();
	const replacement = f.createSession();
	const release = vi.spyOn(forked, "dispose");
	try {
		const operation = adoptIndependentRoot(f.ctx, forked, captureSessionCommandTarget(f.child));
		f.ctx.session = replacement;
		f.focus(replacement);
		pending.resolve();
		expect(await operation).toBe(false);
		expect(f.ctx.session).toBe(replacement);
		expect(f.ctx.viewSession).toBe(replacement);
		expect(detachedSessionHolder.peek(file)?.session).toBe(f.root);
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		detachedSessionHolder.take(file);
	}
});

test("an adoption cannot recapture a changed source head after asynchronous fork construction", async () => {
	const f = await fixture();
	const source = captureSessionCommandTarget(f.child);
	const forked = f.createSession();
	const release = vi.spyOn(forked, "dispose");
	f.child.sessionManager.appendMessage({ role: "user", content: "newer source continuation", timestamp: 1 });
	expect(await adoptIndependentRoot(f.ctx, forked, source)).toBe(false);
	expect(f.ctx.session).toBe(f.root);
	expect(f.ctx.viewSession).toBe(f.child);
	expect(release).toHaveBeenCalledWith({ disposition: "runtime-release" });
});

test("an adoption refuses a changed source generation even when its head entry stays the same", async () => {
	const f = await fixture();
	const manager = f.child.sessionManager;
	await manager.setNodeTopology({ id: "source-child", rootId: "source-root", generation: 0, state: "active" });
	const source = captureSessionCommandTarget(f.child);
	const forked = f.createSession();
	const release = vi.spyOn(forked, "dispose");
	await manager.setNodeTopology({ id: "source-child", rootId: "source-root", generation: 1, state: "active" });
	expect(await adoptIndependentRoot(f.ctx, forked, source)).toBe(false);
	expect(f.ctx.session).toBe(f.root);
	expect(f.ctx.viewSession).toBe(f.child);
	expect(release).toHaveBeenCalledWith({ disposition: "runtime-release" });
});
