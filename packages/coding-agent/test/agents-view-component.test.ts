/**
 * Contract tests for the fullscreen agents view component.
 *
 * Covered contracts:
 * - Persistent view state carried across close/reopen: search query survives a
 *   plain close (Ctrl+D) once the controller pairs it with dispose, and is
 *   restored (and re-applied as a filter) on the next mount; selection identity
 *   survives so reopening lands on the same row; pre-carried scope frames scope
 *   the reopened list to the subtree.
 * - Armed-composer commands: /name renames the target session through storage,
 *   /kill deletes the target session, and any other builtin-looking command is
 *   rejected with an exact message while keeping the draft.
 * - formatModelCellLabel stable cell formatting (provider/id with :level).
 *
 * SessionManager.listAll is spied (never mock.module); every test gets a fresh
 * TempDir so nothing leaks across files.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
	AgentsViewComponent,
	type AgentsViewDeps,
} from "@oh-my-pi/pi-coding-agent/modes/components/agents-view/agents-view-mode";
import {
	type AgentsViewPersistentState,
	formatModelCellLabel,
} from "@oh-my-pi/pi-coding-agent/modes/components/agents-view/agents-view-state";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sumAssistantMessageUsage } from "@oh-my-pi/pi-coding-agent/session/session-stats";
import type { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
/** Spies created by the current test; restored in afterEach for suite safety. */
const activeSpies: Array<{ restore: () => void }> = [];
/** Views mounted by the current test; disposed in afterEach to clear timers. */
const mountedViews: AgentsViewComponent[] = [];

beforeEach(() => {
	initTheme();
	tempDir = TempDir.createSync("@agents-view-test-");
});

afterEach(() => {
	for (const spy of activeSpies.splice(0)) spy.restore();
	for (const view of mountedViews.splice(0)) view.dispose();
	tempDir.removeSync();
});

function sessionFile(name: string): string {
	return path.join(tempDir.path(), `${name}.jsonl`);
}

function makeSessionInfo(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	const filePath = sessionFile(id);
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
		...overrides,
	};
}

/** Write a realistic slotted transcript: mutable title slot, header, message. */
async function writeTranscript(name: string, oldTitle: string): Promise<string> {
	const file = sessionFile(name);
	await Bun.write(
		file,
		[
			JSON.stringify({ type: "title", v: 1, title: oldTitle, updatedAt: "2026-08-01T00:00:00.000Z" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: name,
				cwd: tempDir.path(),
				timestamp: "2026-08-01T00:00:00.000Z",
			}),
			JSON.stringify({ type: "message", message: { role: "user", content: `${name} opening prompt` } }),
			"",
		].join("\n"),
	);
	return file;
}

interface DepsHarness extends AgentsViewDeps {
	calls: {
		openSession: string[];
		closeCount: number;
		showStatus: string[];
		showError: string[];
		renameCurrentSession: string[];
	};
}

function makeDeps(persistentState?: AgentsViewPersistentState, registry?: AgentRegistry): DepsHarness {
	const calls: DepsHarness["calls"] = {
		openSession: [],
		closeCount: 0,
		showStatus: [],
		showError: [],
		renameCurrentSession: [],
	};
	const deps: AgentsViewDeps = {
		ui: { terminal: { rows: 40 } } as unknown as TUI,
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		cwd: tempDir.path(),
		version: "test",
		modelName: "test-model",
		providerName: "test-provider",
		requestRender: () => {},
		close: () => {
			calls.closeCount += 1;
		},
		openSession: async (sessionPath: string) => {
			calls.openSession.push(sessionPath);
			return true;
		},
		focusAgent: async () => {},
		newSession: () => {},
		renameCurrentSession: async (name: string) => {
			calls.renameCurrentSession.push(name);
		},
		deleteCurrentSession: async () => {},
		promptAfterResume: async () => {},
		showError: (message: string) => {
			calls.showError.push(message);
		},
		showStatus: (message: string) => {
			calls.showStatus.push(message);
		},
	};
	return Object.assign(deps, {
		calls,
		...(persistentState ? { persistentState } : {}),
		...(registry ? { registry } : {}),
	}) as DepsHarness;
}

function mount(deps: AgentsViewDeps): AgentsViewComponent {
	const view = new AgentsViewComponent(deps);
	mountedViews.push(view);
	return view;
}

function spyListAll(sessions: SessionInfo[]): void {
	const spy = spyOn(SessionManager, "listAll").mockResolvedValue([...sessions]);
	activeSpies.push({ restore: () => spy.mockRestore() });
}

