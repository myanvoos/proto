import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { createSessionManager } from "../main";
import * as sessionListing from "../session/session-listing";
import { ForkSourceNotFoundError, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { parseArgs } from "./args";

// A missing fork source used to load as an empty session, so `--fork <typo>` minted an empty parentless session in
// the store and opened a shell on it.
let tempDir: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

async function setup(): Promise<{ cwd: string; sessionDir: string }> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-fork-missing-"));
	return { cwd: tempDir, sessionDir: path.join(tempDir, "sessions") };
}

async function writtenSessions(sessionDir: string): Promise<string[]> {
	try {
		return await fs.readdir(sessionDir, { recursive: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

describe("--fork with a missing source", () => {
	it.each([
		["a missing path", (cwd: string) => path.join(cwd, "ghost.jsonl")],
		["a path under a regular file (ENOTDIR)", (cwd: string) => path.join(cwd, "file.txt", "child.jsonl")],
	])("rejects %s without writing a session", async (_label, sourceFor) => {
		const { cwd, sessionDir } = await setup();
		await Bun.write(path.join(cwd, "file.txt"), "not a directory");
		const source = sourceFor(cwd);

		await expect(
			createSessionManager(parseArgs(["--session-dir", sessionDir, "--fork", source]), cwd),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: `Session "${source}" not found.`,
			hint: expect.stringContaining("proto --resume"),
		});
		expect(await writtenSessions(sessionDir)).toEqual([]);
	});

	it("rejects an id whose session vanished after resolution", async () => {
		const { cwd, sessionDir } = await setup();
		const id = "019ea530-0000-7000-0000-000000000000";
		vi.spyOn(sessionListing, "resolveResumableSession").mockResolvedValue({
			session: {
				id,
				path: path.join(cwd, "vanished.jsonl"),
				cwd,
				title: "vanished",
				created: new Date(0),
				modified: new Date(0),
				messageCount: 0,
				size: 0,
				firstMessage: "",
				allMessagesText: "",
			},
			scope: "local",
		} as Awaited<ReturnType<typeof sessionListing.resolveResumableSession>>);

		await expect(
			createSessionManager(parseArgs(["--session-dir", sessionDir, "--fork", id]), cwd),
		).rejects.toMatchObject({ name: "SessionResolutionError", message: `Session "${id}" not found.` });
		expect(await writtenSessions(sessionDir)).toEqual([]);
	});

	it("rejects a source that vanishes on the streaming load path", async () => {
		const { cwd, sessionDir } = await setup();
		const source = path.join(cwd, "ghost.jsonl");
		const storage = new FileSessionStorage();
		const realStatSync = storage.statSync.bind(storage);
		// A large stat routes the load through the stream reader, which then finds no file.
		vi.spyOn(storage, "statSync").mockImplementation(((filePath: string) =>
			filePath === source
				? { size: 64 * 1024 * 1024, mtimeMs: Date.now(), mtime: new Date() }
				: realStatSync(filePath)) as typeof storage.statSync);

		const caught = await SessionManager.forkFrom(source, cwd, sessionDir, storage).catch((err: unknown) => err);
		expect(caught).toBeInstanceOf(ForkSourceNotFoundError);
		expect(await writtenSessions(sessionDir)).toEqual([]);
	});
});
