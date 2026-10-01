import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("SessionManager.forkFrom copyTitle", () => {
	test("default fork keeps the source title; side forks can start unnamed", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-side-fork-"));
		const cwd = tempDir;
		const source = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		source.appendMessage({ role: "user", content: "parent work", timestamp: 1 });
		await source.setSessionName("Parent name", "user");
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		expect(sourceFile).toBeDefined();
		if (!sourceFile) return;

		const keep = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir, "forks"));
		expect(keep.getSessionName()).toBe("Parent name");

		const side = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir, "forks"), undefined, {
			copyTitle: false,
		});
		expect(side.getSessionName()).toBeUndefined();

		// The unnamed fork must still accept a user rename from its live manager.
		const renamed = await side.setSessionName("Side title", "user");
		expect(renamed).toBe(true);
		expect(side.getSessionName()).toBe("Side title");
		await side.close();
		await keep.close();
	});
});
