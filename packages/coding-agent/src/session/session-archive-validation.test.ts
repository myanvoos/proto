import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { sessionArchivePath } from "./session-loader";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function writeSessionWithArchive(records: readonly { id: string; beforeId: string | null; line: string }[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-archive-validation-"));
	tempDirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	const active = [
		{ type: "session", version: 3, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
		{ type: "message", id: "active-id", parentId: null, timestamp: 1, message: { role: "user", content: "keep me" } },
	];
	fs.writeFileSync(file, `${active.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	fs.writeFileSync(
		sessionArchivePath(file),
		gzipSync(JSON.stringify({ version: 1, sessionId: "session-id", sessionFile: file, records })).toString("base64"),
	);
	return { dir, file, active };
}

function archivedRecord(id: string, beforeId = "active-id") {
	return {
		id,
		beforeId,
		line: JSON.stringify({
			type: "message",
			id,
			parentId: "active-id",
			timestamp: 2,
			message: { role: "user", content: id },
		}),
	};
}

for (const [name, records] of [
	["duplicate archived IDs", [archivedRecord("duplicate"), archivedRecord("duplicate")]],
	["an archived ID colliding with an active row", [archivedRecord("active-id")]],
] as const) {
	test(`invalid archive with ${name} is ignored without rewriting the active transcript`, async () => {
		const { dir, file, active } = await writeSessionWithArchive(records);
		const before = fs.readFileSync(file, "utf8");
		const manager = await SessionManager.open(file, dir, undefined, { initialCwd: dir, suppressBreadcrumb: true });
		try {
			expect(manager.getEntries().map(entry => entry.id)).toEqual(active.slice(1).map(entry => entry.id));
			expect(fs.readFileSync(file, "utf8")).toBe(before);
			await manager.close();
			for (let cycle = 0; cycle < 2; cycle++) {
				const reopened = await SessionManager.open(file, dir, undefined, {
					initialCwd: dir,
					suppressBreadcrumb: true,
				});
				try {
					expect(reopened.getEntries().map(entry => entry.id)).toContain("active-id");
					reopened.appendCustomEntry("cycle", { cycle });
					await reopened.rewriteEntries();
				} finally {
					await reopened.close();
				}
			}
			expect(fs.readFileSync(file, "utf8")).toContain('"id":"active-id"');
		} finally {
			await manager.close();
		}
	});
}
