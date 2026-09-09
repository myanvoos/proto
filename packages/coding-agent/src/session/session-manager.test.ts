import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("open rejects a corrupt session header without overwriting recoverable transcript bytes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "proto-corrupt-session-header-"));
	tempDirs.push(cwd);
	const sessionFile = path.join(cwd, "corrupt-session.jsonl");
	const original = [
		"{broken header",
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-27T00:00:00.000Z",
			message: { role: "user", content: "recover me", timestamp: 0 },
		}),
		"",
	].join("\n");
	await Bun.write(sessionFile, original);

	let opened: SessionManager | undefined;
	let openError: unknown;
	try {
		opened = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
	} catch (error) {
		openError = error;
	}
	const persisted = await Bun.file(sessionFile).text();
	await opened?.close();

	expect(persisted).toBe(original);
	expect(openError).toBeInstanceOf(Error);
	expect((openError as Error).message).toContain("session header is missing or malformed");
});
