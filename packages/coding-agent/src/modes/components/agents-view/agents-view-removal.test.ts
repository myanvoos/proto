import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AgentLifecycleManager } from "../../../registry/agent-lifecycle";
import { AgentRegistry, getAgentTombstonePath } from "../../../registry/agent-registry";
import { registerPersistedSubagents } from "../../../registry/persisted-agents";
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

describe("agents view persisted subagent seeding", () => {
	test("the global session list never registers other sessions' persisted subagents", async () => {
		const { parentInfo } = writeSessionTree();
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([parentInfo]);
		const view = mountView({ hideSubagents: true });
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
