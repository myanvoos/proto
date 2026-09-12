import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionLivePath } from "../session/session-liveness";
import { AgentRegistry, getAgentTombstonePath } from "./agent-registry";
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
	test.each([".jsonl", "..jsonl", "...jsonl"])(
		"ignores the non-descendant transcript stem in %s without looping or leaving the artifact tree",
		async filename => {
			const { dir, parentFile, childFile } = makeSessionTree();
			try {
				const transcript = await Bun.file(childFile).text();
				await Bun.write(path.join(path.dirname(childFile), filename), transcript);
				await Bun.write(path.join(dir, "outside.jsonl"), transcript);
				const registry = new AgentRegistry();
				// Interrupt the old recursive path deterministically without touching any directory outside this fixture.
				let remainingChecks = 256;
				await registerPersistedSubagents(registry, parentFile, {
					shouldContinue: () => --remainingChecks > 0,
				});
				expect(remainingChecks).toBeGreaterThan(0);
				expect(registry.list().map(ref => ref.id)).toEqual(["worker"]);
			} finally {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		},
	);
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
		writeLiveMarker(childFile, true, process.pid);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("worker")).toBeUndefined();
	});

	test("retains a tombstoned child as aborted rather than a revivable parked worker", async () => {
		const { dir, parentFile, childFile } = makeSessionTree();
		try {
			await Bun.write(getAgentTombstonePath(childFile), "");
			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, parentFile);
			expect(registry.get("worker")).toMatchObject({
				status: "aborted",
				session: null,
				sessionFile: childFile,
			});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
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
	test("preserves orchestration labels for nested cold transcripts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-persisted-labels-"));
		const parentFile = path.join(dir, "sess.jsonl");
		const root = parentFile.slice(0, -".jsonl".length);
		const parentWorkerFile = path.join(root, "worker-parent.jsonl");
		const nestedRoot = parentWorkerFile.slice(0, -".jsonl".length);
		const nestedWorkerFile = path.join(nestedRoot, "worker-child.jsonl");
		const now = new Date().toISOString();
		const parentSpawn = {
			type: "custom",
			customType: "orchestrator-worker-lifecycle",
			data: {
				version: 1,
				id: "worker-parent",
				ownerId: "Main",
				parentSessionId: "parent",
				action: "spawn",
				agent: "worker",
				label: "Parent Label",
				childSessionFile: "worker-parent.jsonl",
				createdAt: Date.now(),
			},
		};
		const nestedSpawn = {
			type: "custom",
			customType: "orchestrator-worker-lifecycle",
			data: {
				version: 1,
				id: "worker-child",
				ownerId: "Main",
				parentSessionId: "worker-parent-session",
				action: "spawn",
				agent: "worker",
				label: "Nested Label",
				childSessionFile: "worker-child.jsonl",
				createdAt: Date.now(),
			},
		};
		const writeTranscript = (file: string, id: string, entries: unknown[]): void => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				[
					JSON.stringify({ type: "session", id, cwd: dir, timestamp: now }),
					JSON.stringify({
						type: "session_init",
						timestamp: now,
						task: `${id} task`,
						systemPrompt: "You are a worker.",
					}),
					...entries.map(entry => JSON.stringify(entry)),
					JSON.stringify({ type: "message", message: { role: "user", content: `${id} prompt` } }),
					"",
				].join("\n"),
				{ encoding: "utf8" },
			);
		};
		fs.writeFileSync(
			parentFile,
			[
				JSON.stringify({ type: "session", id: "parent", cwd: dir, timestamp: now }),
				JSON.stringify(parentSpawn),
				"",
			].join("\n"),
			{ encoding: "utf8" },
		);
		writeTranscript(parentWorkerFile, "worker-parent-session", [nestedSpawn]);
		writeTranscript(nestedWorkerFile, "worker-child-session", []);

		const registry = new AgentRegistry();
		registry.register({
			id: "worker-parent",
			displayName: "worker-parent",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: parentWorkerFile,
			status: "parked",
		});

		await registerPersistedSubagents(registry, parentFile);

		expect(registry.get("worker-parent")?.displayName).toBe("Parent Label");
		expect(registry.get("worker-child")?.displayName).toBe("Nested Label");
		expect(registry.get("worker-child")?.parentId).toBe("worker-parent");
	});
});
