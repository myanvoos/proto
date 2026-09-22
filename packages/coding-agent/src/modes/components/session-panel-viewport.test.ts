import { expect, test } from "bun:test";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { AgentRegistry } from "../../registry/agent-registry";
import type { SessionInfo } from "../../session/session-listing";
import { SessionObserverRegistry } from "../session-observer-registry";
import { initThemeSync } from "../theme/theme";
import { AgentFleetOverlayComponent } from "./agent-fleet";
import { AgentsViewComponent, type AgentsViewDeps } from "./agents-view/agents-view-mode";
import type { AgentsViewPersistentState } from "./agents-view/agents-view-state";

initThemeSync();
const plain = (lines: readonly string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const sizes = [4, 6, 10, 24];
const widths = [20, 32, 40, 60];

function sessions(): SessionInfo[] {
	return Array.from({ length: 12 }, (_, i) => ({
		path: `/tmp/proto-viewport-fixture/${i}.jsonl`,
		id: String(i),
		cwd: "/tmp/proto-viewport-fixture",
		created: new Date(i),
		modified: new Date(i),
		messageCount: 4,
		size: 128,
		title: `Session ${i}`,
		firstMessage: `Session ${i}`,
		allMessagesText: "fixture",
	}));
}

test("session focus, reply identity and draft survive small viewports and restored selection", async () => {
	const terminal = { rows: 24 };
	const persistentState: AgentsViewPersistentState = {};
	let actions = 0;
	const ready = Promise.withResolvers<void>();
	const deps: AgentsViewDeps = {
		ui: { terminal } as unknown as TUI,
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		initialSessions: sessions(),
		cwd: "/tmp/proto-viewport-fixture",
		version: "test",
		modelName: undefined,
		providerName: undefined,
		registry: new AgentRegistry(),
		persistentState,
		hideSubagents: true,
		requestRender: () => ready.resolve(),
		close: () => {},
		openSession: async () => {
			actions++;
			return false;
		},
		focusAgent: async () => {
			actions++;
		},
		newSession: () => {
			actions++;
		},
		renameCurrentSession: async () => {
			actions++;
		},
		deleteCurrentSession: async () => {
			actions++;
		},
		promptAfterResume: async () => {
			actions++;
		},
		showError: () => {},
		showStatus: () => {},
	};
	let view = new AgentsViewComponent(deps);
	try {
		await ready.promise;
		view.handleInput("\x1b[B");
		const selected = persistentState.selectedRowIdentity;
		expect(selected).toBeDefined();
		for (const width of widths)
			for (const rows of sizes) {
				terminal.rows = rows;
				const frame = view.render(width);
				expect(frame).toHaveLength(rows);
				expect(frame.every(line => visibleWidth(line) <= width)).toBe(true);
				expect(plain(frame)).toContain("Session 10");
				expect(persistentState.selectedRowIdentity).toBe(selected);
			}
		view.handleInput(" ");
		view.handleInput("UNSENT_DRAFT");
		for (const width of widths)
			for (const rows of sizes) {
				terminal.rows = rows;
				const frame = plain(view.render(width));
				expect(frame).toContain("Reply: Session 10");
				expect(frame).toContain("UNSENT_DRAFT");
			}
		view.handleInput("\x1b");
		expect(plain(view.render(40))).not.toContain("Reply:");
		expect(persistentState.selectedRowIdentity).toBe(selected);
		view.dispose();
		view = new AgentsViewComponent(deps);
		terminal.rows = 4;
		expect(plain(view.render(20))).toContain("Session 10");
		expect(persistentState.selectedRowIdentity).toBe(selected);
		expect(actions).toBe(0);
	} finally {
		view.dispose();
	}
});

test("fleet allocates its body before summary and maps visible rows after resize", async () => {
	const terminal = { rows: 24 };
	const registry = new AgentRegistry();
	const fleet = new AgentFleetOverlayComponent({
		ui: { terminal } as unknown as TUI,
		registry,
		observers: new SessionObserverRegistry(),
		fleetKeys: [],
		onDone: () => {},
		requestRender: () => {},
	});
	try {
		await fleet.persistedSubagentsReady;
		for (const width of widths)
			for (const rows of sizes) {
				terminal.rows = rows;
				const frame = fleet.render(width);
				expect(frame).toHaveLength(rows);
				expect(plain(frame)).toContain("No agents");
				for (let line = 0; line < frame.length; line++) expect(fleet.hitTest(line)).toBeUndefined();
			}
	} finally {
		fleet.dispose();
	}
	for (let i = 0; i < 12; i++)
		registry.register({
			id: `worker-${i}`,
			label: `worker-${i}`,
			kind: "sub",
			session: null,
			status: "idle",
			lastActivity: 1000 - i,
		});
	const populated = new AgentFleetOverlayComponent({
		ui: { terminal } as unknown as TUI,
		registry,
		observers: new SessionObserverRegistry(),
		fleetKeys: [],
		onDone: () => {},
		requestRender: () => {},
	});
	try {
		await populated.persistedSubagentsReady;
		for (let i = 0; i < 8; i++) populated.handleInput("j");
		for (const width of [...widths, 110])
			for (const rows of sizes) {
				terminal.rows = rows;
				const frame = populated.render(width);
				expect(frame).toHaveLength(rows);
				expect(frame.every(line => visibleWidth(line) <= width)).toBe(true);
				const selectedLine = frame.findIndex(
					(line, index) => populated.hitTest(index) === 8 && plain([line]).includes("worker-8"),
				);
				expect(selectedLine).toBeGreaterThanOrEqual(0);
				expect(populated.hitTest(selectedLine)).toBe(8);
				expect(populated.hitTest(0)).toBeUndefined();
				expect(populated.hitTest(rows - 1)).toBeUndefined();
			}
		terminal.rows = 4;
		populated.handleInput("k");
		expect(plain(populated.render(32))).toContain("worker-7");
		populated.handleInput("\t");
		expect(plain(populated.render(32))).toContain("worker-7");
		populated.handleInput("\x1b");
		expect(plain(populated.render(32))).toContain("worker-7");
	} finally {
		populated.dispose();
	}
});
