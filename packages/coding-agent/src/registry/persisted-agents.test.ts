import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionLivePath } from "../session/session-liveness";
import { AgentRegistry } from "./agent-registry";
import { registerPersistedSubagents } from "./persisted-agents";

function makeSessionTree(): { dir: string; parentFile: string; childFile: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-persisted-"));
	const parentFile = path.join(dir, "sess_abc.jsonl");
	fs.writeFileSync(
		parentFile,
		`${JSON.stringify({ type: "session", id: "abc", cwd: dir, timestamp: new Date().toISOString() })}\n`,
		{ encoding: "utf8" },
	);
	const root = parentFile.slice(0, -".jsonl".length);
	fs.mkdirSync(root, { recursive: true });
	const childFile = path.join(root, "worker.jsonl");
	fs.writeFileSync(
		childFile,
		[
			JSON.stringify({ type: "session", id: "w1", cwd: dir, timestamp: new Date().toISOString() }),
			JSON.stringify({
				type: "session_init",
				timestamp: new Date().toISOString(),
				task: "do the thing",
				systemPrompt: "You are a worker.",
			}),
			"",
		].join("\n"),
		{ encoding: "utf8" },
	);
	return { dir, parentFile, childFile };
}

function writeLiveMarker(sessionFile: string, streaming: boolean, pid: number): void {
	fs.writeFileSync(getSessionLivePath(sessionFile), JSON.stringify({ pid, streaming, at: Date.now() }), {
		encoding: "utf8",
		mode: 0o600,
	});
}

describe("registerPersistedSubagents", () => {
	test("registers a finished persisted subagent as parked", async () => {
		const { parentFile } = makeSessionTree();
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		const ref = registry.get("worker");
		expect(ref?.status).toBe("parked");
		expect(ref?.sessionFile).toBeTruthy();
	});

	test("skips registration while the transcript is live in another process", async () => {
		const { parentFile, childFile } = makeSessionTree();
		writeLiveMarker(childFile, true, 999_999);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("worker")).toBeUndefined();
	});

	test("returns without touching the registry when no artifacts directory exists", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-persisted-"));
		const parentFile = path.join(dir, "plain.jsonl");
		fs.writeFileSync(
			parentFile,
			`${JSON.stringify({ type: "session", id: "p", cwd: dir, timestamp: new Date().toISOString() })}\n`,
			{ encoding: "utf8" },
		);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.list()).toHaveLength(0);
	});
});
