import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { BlobStore } from "../../src/session/blob-store";
import type { FileEntry, SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { prepareEntryForPersistence } from "../../src/session/session-persistence";

async function collect(): Promise<number> {
	// JSC external allocation accounting settles on platform turns after real GC; fake clocks cannot drive it.
	for (let index = 0; index < 8; index++) {
		await Bun.sleep(10);
		Bun.gc(true);
	}
	return process.memoryUsage().heapUsed;
}

if (import.meta.main) {
	const mode = process.argv.at(-1);
	if (mode === "persistence") {
		const baseline = await collect();
		const store = new BlobStore(path.join(os.tmpdir(), "unused-history-probe-blobs"));
		const entries: FileEntry[] = [];
		for (let index = 0; index < 16; index++) {
			entries.push(
				prepareEntryForPersistence(
					{
						type: "message",
						id: String(index),
						parentId: null,
						timestamp: new Date(index).toISOString(),
						message: {
							role: "user",
							content: Buffer.alloc(4 * 1024 * 1024, 65 + index).toString(),
							timestamp: index,
						},
					},
					store,
				),
			);
		}
		const retainedBytes = Math.max(0, (await collect()) - baseline);
		const retainedChars = entries.reduce(
			(count, entry) =>
				count +
				(entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
					? entry.message.content.length
					: 0),
			0,
		);
		await Bun.write(Bun.stdout, JSON.stringify({ retainedBytes, retainedChars }));
	} else if (mode === "history") {
		const manager = SessionManager.inMemory();
		try {
			const references: WeakRef<SessionEntry>[] = [];
			let firstId = "";
			for (let index = 0; index < 100; index++) {
				const id = manager.appendMessage({
					role: "user",
					content: Buffer.alloc(256 * 1024, 65 + (index % 26)).toString(),
					timestamp: index,
				});
				if (index === 0) firstId = id;
				if (index < 20) references.push(new WeakRef(manager.getEntry(id)!));
			}
			const kept = manager.appendMessage({ role: "user", content: "active tail", timestamp: 100 });
			manager.appendCompaction("active summary", undefined, kept, 100000);
			const context = manager.buildSessionContext();
			await collect();
			const survivors = references.filter(reference => reference.deref() !== undefined).length;
			const first = manager.getEntry(firstId);
			let exportedCharacters = 0;
			for (const entry of manager.iterateBranch()) {
				if (entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string")
					exportedCharacters += entry.message.content.length;
			}
			await Bun.write(
				Bun.stdout,
				JSON.stringify({
					survivors,
					contextMessages: context.messages.length,
					firstLength:
						first?.type === "message" && first.message.role === "user" ? first.message.content.length : 0,
					exportedCharacters,
				}),
			);
		} finally {
			await manager.close();
		}
	} else if (mode === "runtime-release") {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-parked-history-"));
		const file = path.join(root, "owner.jsonl");
		const manager = await SessionManager.open(file, undefined, undefined, {
			initialCwd: root,
			suppressBreadcrumb: true,
		});
		const auth = await AuthStorage.create(":memory:");
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		assert(model);
		const createRuntime = () =>
			new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
			});
		try {
			const runtime = createRuntime();
			registry.retainJournal(file, manager);
			const ref = registry.register({
				id: manager.getSessionId(),
				label: "owner",
				kind: "sub",
				session: runtime,
				sessionFile: file,
				status: "idle",
			});
			lifecycle.adopt(ref.id, { idleTtlMs: 0, revive: async () => createRuntime() });
			const ids: string[] = [];
			const references: WeakRef<SessionEntry>[] = [];
			for (let index = 0; index < 8; index++) {
				const id = manager.appendMessage({
					role: "user",
					content: String(index).repeat(256 * 1024),
					timestamp: index,
				});
				ids.push(id);
				references.push(new WeakRef(manager.getEntry(id)!));
			}
			const image = Buffer.alloc(4096, 137).toString("base64");
			const imageId = manager.appendMessage({
				role: "user",
				content: [{ type: "image", data: image, mimeType: "image/png" }],
				timestamp: 8,
			});
			const callerSnapshot = manager.getEntry(imageId)!;
			const callerSnapshotBeforePark = JSON.stringify(callerSnapshot);
			manager.appendCustomMessageEntry(
				"rewind-report",
				"Rewound.",
				false,
				{
					report: "restored checkpoint",
					startedAt: "2026-09-27T00:00:00.000Z",
					rewoundAt: "2026-09-27T00:05:00.000Z",
				},
				"agent",
			);
			await manager.ensureOnDisk();
			await manager.flush();
			const expected = JSON.stringify(manager.getEntries());
			const leaf = manager.getLeafId()!;
			await collect();
			const retainedBeforePark = references.filter(reference => reference.deref() !== undefined).length;
			await lifecycle.park(ref.id);
			assert.equal(ref.status, "parked");
			assert.equal(ref.session, null);
			assert.equal(registry.getJournal(file), manager);
			assert.equal(manager.isReleased, false);
			await collect();
			const survivors = references.filter(reference => reference.deref() !== undefined).length;
			assert.equal(
				JSON.stringify(callerSnapshot),
				callerSnapshotBeforePark,
				"park must not mutate caller-owned snapshots",
			);
			assert.equal(JSON.stringify(manager.getEntries()), expected, "park must preserve full payloads and blobs");

			// A descendant completion retains this owner journal after the runtime has detached.
			const completion = manager.appendCustomEntry("descendant-completed", { result: "late completion" });
			await manager.flush();
			const revived = await lifecycle.ensureLive(ref.id);
			assert.equal(revived.sessionManager, manager);
			assert.equal(revived.getLastCompletedRewind()?.report, "restored checkpoint");
			manager.branch(ids[2]!);
			assert.deepEqual(
				manager
					.buildSessionContext()
					.messages.map(message => (message.role === "user" ? message.content : message.role)),
				ids.slice(0, 3).map((_, index) => String(index).repeat(256 * 1024)),
			);
			manager.branch(completion);
			assert.equal(manager.getEntry(completion)?.parentId, leaf);
			await manager.flush();
			await lifecycle.terminateSubtree(ref.id);
			assert.equal(manager.isReleased, true);
			assert.deepEqual(manager.getEntries(), []);
			const reopened = await SessionManager.openReadOnly(file);
			try {
				assert.deepEqual(
					reopened.getEntries().filter(entry => entry.id !== completion),
					JSON.parse(expected),
				);
				assert.deepEqual(
					reopened.getCustomEntries("descendant-completed").map(entry => entry.data),
					[{ result: "late completion" }],
				);
			} finally {
				await reopened.close();
			}
			await Bun.write(Bun.stdout, JSON.stringify({ retainedBeforePark, survivors }));
		} finally {
			await lifecycle.dispose();
			await manager.close();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	} else throw new Error(`Unknown probe mode: ${mode}`);
}
