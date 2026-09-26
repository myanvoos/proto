import * as os from "node:os";
import * as path from "node:path";
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
	} else throw new Error(`Unknown probe mode: ${mode}`);
}
