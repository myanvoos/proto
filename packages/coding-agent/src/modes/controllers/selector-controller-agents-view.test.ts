import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { SessionManager } from "../../session/session-manager";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

/**
 * `/agents` and the double-tap right gesture ask for the current session's agents.
 * With `--no-session` there is no file to scope to; the view used to answer with a
 * bare error toast per keypress, which said neither why nor what to do instead.
 */
test("the current-session agents view falls back to the fleet when the session is in memory", async () => {
	initThemeSync();
	const errors: string[] = [];
	const statuses: string[] = [];
	let fleetOpened = 0;
	const ctx = {
		sessionManager: { getSessionFile: () => undefined },
		showError: (message: string) => {
			errors.push(message);
		},
		showStatus: (message: string) => {
			statuses.push(message);
		},
		showAgentFleet: () => {
			fleetOpened++;
		},
		ui: {
			showOverlay: () => {
				throw new Error("the agents view must not open without a session file");
			},
			requestRender: () => {},
		},
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	await controller.showAgentsView("current");
	await controller.showAgentsView("current");

	// Repeated presses reopen the fleet with its in-memory empty state, never an error.
	expect(fleetOpened).toBe(2);
	expect(errors).toEqual([]);
	expect(statuses).toEqual([]);
});

/**
 * Viewing a side agent, `/agents` and double-tap → must list that agent's own subagents. Rooting at the
 * main transcript instead buried them one level down and showed the main session's workers first.
 */
test("the current-session agents view roots at the focused agent's own subagents", async () => {
	initThemeSync();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-view-focus-"));
	try {
		const mainFile = path.join(dir, "main.jsonl");
		const sideFile = path.join(dir, "main", "Side-1.jsonl");
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, label: "main", kind: "main", session: null, sessionFile: mainFile });
		registry.register({
			id: "Side-1",
			label: "/side --agent fix the parser",
			kind: "side",
			parentId: MAIN_AGENT_ID,
			status: "idle",
			session: null,
			sessionFile: sideFile,
		});
		registry.register({
			id: "Side-1-worker",
			label: "parser worker",
			kind: "sub",
			parentId: "Side-1",
			status: "running",
			session: null,
			sessionFile: path.join(dir, "main", "Side-1", "worker.jsonl"),
		});
		registry.register({
			id: "Main-worker",
			label: "main worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			status: "running",
			session: null,
			sessionFile: path.join(dir, "main", "Main-worker.jsonl"),
		});

		const statuses: string[] = [];
		const overlays: Component[] = [];
		const ctx = {
			focusedAgentId: "Side-1",
			sessionManager: { getSessionFile: () => mainFile, getCwd: () => dir },
			session: { model: undefined, extensionRunner: undefined },
			keybindings: KeybindingsManager.inMemory(),
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => {
				throw new Error(message);
			},
			ui: {
				showOverlay: (component: Component) => {
					overlays.push(component);
					return { hide: () => {} };
				},
				setFocus: () => {},
				requestRender: () => {},
			},
		} as unknown as InteractiveModeContext & { focusedAgentId: string };
		const controller = new SelectorController(ctx);

		await controller.showAgentsView("current");
		const view = overlays[0] as Component & { dispose(): void };
		try {
			const scopeRow = view
				.render(120)
				.map(line => Bun.stripANSI(line))
				.find(line => line.trim().startsWith("scope"));
			expect(scopeRow).toContain("fix the parser");
		} finally {
			view.dispose();
		}

		// A focused leaf has nothing below it; the view must not fall back to the main session's workers.
		ctx.focusedAgentId = "Main-worker";
		await controller.showAgentsView("current");
		expect(overlays).toHaveLength(1);
		expect(statuses).toEqual(["No subagents in this session"]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
