import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

beforeEach(() => initThemeSync());
afterEach(() => vi.restoreAllMocks());

function fixture() {
	const root = SessionManager.inMemory();
	root.appendMessage({ role: "user", content: "root-only history", timestamp: 1 });
	const child = SessionManager.inMemory();
	const first = child.appendMessage({ role: "user", content: "child-only history", timestamp: 2 });
	child.appendMessage({ role: "user", content: "child continuation", timestamp: 3 });
	const navigated: string[] = [];
	const settled = Promise.withResolvers<void>();
	const childSession = {
		sessionManager: child,
		getAgentId: () => "child",
		navigateTree: async (entryId: string) => {
			navigated.push(entryId);
			child.branch(entryId);
			const node = child.getNodeTopology();
			if (node) await child.setNodeTopology({ ...node, generation: node.generation + 1 });
			return {};
		},
	} as unknown as AgentSession;
	const notices: string[] = [];
	let unfocuses = 0;
	let selector: Component | undefined;
	const ctx = {
		session: { sessionManager: root } as AgentSession,
		sessionManager: root,
		viewSession: childSession,
		focusedAgentId: "child",
		settings: Settings.isolated({ "branchSummary.enabled": true }),
		unfocusSession: async () => {
			unfocuses++;
		},
		showStatus: (message: string) => {
			notices.push(message);
			settled.resolve();
		},
		showError: (message: string) => {
			throw new Error(message);
		},
		showHookSelector: async () => "No summary",
		showHookEditor: async () => undefined,
		editor: { onEscape: undefined, getText: () => "" },
		ui: { terminal: { rows: 24 }, requestRender: () => {} },
		renderInitialMessages: async () => {},
		reloadChecklist: async () => {},
		truncateTranscriptFromMessage: () => false,
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	vi.spyOn(controller, "showSelector").mockImplementation(create => {
		selector = create(() => {}).component;
	});
	return {
		root,
		child,
		first,
		childSession,
		ctx,
		controller,
		navigated,
		notices,
		settled: settled.promise,
		get selector() {
			return selector;
		},
		get unfocuses() {
			return unfocuses;
		},
	};
}

test("opening and navigating a child tree keeps focus and root history unchanged", async () => {
	const f = fixture();
	await f.child.setNodeTopology({ id: "child", rootId: "root", generation: 0, state: "active" });
	const rootLeaf = f.root.getLeafId();
	await f.controller.showTreeSelector();
	const rendered = Bun.stripANSI(f.selector!.render(120).join("\n"));
	expect(rendered).toContain("child-only history");
	expect(rendered).not.toContain("root-only history");
	expect(f.unfocuses).toBe(0);
	f.selector!.handleInput!("\x1b[H");
	f.selector!.handleInput!("\r");
	await f.settled;
	expect(f.navigated).toEqual([f.first]);
	expect(f.child.getLeafId()).toBe(f.first);
	expect(f.root.getLeafId()).toBe(rootLeaf);
	expect(f.ctx.viewSession).toBe(f.childSession);
	expect(f.child.getNodeTopology()?.generation).toBe(1);
	expect(f.notices).toContain("Navigated to selected point");
});

test("a tree selection opened on A refuses navigation after focus moves to root", async () => {
	const f = fixture();
	await f.controller.showTreeSelector();
	Object.assign(f.ctx, { viewSession: f.ctx.session });
	f.selector!.handleInput!("\x1b[H");
	f.selector!.handleInput!("\r");
	await f.settled;
	expect(f.navigated).toEqual([]);
	expect(f.notices[0]).toContain("expired");
});

test("a summary prompt cannot navigate an old node after focus changes while awaiting the choice", async () => {
	const f = fixture();
	const promptOpened = Promise.withResolvers<void>();
	const choice = Promise.withResolvers<string>();
	vi.spyOn(f.ctx, "showHookSelector").mockImplementation(() => {
		promptOpened.resolve();
		return choice.promise;
	});
	await f.controller.showTreeSelector();
	f.selector!.handleInput!("\x1b[H");
	f.selector!.handleInput!("\r");
	await promptOpened.promise;
	Object.assign(f.ctx, { viewSession: f.ctx.session });
	choice.resolve("No summary");
	await f.settled;
	expect(f.navigated).toEqual([]);
	expect(f.notices[0]).toContain("expired");
});

test("a tree selection refuses a newer head on the same selected node", async () => {
	const f = fixture();
	await f.controller.showTreeSelector();
	f.child.appendMessage({ role: "user", content: "new turn", timestamp: 4 });
	const newerHead = f.child.getLeafId();
	f.selector!.handleInput!("\x1b[H");
	f.selector!.handleInput!("\r");
	await f.settled;
	expect(f.navigated).toEqual([]);
	expect(f.child.getLeafId()).toBe(newerHead);
});

test("a history generation change invalidates selection even if the head entry is unchanged", async () => {
	const f = fixture();
	await f.child.setNodeTopology({ id: "child", rootId: "root", generation: 0, state: "active" });
	await f.controller.showTreeSelector();
	await f.child.setNodeTopology({ id: "child", rootId: "root", generation: 1, state: "active" });
	f.selector!.handleInput!("\x1b[H");
	f.selector!.handleInput!("\r");
	await f.settled;
	expect(f.navigated).toEqual([]);
	expect(f.notices[0]).toContain("expired");
});

test("a bookmark editor opened on A cannot label root after focus changes", async () => {
	const f = fixture();
	const assistant = f.child.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Child answer" }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 4,
	});
	const edit = Promise.withResolvers<string>();
	vi.spyOn(f.ctx, "showHookEditor").mockImplementation(() => edit.promise);
	const pending = f.controller.annotateLastResponse();
	Object.assign(f.ctx, { viewSession: f.ctx.session });
	edit.resolve("late bookmark");
	await pending;
	expect(f.child.getLabel(assistant)).toBeUndefined();
	expect(f.root.getEntries().some(entry => entry.type === "label")).toBe(false);
	expect(f.notices[0]).toContain("expired");
});
