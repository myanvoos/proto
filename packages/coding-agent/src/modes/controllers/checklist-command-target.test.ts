import { afterEach, expect, test, vi } from "bun:test";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import type { ChecklistPhase } from "../../tools/checklist";
import * as externalEditor from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";
import { ChecklistCommandController } from "./checklist-command-controller";

afterEach(() => vi.restoreAllMocks());

function fixture() {
	const root = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	let phases: ChecklistPhase[] = [];
	const notices: string[] = [];
	const childSession = {
		sessionManager: child,
		getChecklistPhases: () => phases,
		setChecklistPhases: (next: ChecklistPhase[]) => {
			phases = next;
		},
		agent: { appendMessage: () => {} },
	} as unknown as AgentSession;
	const rootSession = { sessionManager: root } as AgentSession;
	const ctx = {
		session: rootSession,
		sessionManager: root,
		viewSession: childSession,
		setChecklist: () => {},
		showStatus: (message: string) => notices.push(message),
		showWarning: (message: string) => notices.push(message),
		showError: (message: string) => {
			throw new Error(message);
		},
		ui: { stop: () => {}, start: () => {}, requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		root,
		child,
		rootSession,
		notices,
		controller: new ChecklistCommandController(ctx),
		get phases() {
			return phases;
		},
	};
}

test("focused checklist edits persist and remind only the selected child", async () => {
	const f = fixture();
	await f.controller.handleChecklistCommand('append "verify child target"');
	expect(f.phases.flatMap(phase => phase.tasks).map(task => task.content)).toEqual(["Verify child target"]);
	expect(f.child.getEntries().map(entry => entry.type)).toEqual(["custom", "message"]);
	expect(f.root.getEntries()).toEqual([]);
});

test("a checklist editor completing after focus changes neither mutates nor announces success", async () => {
	const f = fixture();
	const edit = Promise.withResolvers<string>();
	vi.spyOn(externalEditor, "getEditorCommand").mockReturnValue("controlled-editor");
	vi.spyOn(externalEditor, "openInEditor").mockImplementation(() => edit.promise);
	const pending = f.controller.handleChecklistCommand("edit");
	Object.assign(f.ctx, { viewSession: f.rootSession });
	edit.resolve("# Work\n- [ ] late edit\n");
	await pending;
	expect(f.phases).toEqual([]);
	expect(f.child.getEntries()).toEqual([]);
	expect(f.root.getEntries()).toEqual([]);
	expect(f.notices).toEqual(["Selection expired: the session changed"]);
});
