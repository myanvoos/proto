import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AgentLifecycleManager } from "../../../registry/agent-lifecycle";
import { AgentRegistry, getAgentTombstonePath } from "../../../registry/agent-registry";
import { registerPersistedSubagents } from "../../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import type { SessionInfo } from "../../../session/session-listing";
import { SessionManager } from "../../../session/session-manager";
import { initThemeSync } from "../../theme/theme";
import { AgentsViewComponent, type AgentsViewDeps } from "./agents-view-mode";

const ANSI = /\x1b\[[0-9;]*m/g;
const CTRL_X = "\x18";

let listAllSpy: { mockRestore(): void } | undefined;
const mounted: Array<{ dispose(): void }> = [];
const tempDirs: string[] = [];

beforeEach(() => {
	initThemeSync();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	for (const view of mounted.splice(0)) view.dispose();
	listAllSpy?.mockRestore();
	listAllSpy = undefined;
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function writeSessionTree(workerId = "worker"): { parentFile: string; childFile: string; parentInfo: SessionInfo } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-agents-view-"));
	tempDirs.push(dir);
	const parentFile = path.join(dir, "sess_parent.jsonl");
	const timestamp = new Date().toISOString();
	fs.writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: "parent", cwd: dir, timestamp })}\n`);
	const root = parentFile.slice(0, -".jsonl".length);
	fs.mkdirSync(root, { recursive: true });
	const childFile = path.join(root, `${workerId}.jsonl`);
	fs.writeFileSync(
		childFile,
		[
			JSON.stringify({ type: "session", id: `${workerId}-session`, cwd: dir, timestamp }),
			JSON.stringify({
				type: "session_init",
				timestamp,
				task: "audit the parser",
				systemPrompt: "You are a worker.",
			}),
			"",
		].join("\n"),
	);
	const parentInfo: SessionInfo = {
		path: parentFile,
		id: "parent",
		cwd: dir,
		created: new Date(timestamp),
		modified: new Date(timestamp),
		messageCount: 1,
		size: 128,
		firstMessage: "parent task",
		allMessagesText: "parent task",
	};
	return { parentFile, childFile, parentInfo };
}

function writeSessionTreeWithWorkers(workerIds: string[]): {
	parentFile: string;
	childFiles: string[];
	parentInfo: SessionInfo;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-agents-view-"));
	tempDirs.push(dir);
	const parentFile = path.join(dir, "sess_parent.jsonl");
	const timestamp = new Date().toISOString();
	fs.writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: "parent", cwd: dir, timestamp })}\n`);
	const root = parentFile.slice(0, -".jsonl".length);
	fs.mkdirSync(root, { recursive: true });
	const childFiles = workerIds.map(workerId => {
		const childFile = path.join(root, `${workerId}.jsonl`);
		fs.writeFileSync(
			childFile,
			[
				JSON.stringify({ type: "session", id: `${workerId}-session`, cwd: dir, timestamp }),
				JSON.stringify({
					type: "session_init",
					timestamp,
					task: `work on ${workerId}`,
					systemPrompt: "You are a worker.",
				}),
				"",
			].join("\n"),
		);
		return childFile;
	});
	const parentInfo: SessionInfo = {
		path: parentFile,
		id: "parent",
		cwd: dir,
		created: new Date(timestamp),
		modified: new Date(timestamp),
		messageCount: 1,
		size: 128,
		firstMessage: "parent task",
		allMessagesText: "parent task",
	};
	return { parentFile, childFiles, parentInfo };
}

function mountView(overrides: Partial<AgentsViewDeps>): AgentsViewComponent {
	const view = new AgentsViewComponent({
		ui: { terminal: { rows: 40 } } as unknown as TUI,
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		cwd: "/tmp/proto-agents-view",
		version: "test",
		modelName: undefined,
		providerName: undefined,
		requestRender: () => {},
		close: () => {},
		openSession: async () => true,
		focusAgent: async () => {},
		newSession: () => {},
		renameCurrentSession: async () => {},
		deleteCurrentSession: async () => {},
		promptAfterResume: async () => {},
		showError: () => {},
		showStatus: () => {},
		registry: AgentRegistry.global(),
		...overrides,
	});
	mounted.push(view);
	return view;
}

function renderPlain(view: AgentsViewComponent): string {
	return view.render(120).join("\n").replace(ANSI, "");
}