const ANSI = /\x1b\[[0-9;]*m/g;

function rendered(view: AgentsViewComponent, width = 140): string {
	return view.render(width).join("\n").replace(ANSI, "");
}

/**
 * Condition-driven readiness loop. The component owns unref'd real intervals
 * internally and exposes no completion promises, so fake timers cannot drive
 * it; instead of timed sleeps we repeatedly yield to the event loop with
 * setImmediate until the awaited condition holds, failing naming the cause.
 */
function yieldToLoop(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 20000; i++) {
		if (predicate()) return;
		await yieldToLoop();
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function type(view: AgentsViewComponent, text: string): Promise<void> {
	for (const ch of text) view.handleInput(ch);
	await yieldToLoop();
}

/** Full transcript bytes; used to assert the rewritten title slot. */
function readTitle(file: string): string {
	return readFileSync(file, "utf8");
}

// ---------------------------------------------------------------------------
// Persistent view state across close/reopen
// ---------------------------------------------------------------------------

describe("agents view persistent state", () => {
	it("restores the search query and its filter after a plain close, and carries selection into the reopened view", async () => {
		const alpha = makeSessionInfo("alpha");
		const beta = makeSessionInfo("beta", { modified: new Date("2026-08-02T00:00:00Z") });
		spyListAll([alpha, beta]);
		const persistentState: AgentsViewPersistentState = {};

		// Instance 1: filter to alpha, then close plainly (Ctrl+D preserves the
		// query); the controller always pairs close with dispose, which is where
		// the final state flush happens.
		const deps1 = makeDeps(persistentState);
		const view1 = mount(deps1);
		await waitFor(() => rendered(view1).includes("beta title"), "rows loaded");
		await type(view1, "alpha");
		await waitFor(
			() => rendered(view1).includes("alpha title") && !rendered(view1).includes("beta title"),
			"query filters rows",
		);
		view1.handleInput("\u0004"); // ctrl+d closes without opening a chat
		expect(deps1.calls.closeCount).toBe(1);
		view1.dispose();
		expect(persistentState.query).toBe("alpha");

		// Instance 2: query text and its filtering are restored verbatim.
		const deps2 = makeDeps(persistentState);
		const view2 = mount(deps2);
		await waitFor(() => rendered(view2).includes("alpha title"), "reopened");
		expect(rendered(view2).includes("beta title")).toBe(false);

		// Selection carry: move once in a third instance and remember where Enter
		// lands; an instance restored from that state must land on the same row.
		const persistentState2: AgentsViewPersistentState = {};
		const deps3 = makeDeps(persistentState2);
		const view3 = mount(deps3);
		await waitFor(() => rendered(view3).includes("beta title"), "rows loaded");
		view3.handleInput("\x1b[B"); // down
		view3.handleInput("\r"); // enter opens the session (chat-opening close)
		await waitFor(() => deps3.calls.openSession.length > 0, "open session");
		expect(persistentState2.query).toBe("");
		expect(persistentState2.selectedRowIdentity).toBeDefined();

		const deps4 = makeDeps(persistentState2);
		const view4 = mount(deps4);
		await waitFor(() => rendered(view4).includes("beta title"), "rows reloaded");
		view4.handleInput("\r");
		await waitFor(() => deps4.calls.openSession.length > 0, "reopen lands on carried row");
		expect(deps4.calls.openSession[0]).toBe(deps3.calls.openSession[0]);
	});

	it("scopes a reopened instance to pre-carried scope frames, dropping the subtree root row", async () => {
		const parent = makeSessionInfo("parent");
		const child = makeSessionInfo("child", { parentSessionPath: parent.path });
		spyListAll([parent, child]);
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ identity: `file:${path.resolve(parent.path)}`, rootTitle: "ScopedRoot" }],
		};

		const view = mount(makeDeps(persistentState));
		await waitFor(() => rendered(view).includes("child title"), "scoped rows loaded");

		const out = rendered(view);
		expect(out.includes("ScopedRoot")).toBe(true);
		expect(out.includes("child title")).toBe(true);
		expect(out.includes("parent title")).toBe(false);
	});

	it("Esc from a /agents-scoped mount closes straight back to the main session and does not persist the teleported scope", async () => {
		const parent = makeSessionInfo("parent");
		const child = makeSessionInfo("child", { parentSessionPath: parent.path });
		spyListAll([parent, child]);
		const persistentState: AgentsViewPersistentState = {};

		const deps = makeDeps(persistentState);
		const view = mount({
			...deps,
			initialScopeIdentity: `file:${path.resolve(parent.path)}`,
			initialScopeTitle: "ScopedRoot",
		} as AgentsViewDeps);
		await waitFor(() => rendered(view).includes("child title"), "scoped rows loaded");

		view.handleInput("\x1b"); // esc — one press must close, not drill out
		expect(deps.calls.closeCount).toBe(1);
		view.dispose();
		expect(persistentState.scopeFrames).toBeUndefined();
	});

	it("Esc in plain browse mode closes immediately even with an active search query", async () => {
		spyListAll([makeSessionInfo("alpha"), makeSessionInfo("beta")]);
		const persistentState: AgentsViewPersistentState = {};
		const deps = makeDeps(persistentState);
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("beta title"), "rows loaded");
		await type(view, "alpha");
		await waitFor(() => rendered(view).includes("alpha title"), "query applied");

		view.handleInput("\x1b"); // esc — closes instead of clearing the query first
		expect(deps.calls.closeCount).toBe(1);
		view.dispose();
	});

	it("single ← from a /agents-scoped mount closes instead of revealing the global hierarchical browser", async () => {
		const parent = makeSessionInfo("parent");
		const child = makeSessionInfo("child", { parentSessionPath: parent.path });
		spyListAll([parent, child]);

		const deps = makeDeps();
		const view = mount({
			...deps,
			initialScopeIdentity: `file:${path.resolve(parent.path)}`,
			initialScopeTitle: "ScopedRoot",
		} as AgentsViewDeps);
		await waitFor(() => rendered(view).includes("child title"), "scoped rows loaded");

		view.handleInput("\x1b[D"); // left — pops the last frame
		expect(deps.calls.closeCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Composer command dispatch
// ---------------------------------------------------------------------------

describe("agents view composer commands", () => {
	it("/name renames the armed target through session storage", async () => {
		const file = await writeTranscript("named", "Old Name");
		spyListAll([makeSessionInfo("named", { title: "Old Name" })]);
		const deps = makeDeps();
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Old Name"), "row loaded");

		view.handleInput(" "); // arm composer on the selected row
		await type(view, "/name Fresh Name");
		view.handleInput("\r");

		await waitFor(() => readTitle(file).includes("Fresh Name"), "title rewritten");
		// Success feedback is a timed in-view toast, not the host status sink.
		expect(deps.calls.showStatus).toEqual([]);
		await waitFor(() => rendered(view).includes("Renamed to Fresh Name"), "rename toast");
		expect(deps.calls.renameCurrentSession).toEqual([]);
		expect(deps.calls.openSession).toEqual([]);
	});

	it("/kill deletes the armed target session instead of prompting it", async () => {
		const file = await writeTranscript("killed", "Kill Me");
		spyListAll([makeSessionInfo("killed", { title: "Kill Me" })]);
		const deps = makeDeps();
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Kill Me"), "row loaded");

		view.handleInput(" ");
		await type(view, "/kill");
		view.handleInput("\r");

		await waitFor(() => !existsSync(file), "session file removed");
		// The "Deleted" confirmation renders in the in-view hints slot after the
		// post-delete refresh settles; the view stays open and the file is gone.
		expect(deps.calls.closeCount).toBe(0);
		await waitFor(() => rendered(view).includes("Deleted"), "delete confirmation");
	});

	it("rejects other builtin-looking commands with the exact message and keeps the draft", async () => {
		await writeTranscript("rejectee", "Reject Me");
		spyListAll([makeSessionInfo("rejectee", { title: "Reject Me" })]);
		const deps = makeDeps();
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Reject Me"), "row loaded");

		view.handleInput(" ");
		await type(view, "/compact now");
		view.handleInput("\r"); // rejection path is synchronous through submit

		const out = rendered(view);
		expect(out.includes("/compact is not available here; open the session to run it")).toBe(true);
		// Every submit branch ends clean: no draft residue in the buffer.
		expect(out.includes("/compact now")).toBe(false);
		expect(deps.calls.openSession).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Model cell formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Header counts vs rendered sections (parked persisted-subagent refs)
// ---------------------------------------------------------------------------

describe("agents view header counts", () => {
	it("counts nested parked subagent rows in the same section block that renders them", async () => {
		// A live idle parent with two parked persisted-subagent child refs: the
		// children paint inside the parent's Idle block once expanded, so the
		// header must report 3 idle — not just the top-level parent.
		const registry = new AgentRegistry();
		const parentFile = sessionFile("parent");
		const childAFile = sessionFile("child-a");
		const childBFile = sessionFile("child-b");
		registry.register({
			id: "parent",
			displayName: "parent title",
			kind: "advisor",
			status: "idle",
			session: null,
			sessionFile: parentFile,
		});
		registry.register({
			id: "child-a",
			displayName: "child a",
			kind: "sub",
			parentId: "parent",
			status: "parked",
			session: null,
			sessionFile: childAFile,
		});
		registry.register({
			id: "child-b",
			displayName: "child b",
			kind: "sub",
			parentId: "parent",
			status: "parked",
			session: null,
			sessionFile: childBFile,
		});
		spyListAll([makeSessionInfo("parent", { path: parentFile })]);

		const view = mount(makeDeps({}, registry));
		await waitFor(() => rendered(view).includes("2 subagents"), "summary row loaded");

		// Expand the subagent list so the parked children render under Idle.
		view.handleInput("\x1b[B"); // down onto the summary row
		view.handleInput("\r"); // toggle expand
		await waitFor(() => rendered(view).includes("child a"), "children expanded");

		const out = rendered(view);
		expect(out.includes("Idle")).toBe(true);
		expect(out.includes("child b")).toBe(true);
		// Header tally equals the rows the Idle block paints: parent + both
		// children. The pre-fix counter only tallied top-level agent rows.
		expect(out.includes("3 idle")).toBe(true);
	});
});

describe("agents view hideSubagents", () => {
	it("renders an Inactive-only flat switcher: no Running/Idle sections, no subagent rows", async () => {
		// Same fixture family as the header-counts contract (aborted main
		// session + two parked persisted-subagent children): the double-← flavor
		// must show ONLY the Inactive section with the top-level session row —
		// live sections and every subagent row are dropped.
		const registry = new AgentRegistry();
		const parentFile = sessionFile("parent");
		registry.register({
			id: "parent",
			displayName: "parent title",
			kind: "main",
			status: "aborted",
			session: null,
			sessionFile: parentFile,
		});
		spyListAll([makeSessionInfo("parent", { path: parentFile })]);

		const deps = makeDeps({}, registry);
		deps.hideSubagents = true;
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Inactive"), "section rendered");
		await waitFor(() => rendered(view).includes("1 inactive"), "header tallied the inactive row");

		const out = rendered(view);
		expect(out.includes("Running")).toBe(false);
		expect(out.includes("Idle")).toBe(false);
		expect(out.includes("2 subagents")).toBe(false);
	});

	it("hides advisor transcripts and message-less sessions from the flat switcher", async () => {
		const registry = new AgentRegistry();
		// Live aborted advisor ref: excluded by kind even though it is Inactive.
		registry.register({
			id: "advisor-1",
			displayName: "advisor session",
			kind: "advisor",
			status: "aborted",
			session: null,
			sessionFile: sessionFile("advisor-1"),
		});
		// Persisted advisor transcript (no ref): excluded by its file name.
		const advisorFile = sessionFile("__advisor");
		registry.register({
			id: "advisor-2",
			displayName: "nested advisor transcript",
			kind: "sub",
			parentId: "someone",
			status: "parked",
			session: null,
			sessionFile: advisorFile,
		});
		// Message-less persisted session: no title, no first message.
		spyListAll([
			makeSessionInfo("empty", { title: undefined, firstMessage: "", allMessagesText: "", messageCount: 0 }),
			makeSessionInfo("real", { path: sessionFile("real") }),
		]);

		const deps = makeDeps({}, registry);
		deps.hideSubagents = true;
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("real title"), "kept session loaded");

		const out = rendered(view);
		expect(out.includes("advisor session")).toBe(false);
		expect(out.includes("nested advisor transcript")).toBe(false);
		expect(out.includes("(no messages)")).toBe(false);
		expect(out.includes("1 inactive")).toBe(true);
	});

	it("keeps the attached current session visible as Current while streaming", async () => {
		const registry = new AgentRegistry();
		const streamingFile = sessionFile("streaming");
		const otherFile = sessionFile("other");
		spyListAll([
			makeSessionInfo("streaming", {
				path: streamingFile,
				title: "streaming title",
				firstMessage: "hello streaming",
			}),
			makeSessionInfo("other", { path: otherFile, title: "other title", firstMessage: "hello other" }),
		]);

		const deps = makeDeps({}, registry);
		deps.hideSubagents = true;
		deps.currentSessionFile = streamingFile;
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("other title"), "kept session loaded");

		const out = rendered(view);
		expect(out.includes("other title")).toBe(true);
		expect(out.includes("streaming title")).toBe(true);
		expect(out.includes("Current")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Stats tolerance for usage-less assistant entries
// ---------------------------------------------------------------------------

describe("session stats", () => {
	it("sums totals across transcripts whose assistant messages lack usage and cost", () => {
		const totals = sumAssistantMessageUsage([
			{ role: "user", content: "hi" },
			// Legacy entry: no usage block at all.
			{ role: "assistant", content: [{ type: "text", text: "legacy" }] },
			// Partial entry: usage present but no cost block.
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1" }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			},
		] as never);
		expect(totals.input).toBe(10);
		expect(totals.output).toBe(5);
		expect(totals.totalTokens).toBe(15);
		expect(totals.cost).toBe(0);
		expect(totals.toolCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Enter-only open (Right must not open; Current section placement)
// ---------------------------------------------------------------------------

describe("agents view enter-only open", () => {
	it("opens the selected session on Enter and leaves Right inert", async () => {
		const solo = makeSessionInfo("solo");
		spyListAll([solo]);
		const deps = makeDeps();
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("solo title"), "row loaded");

		// Right falls through to the search editor's cursor handling.
		view.handleInput("\x1b[C"); // right
		await yieldToLoop();
		expect(deps.calls.openSession.length).toBe(0);

		view.handleInput("\r"); // enter
		await waitFor(() => deps.calls.openSession.length > 0, "session opened");
		expect(deps.calls.openSession[0]).toBe(solo.path);
	});
});

describe("agents view current section", () => {
	it("renders the attached session under Current above Inactive and closes instead of self-resuming on Enter", async () => {
		const hostFile = sessionFile("host");
		spyListAll([makeSessionInfo("host", { path: hostFile }), makeSessionInfo("other")]);
		const deps = makeDeps();
		deps.currentSessionFile = hostFile;
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("host title"), "rows loaded");

		const out = rendered(view);
		expect(out.includes("Current")).toBe(true);
		expect(out.indexOf("Current")).toBeLessThan(out.indexOf("Inactive"));
		expect(out.includes("1 current")).toBe(true);

		// Selection lands on the first row — the Current session. Enter returns
		// to its chat instead of re-resuming the attached transcript.
		view.handleInput("\r"); // enter
		await waitFor(() => deps.calls.closeCount > 0, "view closed");
		expect(deps.calls.openSession.length).toBe(0);
	});

	it("keeps Current out of the flat switcher only when no session file is attached", async () => {
		spyListAll([makeSessionInfo("solo")]);
		const deps = makeDeps();
		deps.hideSubagents = true;
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Inactive"), "section rendered");

		// currentSessionFile is null: no Current section, not even an empty one.
		expect(rendered(view).includes("Current")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Composer clean state across consecutive commands
// ---------------------------------------------------------------------------

describe("agents view composer consecutive commands", () => {
	it("keeps the buffer empty and surfaces each outcome across successive commands", async () => {
		const file = await writeTranscript("seq", "Seq Target");
		spyListAll([makeSessionInfo("seq", { title: "Seq Target" })]);
		const deps = makeDeps();
		const view = mount(deps);
		await waitFor(() => rendered(view).includes("Seq Target"), "row loaded");

		view.handleInput(" ");
		// A failing command must NOT resurrect its draft into the buffer.
		await type(view, "/name");
		view.handleInput("\r");
		await waitFor(() => rendered(view).includes("Usage: /name <session name>"), "usage warning");
		// Canary proves the buffer holds only what is typed next (no draft).
		await type(view, "1");
		expect(rendered(view).includes("/name1")).toBe(false);
		view.handleInput("\x7f"); // backspace clears the canary

		// Successive rejection keeps its draft but never accumulates residue.
		await type(view, "/compact");
		view.handleInput("\r");
		await waitFor(
			() => rendered(view).includes("/compact is not available here; open the session to run it"),
			"rejection",
		);

		// A subsequent successful command fully disarms the composer.
		await type(view, "/kill");
		view.handleInput("\r");
		await waitFor(() => !existsSync(file), "session removed");
		await waitFor(() => rendered(view).includes("Deleted"), "deleted toast");
		const out = rendered(view);
		expect(out.includes("/kill")).toBe(false);
		expect(out.includes("/compact")).toBe(false);
	});
});

describe("formatModelCellLabel", () => {
	it("renders provider/id and appends the thinking level unless it is off", () => {
		const model = { provider: "anthropic", id: "claude-opus-4" };
		expect(formatModelCellLabel(model)).toBe("anthropic/claude-opus-4");
		expect(formatModelCellLabel(model, "high")).toBe("anthropic/claude-opus-4:high");
		expect(formatModelCellLabel(model, "off")).toBe("anthropic/claude-opus-4");
		expect(formatModelCellLabel(model, "minimal")).toBe("anthropic/claude-opus-4:minimal");
	});
});
