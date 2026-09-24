import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

const managers: SessionManager[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function spillStats(directory: string | undefined): { files: number; bytes: number } {
	if (!directory || !fs.existsSync(directory)) return { files: 0, bytes: 0 };
	let files = 0;
	let bytes = 0;
	for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
		const filename = path.join(directory, item.name);
		if (item.isDirectory()) {
			const nested = spillStats(filename);
			files += nested.files;
			bytes += nested.bytes;
		} else {
			files++;
			bytes += fs.statSync(filename).size;
		}
	}
	return { files, bytes };
}

test("retained spill generations are replaced without invalidating captured state or clones", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-retention-generation-"));
	directories.push(cwd);
	const manager = SessionManager.inMemory(cwd);
	managers.push(manager);
	const payload = "oversized-history-".repeat(45_000);
	const firstId = manager.appendCustomEntry("large", { payload });
	const firstEntry = manager.getEntry(firstId);
	const snapshot = manager.captureState();
	const firstDirectory = snapshot.rawEntryDirectory;
	expect(firstDirectory).toBeDefined();
	const firstGenerationStats = spillStats(firstDirectory);
	expect(firstGenerationStats.files).toBeGreaterThan(0);
	expect(firstGenerationStats.bytes).toBeGreaterThan(0);

	await manager.newSession();
	const afterReset = spillStats(firstDirectory);
	expect(afterReset).toEqual({ files: 0, bytes: 0 });

	manager.restoreState(snapshot);
	expect(manager.getEntry(firstId)).toEqual(firstEntry);
	const clone = manager.cloneCurrentSession({ persist: false });
	managers.push(clone);
	expect(clone.getEntry(firstId)).toEqual(firstEntry);

	const restoredDirectory = manager.captureState().rawEntryDirectory;
	expect(spillStats(restoredDirectory).files).toBeGreaterThan(0);
	const staleDirectory = restoredDirectory;
	manager.appendCustomEntry("replacement", { payload: `${payload}new` });
	const exact = manager.getEntry(firstId);
	expect(exact).toEqual(firstEntry);
	await manager.newSession();
	expect(spillStats(staleDirectory)).toEqual({ files: 0, bytes: 0 });
});

test("adopting another session releases superseded spills", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-retention-adoption-"));
	directories.push(cwd);
	const manager = SessionManager.inMemory(cwd);
	managers.push(manager);
	manager.appendCustomEntry("old", { payload: "old-spill-".repeat(45_000) });
	const oldDirectory = manager.captureState().rawEntryDirectory;
	const sessionFile = path.join(cwd, "adopted.jsonl");
	const payload = "adopted-spill-".repeat(45_000);
	await Bun.write(
		sessionFile,
		[
			JSON.stringify({
				type: "session",
				version: 4,
				id: "adopted-session",
				timestamp: new Date().toISOString(),
				cwd,
			}),
			JSON.stringify({
				type: "custom",
				id: "adopted-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "large",
				data: { payload },
			}),
			"",
		].join("\n"),
	);

	await manager.setSessionFile(sessionFile);

	expect(spillStats(oldDirectory)).toEqual({ files: 0, bytes: 0 });
	expect(manager.getEntry("adopted-entry")).toEqual({
		type: "custom",
		id: "adopted-entry",
		parentId: null,
		timestamp: expect.any(String),
		customType: "large",
		data: { payload },
	});
});