function sectionOf(output: string, rowText: string): string | undefined {
	let section: string | undefined;
	for (const line of output.split("\n")) {
		if (/^(Running|Idle|Current|Inactive)\s*$/.test(line)) section = line.trim();
		else if (line.includes(rowText)) return section;
	}
	return undefined;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe("agents view Ctrl+X", () => {
	test("stops a parked subagent into the inactive section, then deletes it from there", async () => {
		const { parentFile, childFile, parentInfo } = writeSessionTree();
		const registry = AgentRegistry.global();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("worker")?.status).toBe("parked");
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);

		const view = mountView({
			currentSessionFile: parentFile,
			initialScopeIdentity: `file:${path.resolve(parentFile)}`,
			initialScopeTitle: "parent",
		});
		// The row carries the transcript's session id once the nested listing has merged in.
		const row = "· worker-session";
		await waitFor(() => sectionOf(renderPlain(view), row) === "Idle", "the worker under Idle");
		expect(renderPlain(view)).toContain("parked ·");

		view.handleInput(CTRL_X);
		expect(renderPlain(view)).toContain("again to stop");
		view.handleInput(CTRL_X);
		await waitFor(() => registry.get("worker")?.status === "aborted", "the worker to be tombstoned");
		await waitFor(() => sectionOf(renderPlain(view), row) === "Inactive", "the worker under Inactive");
		expect(fs.existsSync(childFile)).toBe(true);
		expect(fs.existsSync(getAgentTombstonePath(childFile))).toBe(true);

		view.handleInput(CTRL_X);
		expect(renderPlain(view)).toContain("again to delete");
		view.handleInput(CTRL_X);
		await waitFor(() => !fs.existsSync(childFile), "the transcript to be deleted");
		expect(registry.get("worker")).toBeUndefined();
		await waitFor(() => !renderPlain(view).includes(row), "the worker row to disappear");
		expect(fs.existsSync(parentFile)).toBe(true);
	});
});

