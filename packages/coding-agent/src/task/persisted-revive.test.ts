import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { AgentRef } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { createPersistedSubagentReviverFactory } from "./persisted-revive";

// Reviving a parked subagent used to mint a fresh session over a vanished transcript, or replay a truncated one as
// the agent's memory; either way a zero-history agent answered peers under the original run's identity.
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-revive-"));
	tempDirs.push(dir);
	return dir;
}

async function createPersistedSession(cwd: string): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({ systemPrompt: "persisted prompt", task: "persisted task", tools: ["read", "yield"] });
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}

function createRef(sessionFile: string): AgentRef {
	return {
		id: "ParkedScout",
		label: "Parked Scout",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

async function createReviver(cwd: string, ref: AgentRef) {
	const parentSession = {
		sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
		sessionFile: path.join(cwd, "parent.jsonl"),
	} as unknown as AgentSession;
	const reviver = await createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: {} as never,
		settings: Settings.isolated(),
	})(ref);
	if (!reviver) throw new Error("Expected a persisted reviver");
	return reviver;
}

async function linesOfType(sessionFile: string, keep: (type: string | undefined) => boolean): Promise<string> {
	const lines = (await Bun.file(sessionFile).text())
		.split("\n")
		.filter(line => line.trim().length > 0 && keep((JSON.parse(line) as { type?: string }).type));
	return `${lines.join("\n")}\n`;
}

describe("SessionManager.open with throwIfMissing", () => {
	it("rejects a missing file without creating it", async () => {
		const missing = path.join(await makeTempDir(), "missing.jsonl");

		await expect(SessionManager.open(missing, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/ENOENT/,
		);
		expect(await Bun.file(missing).exists()).toBe(false);
	});

	it("still mints at a missing path when the flag is omitted", async () => {
		const root = await makeTempDir();
		const fresh = path.join(root, "fresh.jsonl");

		const manager = await SessionManager.open(fresh, undefined, undefined, { initialCwd: root });
		expect(manager.getSessionFile()).toBe(path.resolve(fresh));
		expect(await Bun.file(fresh).exists()).toBe(true);
		await manager.close();
	});

	it("rejects an existing empty file instead of rewriting it", async () => {
		const empty = path.join(await makeTempDir(), "empty.jsonl");
		await Bun.write(empty, "");

		await expect(SessionManager.open(empty, undefined, undefined, { throwIfMissing: true })).rejects.toThrow(
			/holds no entries/,
		);
		expect(await Bun.file(empty).text()).toBe("");
	});
});

describe("persisted subagent revival fails closed", () => {
	it("refuses a transcript that vanished after the peek", async () => {
		const cwd = await makeTempDir();
		const sessionFile = await createPersistedSession(cwd);
		const ref = createRef(sessionFile);
		const reviver = await createReviver(cwd, ref);
		await fs.rm(sessionFile);

		await expect(reviver(ref)).rejects.toThrow(/ENOENT/);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("refuses a transcript deleted between open's snapshot read and its adoption", async () => {
		const cwd = await makeTempDir();
		const sessionFile = await createPersistedSession(cwd);
		const ref = createRef(sessionFile);
		const reviver = await createReviver(cwd, ref);
		const originalReadText = FileSessionStorage.prototype.readText;
		vi.spyOn(FileSessionStorage.prototype, "readText").mockImplementationOnce(async function (
			this: FileSessionStorage,
			filePath: string,
		) {
			const text = await originalReadText.call(this, filePath);
			await fs.rm(filePath);
			return text;
		});

		await expect(reviver(ref)).rejects.toThrow(/ENOENT/);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("refuses a transcript truncated to header and session_init without rewriting it", async () => {
		const cwd = await makeTempDir();
		const sessionFile = await createPersistedSession(cwd);
		const truncated = await linesOfType(sessionFile, type => type === "session" || type === "session_init");
		await Bun.write(sessionFile, truncated);
		const ref = createRef(sessionFile);
		const reviver = await createReviver(cwd, ref);

		await expect(reviver(ref)).rejects.toThrow(/no message history/);
		expect(await Bun.file(sessionFile).text()).toBe(truncated);
	});

	it("rebuilds the contract from the reopened file, not the stale peek", async () => {
		const cwd = await makeTempDir();
		const sessionFile = await createPersistedSession(cwd);
		const ref = createRef(sessionFile);
		const reviver = await createReviver(cwd, ref);
		const withoutInit = await linesOfType(sessionFile, type => type !== "session_init");
		await Bun.write(sessionFile, withoutInit);

		await expect(reviver(ref)).rejects.toThrow(/no persisted session contract/);
		expect(await Bun.file(sessionFile).text()).toBe(withoutInit);
	});
});
