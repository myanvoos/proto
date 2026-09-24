import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function makeArchivedSession() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-branch-archive-"));
	tempDirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const archived = manager.appendMessage({ role: "user", content: "archived context", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "archived response", timestamp: 2 });
	const active = manager.appendMessage({ role: "user", content: "active context", timestamp: 3 });
	manager.appendMessage({ role: "user", content: "active response", timestamp: 4 });
	manager.appendCompaction("summary", undefined, active, 1000);
	await manager.ensureOnDisk();
	await manager.flush();
	await manager.archiveCompactedHistory(active);
	return { dir, manager, archived, active };
}

for (const branchPoint of ["archived", "active"] as const) {
	test(`branched session persists hydrated entries when branching at an ${branchPoint} entry`, async () => {
		const { dir, manager, archived, active } = await makeArchivedSession();
		try {
			const branchFile = manager.createBranchedSession(branchPoint === "archived" ? archived : active);
			if (!branchFile) throw new Error("Expected a persisted branch file");
			const expected = manager.getEntries();
			const reopened = await SessionManager.open(branchFile, undefined, undefined, {
				initialCwd: dir,
				suppressBreadcrumb: true,
			});
			try {
				expect(reopened.getEntries()).toEqual(expected);
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});
}