describe("agents view shift-range mass selection", () => {
	const SHIFT_DOWN = "\x1b[1;2B";
	const SHIFT_UP = "\x1b[1;2A";
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";
	const ESC = "\x1b";

	test("stopping a running worker cancels its turn through the orchestrator, not just the session", async () => {
		const { parentFile, childFile, parentInfo } = writeSessionTree();
		const registry = AgentRegistry.global();
		await registerPersistedSubagents(registry, parentFile);
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);

		// A worker mid-turn: the session abort alone left its orchestrator job running.
		const aborts: string[] = [];
		const ref = registry.get("worker")!;
		registry.attachSession(
			"worker",
			{
				abort: async (options?: { reason?: string }) => {
					aborts.push(options?.reason ?? "");
				},
				dispose: async () => {},
			} as never,
			childFile,
			ref,
		);
		registry.setStatus("worker", "running", ref);

		const stopped: string[] = [];
		const view = mountView({
			currentSessionFile: parentFile,
			initialScopeIdentity: `file:${path.resolve(parentFile)}`,
			initialScopeTitle: "parent",
			stopWorker: async id => {
				stopped.push(id);
				return true;
			},
		});
		await waitFor(() => renderPlain(view).includes("· worker-session"), "the worker row");

		view.handleInput(CTRL_X);
		expect(renderPlain(view)).toContain("again to stop");
		view.handleInput(CTRL_X);

		await waitFor(() => stopped.length > 0, "the orchestrator stop to run");
		expect(stopped).toEqual(["worker"]);
		// The cancelled worker's session is still torn down, so its live marker cannot keep the
		// row in the running section.
		expect(aborts).toEqual([USER_INTERRUPT_LABEL]);
		await waitFor(() => fs.existsSync(getAgentTombstonePath(childFile)), "the worker to be tombstoned");
		expect(fs.existsSync(childFile)).toBe(true);
		await waitFor(() => sectionOf(renderPlain(view), "· worker-session") === "Inactive", "the stopped row to move");
	});

	test("a worker the orchestrator does not own still falls back to aborting its session", async () => {
		const { parentFile, childFile, parentInfo } = writeSessionTree();
		const registry = AgentRegistry.global();
		await registerPersistedSubagents(registry, parentFile);
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);

		const aborts: string[] = [];
		const ref = registry.get("worker")!;
		registry.attachSession(
			"worker",
			{
				abort: async (options?: { reason?: string }) => {
					aborts.push(options?.reason ?? "");
				},
				dispose: async () => {},
			} as never,
			childFile,
			ref,
		);
		registry.setStatus("worker", "running", ref);

		const view = mountView({
			currentSessionFile: parentFile,
			initialScopeIdentity: `file:${path.resolve(parentFile)}`,
			initialScopeTitle: "parent",
			stopWorker: async () => false,
		});
		await waitFor(() => renderPlain(view).includes("· worker-session"), "the worker row");

		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);

		await waitFor(() => aborts.length > 0, "the session abort fallback");
		await waitFor(() => registry.get("worker")?.status === "aborted", "the worker to be tombstoned");
		expect(fs.existsSync(getAgentTombstonePath(childFile))).toBe(true);
	});

	test("shift+down marks a range and ctrl+x twice stops every marked agent, then deletes them", async () => {
		const { parentFile, childFiles, parentInfo } = writeSessionTreeWithWorkers(["worker-a", "worker-b"]);
		const registry = AgentRegistry.global();
		await registerPersistedSubagents(registry, parentFile);
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);

		let closed = false;
		const view = mountView({
			currentSessionFile: parentFile,
			initialScopeIdentity: `file:${path.resolve(parentFile)}`,
			initialScopeTitle: "parent",
			close: () => {
				closed = true;
			},
		});
		await waitFor(
			() => renderPlain(view).includes("worker-a") && renderPlain(view).includes("worker-b"),
			"both worker rows",
		);

		// Extend the range until it spans both workers; the hint announces the count.
		for (let pressed = 0; pressed < 6 && !renderPlain(view).includes("remove 2"); pressed++) {
			view.handleInput(SHIFT_DOWN);
		}
		expect(renderPlain(view)).toContain("remove 2");
		const marked = renderPlain(view);
		expect(marked).toContain("2 selected");
		// the cursor row keeps its cursor glyph; the other range row carries the checkbox
		expect(marked.match(/■/g)?.length).toBe(1);

		// Esc drops the range without closing the view
		view.handleInput(ESC);
		expect(renderPlain(view)).not.toContain("2 selected");
		expect(renderPlain(view).match(/■/g)).toBeNull();
		expect(closed).toBe(false);
		expect(renderPlain(view)).toContain("worker-a");
		// re-mark from the top so the cursor ends on the bottom worker again
		for (let pressed = 0; pressed < 6; pressed++) view.handleInput(UP);
		for (let pressed = 0; pressed < 6 && !renderPlain(view).includes("remove 2"); pressed++) {
			view.handleInput(SHIFT_DOWN);
		}
		expect(renderPlain(view)).toContain("remove 2");

		view.handleInput(CTRL_X);
		expect(renderPlain(view)).toContain("again to remove 2 sessions");
		view.handleInput(CTRL_X);
		await waitFor(
			() => registry.get("worker-a")?.status === "aborted" && registry.get("worker-b")?.status === "aborted",
			"both workers to be tombstoned",
		);
		await waitFor(
			() =>
				sectionOf(renderPlain(view), "worker-a") === "Inactive" &&
				sectionOf(renderPlain(view), "worker-b") === "Inactive",
			"both workers under Inactive",
		);
		expect(fs.existsSync(childFiles[0]!)).toBe(true);
		expect(fs.existsSync(childFiles[1]!)).toBe(true);
		// Registry rows move before the asynchronous batch finishes clearing selection.
		await waitFor(() => renderPlain(view).includes("Removed 2"), "the batch stop to finish");
		// executing the mass operation collapses the range
		expect(renderPlain(view)).not.toContain("remove 2");

		// Moving into Inactive can reorder rows by updated time; select the bottom explicitly.
		for (let pressed = 0; pressed < 6; pressed++) view.handleInput(DOWN);

		// the "Removed 2" status message temporarily replaces the hints line, so assert
		// on the row checkboxes rather than the hints while it is visible.
		view.handleInput(SHIFT_UP);
		expect(renderPlain(view).match(/■/g)?.length).toBe(1);
		view.handleInput(DOWN);
		expect(renderPlain(view).match(/■/g)).toBeNull();

		// the tombstoned rows can now be mass-deleted from the inactive section
		view.handleInput(SHIFT_UP);
		expect(renderPlain(view).match(/■/g)?.length).toBe(1);
		view.handleInput(CTRL_X);
		expect(renderPlain(view)).toContain("again to remove 2 sessions");
		view.handleInput(CTRL_X);
		await waitFor(
			() => !fs.existsSync(childFiles[0]!) && !fs.existsSync(childFiles[1]!),
			"both transcripts to be deleted",
		);
		await waitFor(
			() => !renderPlain(view).includes("worker-a") && !renderPlain(view).includes("worker-b"),
			"the worker rows to disappear",
		);
		expect(fs.existsSync(parentFile)).toBe(true);
	});
});

describe("agents view persisted subagent seeding", () => {
	test("the global session list never registers other sessions' persisted subagents", async () => {
		const { parentInfo } = writeSessionTree();
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);
		const view = mountView({ cwd: parentInfo.cwd, hideSubagents: true });
		await waitFor(() => renderPlain(view).includes("parent task"), "the parent session row");
		await Bun.sleep(50);
		expect(AgentRegistry.global().list()).toEqual([]);
	});

	test("a scoped view registers only transcripts under its scope root", async () => {
		const scoped = writeSessionTree("scoped-worker");
		const other = writeSessionTree("other-worker");
		const registry = AgentRegistry.global();
		// Mirrors the selector: the scope root is registered before the view mounts.
		await registerPersistedSubagents(registry, scoped.parentFile);
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([scoped.parentInfo, other.parentInfo]);
		const view = mountView({
			currentSessionFile: scoped.parentFile,
			initialScopeIdentity: `file:${path.resolve(scoped.parentFile)}`,
			initialScopeTitle: "parent",
		});
		await waitFor(() => renderPlain(view).includes("scoped-worker"), "the scoped worker row");
		await Bun.sleep(50);
		expect(registry.list().map(ref => ref.sessionFile)).toEqual([scoped.childFile]);
	});
});
