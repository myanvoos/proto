import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistNodeTopologyReceipt, validateNodeTopology } from "../session/node-topology";
import type { SessionNodeTopology } from "../session/session-entries";
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

describe("durable ownership", () => {
	test("explicit node identity survives a noncanonical history filename", async () => {
		const { dir, parentFile, childFile } = makeSessionTree();
		try {
			await registerPersistedSubagents(new AgentRegistry(), parentFile);
			const renamed = path.join(path.dirname(childFile), "relocated-history.jsonl");
			await fs.promises.rename(childFile, renamed);
			await fs.promises.rename(`${childFile}.node.json`, `${renamed}.node.json`);
			const rebuilt = new AgentRegistry();
			await registerPersistedSubagents(rebuilt, parentFile);
			expect(rebuilt.getNode("worker", "abc")?.sessionFile).toBe(renamed);
			expect(rebuilt.get("relocated-history")).toBeUndefined();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("depth-three legacy workers retain IDs, parent edges and history paths after rebuilding the registry", async () => {
		const { dir, parentFile, childFile } = makeSessionTree();
		try {
			const grandchildFile = path.join(childFile.slice(0, -6), "grandchild.jsonl");
			const greatGrandchildFile = path.join(grandchildFile.slice(0, -6), "great-grandchild.jsonl");
			await Bun.write(grandchildFile, await Bun.file(childFile).text());
			await Bun.write(greatGrandchildFile, await Bun.file(childFile).text());
			const initial = new AgentRegistry();
			await registerPersistedSubagents(initial, parentFile);
			const restarted = new AgentRegistry();
			await registerPersistedSubagents(restarted, parentFile);
			expect(restarted.getNode("great-grandchild", "abc")).toMatchObject({
				parentId: "grandchild",
				status: "parked",
				sessionFile: greatGrandchildFile,
			});
			expect(restarted.getNode("grandchild", "abc")).toMatchObject({
				parentId: "worker",
				sessionFile: grandchildFile,
			});
			expect(restarted.getNode("worker", "abc")?.sessionFile).toBe(childFile);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("copied historical child payloads are not adopted into an independent fork", async () => {
		const { dir, parentFile, childFile } = makeSessionTree();
		try {
			await registerPersistedSubagents(new AgentRegistry(), parentFile);
			const forkFile = path.join(dir, "fork.jsonl");
			const copiedChild = path.join(forkFile.slice(0, -6), "worker.jsonl");
			await Bun.write(forkFile, await Bun.file(parentFile).text());
			await Bun.write(copiedChild, await Bun.file(childFile).text());
			await Bun.write(`${copiedChild}.node.json`, await Bun.file(`${childFile}.node.json`).text());
			await persistNodeTopologyReceipt(forkFile, {
				id: "fork",
				rootId: "fork",
				rootSessionFile: forkFile,
				generation: 0,
				state: "active",
			});
			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, forkFile);
			expect(registry.get("worker")).toBeUndefined();
			expect(await Bun.file(childFile).exists()).toBe(true);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("invalid durable ownership fails closed for cycles, missing parents, duplicate IDs and stopped ancestors", () => {
		const root: SessionNodeTopology = { id: "root", rootId: "root", generation: 0, state: "active" };
		const child: SessionNodeTopology = {
			id: "child",
			parentId: "root",
			rootId: "root",
			generation: 0,
			state: "active",
		};
		expect(() => validateNodeTopology([{ ...root, parentId: "child" }, child])).toThrow("Cycle");
		expect(() => validateNodeTopology([child])).toThrow("Missing node parent");
		expect(() => validateNodeTopology([root, child, { ...child }])).toThrow("Duplicate node identity");
		expect(() => validateNodeTopology([{ ...root, state: "stopped" }, child])).toThrow("Live descendant of stopped");
	});
});

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

	test("restores a persisted side agent under the side kind so it stays exempt from idle parking", async () => {
		const { parentFile, childFile } = makeSessionTree();
		const transcript = await Bun.file(childFile).text();
		await Bun.write(path.join(path.dirname(childFile), "Side-1789.jsonl"), transcript);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("Side-1789")?.kind).toBe("side");
		expect(registry.get("worker")?.kind).toBe("sub");
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
			label: "worker-parent",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: parentWorkerFile,
			status: "parked",
		});

		await registerPersistedSubagents(registry, parentFile);

		expect(registry.get("worker-parent")?.label).toBe("Parent Label");
		expect(registry.get("worker-child")?.label).toBe("Nested Label");
		expect(registry.get("worker-child")?.parentId).toBe("worker-parent");
	});
});

test("parked history retains direct spend from superseded branches and compaction usage records", async () => {
	const { dir, parentFile, childFile } = makeSessionTree();
	const original = await Bun.file(childFile).text();
	const assistant = (id: string, parentId: string | null, cost: number) => ({
		type: "message",
		id,
		parentId,
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			timestamp: 1,
			content: [{ type: "text", text: id }],
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: cost } },
		},
	});
	await Bun.write(
		childFile,
		original +
			[
				assistant("old-branch", null, 2),
				{ type: "model_usage", id: "compacted", parentId: null, usage: { cost: { total: 3 } } },
				assistant("current", null, 5),
			]
				.map(row => JSON.stringify(row))
				.join("\n") +
			"\n",
	);
	try {
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("worker")?.history?.directCost).toBe(10);
		expect(registry.get("worker")?.history?.metrics?.cost).toBe(5);
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});
