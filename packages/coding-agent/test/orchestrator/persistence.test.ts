import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { type OrchestratorParent, OrchestratorRuntime } from "../../src/orchestrator/runtime";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";

const WORKER_ID = "PersistedWorker";
const CUSTOM_TYPE = "orchestrator-worker-lifecycle";

function childSessionJsonl(cwd: string): string {
	const timestamp = new Date().toISOString();
	return [
		JSON.stringify({ type: "session", version: 3, id: WORKER_ID, timestamp, cwd }),
		JSON.stringify({
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp,
			systemPrompt: "system",
			task: "work",
			tools: ["read"],
		}),
	].join("\n");
}

function parentFor(manager: SessionManager, cwd: string): OrchestratorParent {
	return {
		cwd,
		getAgentId: () => "Main",
		getSessionId: () => manager.getSessionId(),
		getSessionFile: () => manager.getSessionFile() ?? null,
		sessionManager: manager,
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	OrchestratorRuntime.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("orchestrator worker persistence", () => {
	it("revives a settled worker and preserves a later tombstone", async () => {
		using tempDir = TempDir.createSync("@omp-orchestrator-persistence-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, tempDir.path());
		await manager.ensureOnDisk();
		const parentSessionFile = manager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected parent session file");
		const parentSessionId = manager.getSessionId();
		const childSessionFile = path.join(parentSessionFile.slice(0, -6), `${WORKER_ID}.jsonl`);
		await Bun.write(childSessionFile, childSessionJsonl(cwd));
		const base = { version: 1, id: WORKER_ID, ownerId: "Main", parentSessionId } as const;
		manager.appendCustomEntry(CUSTOM_TYPE, {
			...base,
			action: "spawn",
			agent: "worker",
			childSessionFile: `${WORKER_ID}.jsonl`,
			createdAt: Date.now(),
		});
		manager.appendCustomEntry(CUSTOM_TYPE, { ...base, action: "turn-started", turn: 1 });
		manager.appendCustomEntry(CUSTOM_TYPE, { ...base, action: "turn-settled", turn: 1 });
		await manager.flush();

		const parent = parentFor(manager, cwd);
		const runtime = OrchestratorRuntime.global();
		expect(await runtime.rehydrate(parent)).toBe(1);
		expect(runtime.listIds(parent as ToolSession)).toEqual([WORKER_ID]);
		expect(AgentRegistry.global().get(WORKER_ID)).toMatchObject({
			status: "parked",
			parentId: "Main",
			sessionFile: childSessionFile,
		});

		manager.appendCustomEntry(CUSTOM_TYPE, { ...base, action: "tombstone", reason: "explicit-kill" });
		await manager.flush();
		OrchestratorRuntime.resetGlobalForTests();
		expect(await OrchestratorRuntime.global().rehydrate(parent)).toBe(0);
		expect(OrchestratorRuntime.global().listIds(parent as ToolSession)).toEqual([]);
		expect(AgentRegistry.global().get(WORKER_ID)).toMatchObject({ status: "aborted", session: null });
		await manager.close();
	});
});
