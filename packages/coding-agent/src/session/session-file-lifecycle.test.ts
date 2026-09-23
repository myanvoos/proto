import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "./session-listing";
import { SessionManager } from "./session-manager";
import { FileSessionStorage } from "./session-storage";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; cwdA: string; cwdB: string; source: string; target: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-move-"));
	roots.push(root);
	const dirs = {
		root,
		cwdA: path.join(root, "cwd-a"),
		cwdB: path.join(root, "cwd-b"),
		source: path.join(root, "sessions-a"),
		target: path.join(root, "sessions-b"),
	};
	for (const dir of [dirs.cwdA, dirs.cwdB, dirs.source]) await fs.promises.mkdir(dir);
	return dirs;
}

function exdev(message: string): Error {
	return Object.assign(new Error(message), { code: "EXDEV" });
}

it("moves a session file and nested artifacts when rename crosses devices", async () => {
	const { cwdA, cwdB, source, target } = await fixture();
	const session = SessionManager.create(cwdA, source);
	session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
	await session.ensureOnDisk();
	const oldFile = session.getSessionFile()!;
	const oldArtifacts = oldFile.slice(0, -".jsonl".length);
	await fs.promises.mkdir(path.join(oldArtifacts, "child"), { recursive: true });
	await Bun.write(path.join(oldArtifacts, "1.bash.log"), "saved output");
	await Bun.write(path.join(oldArtifacts, "child", "2.bash.log"), "nested output");
	const rename = fs.promises.rename.bind(fs.promises);
	const link = fs.promises.link.bind(fs.promises);
	const copyFile = fs.promises.copyFile.bind(fs.promises);
	let appendedDuringCopy = false;
	vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
		if (from.toString() === oldFile || from.toString().startsWith(oldArtifacts)) throw exdev("cross-device move");
		return rename(from, to);
	});
	vi.spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
		if (from.toString().startsWith(oldArtifacts)) throw exdev("cross-device link");
		return link(from, to);
	});
	vi.spyOn(fs.promises, "copyFile").mockImplementation(async (from, to, mode) => {
		await copyFile(from, to, mode);
		// A completed append while the copy is staged must land in the published file.
		if (from.toString() === oldFile && !appendedDuringCopy) {
			appendedDuringCopy = true;
			session.appendMessage({ role: "user", content: "during staged copy", timestamp: 2 });
		}
	});

	await session.moveTo(cwdB, target);
	vi.restoreAllMocks();

	const newFile = session.getSessionFile()!;
	const newArtifacts = newFile.slice(0, -".jsonl".length);
	expect(path.dirname(newFile)).toBe(target);
	expect(fs.existsSync(oldFile)).toBe(false);
	expect(fs.existsSync(oldArtifacts)).toBe(false);
	expect(await Bun.file(path.join(newArtifacts, "1.bash.log")).text()).toBe("saved output");
	expect(await Bun.file(path.join(newArtifacts, "child", "2.bash.log")).text()).toBe("nested output");
	await session.flush();
	const transcript = await Bun.file(newFile).text();
	expect(transcript).toContain("before move");
	expect(transcript).toContain("during staged copy");
	await session.close();
});

it("merges artifacts into a destination bucket that already holds the session's directory", async () => {
	const { cwdA, cwdB, source, target } = await fixture();
	const session = SessionManager.create(cwdA, source);
	session.appendMessage({ role: "user", content: "moving back", timestamp: 1 });
	await session.ensureOnDisk();
	const oldFile = session.getSessionFile()!;
	const oldArtifacts = oldFile.slice(0, -".jsonl".length);
	await fs.promises.mkdir(oldArtifacts);
	await Bun.write(path.join(oldArtifacts, "1.bash.log"), "fresh output");
	await Bun.write(path.join(oldArtifacts, "2.read.log"), "session copy of id 2");
	await Bun.write(path.join(oldArtifacts, "notes.txt"), "session notes");
	// A writer that kept the old path after an earlier move left the destination occupied.
	const staleArtifacts = path.join(target, path.basename(oldArtifacts));
	await fs.promises.mkdir(staleArtifacts, { recursive: true });
	await Bun.write(path.join(staleArtifacts, "2.bash.log"), "stale writer id 2");
	await Bun.write(path.join(staleArtifacts, "notes.txt"), "stale notes");

	await session.moveTo(cwdB, target);

	const newArtifacts = session.getSessionFile()!.slice(0, -".jsonl".length);
	expect(newArtifacts).toBe(staleArtifacts);
	expect(await Bun.file(path.join(newArtifacts, "1.bash.log")).text()).toBe("fresh output");
	// Neither a taken name nor a taken artifact id is overwritten; the session's copies stay at the source.
	expect(await Bun.file(path.join(newArtifacts, "2.bash.log")).text()).toBe("stale writer id 2");
	expect(await Bun.file(path.join(newArtifacts, "notes.txt")).text()).toBe("stale notes");
	expect(fs.existsSync(path.join(newArtifacts, "2.read.log"))).toBe(false);
	expect((await fs.promises.readdir(oldArtifacts)).sort()).toEqual(["2.read.log", "notes.txt"]);
	expect(await Bun.file(session.getSessionFile()!).text()).toContain("moving back");
	await session.close();
});

it("close-time draft GC keeps a draft-only session another writer has since extended", async () => {
	const { cwdA, source } = await fixture();
	const cases = [
		JSON.stringify({
			type: "message",
			id: "peer0001",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "peer turn", timestamp: 1 },
		}),
		"{ malformed peer record",
	];
	for (const appended of cases) {
		const session = SessionManager.create(cwdA, source);
		await session.saveDraft("unsent draft");
		const sessionFile = session.getSessionFile()!;
		expect(fs.existsSync(sessionFile)).toBe(true);
		// The draft is consumed elsewhere, arming the GC, and a peer writes real content.
		expect(await session.consumeDraft()).toBe("unsent draft");
		await fs.promises.appendFile(sessionFile, `${appended}\n`);

		await session.close();
		expect(await Bun.file(sessionFile).text()).toContain(appended);
	}

	// Control: an untouched draft-only session is still collected on close.
	const untouched = SessionManager.create(cwdA, source);
	await untouched.saveDraft("unsent draft");
	const untouchedFile = untouched.getSessionFile()!;
	expect(await untouched.consumeDraft()).toBe("unsent draft");
	await untouched.close();
	expect(fs.existsSync(untouchedFile)).toBe(false);
});

it("deleting a session also removes its stale rewrite backups so listing cannot resurrect it", async () => {
	const { cwdA, source } = await fixture();
	const session = SessionManager.create(cwdA, source);
	session.appendMessage({ role: "user", content: "doomed", timestamp: 1 });
	await session.ensureOnDisk();
	const sessionFile = session.getSessionFile()!;
	await session.close();
	const backup = `${sessionFile}.123456789.bak`;
	await fs.promises.copyFile(sessionFile, backup);
	const unrelatedBackup = path.join(source, "other.jsonl.123.bak");
	await Bun.write(unrelatedBackup, "{}\n");

	const storage = new FileSessionStorage();
	await storage.deleteSessionWithArtifacts(sessionFile);

	expect(fs.existsSync(backup)).toBe(false);
	expect(fs.existsSync(unrelatedBackup)).toBe(true);
	expect((await listSessions(source, storage)).map(info => info.path)).not.toContain(sessionFile);
	expect(fs.existsSync(sessionFile)).toBe(false);
});
