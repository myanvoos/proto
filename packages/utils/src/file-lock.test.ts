import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryAcquireFileLockSync, withFileLock } from "./file-lock";

test("tryAcquireFileLockSync excludes a second holder and releases for reuse", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-file-lock-sync-"));
	try {
		const target = path.join(dir, "session.jsonl");
		const first = tryAcquireFileLockSync(target);
		expect(first).not.toBeNull();
		expect(tryAcquireFileLockSync(target)).toBeNull();

		first?.release();
		const afterRelease = tryAcquireFileLockSync(target);
		expect(afterRelease).not.toBeNull();
		afterRelease?.release();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("withFileLock releases the shared lock when its callback throws", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-file-lock-error-"));
	try {
		const target = path.join(dir, "session.jsonl");
		await expect(
			withFileLock(
				target,
				async () => {
					expect(tryAcquireFileLockSync(target)).toBeNull();
					throw new Error("callback failed");
				},
				{ retries: 1 },
			),
		).rejects.toThrow("callback failed");

		const afterError = tryAcquireFileLockSync(target);
		expect(afterError).not.toBeNull();
		afterError?.release();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
