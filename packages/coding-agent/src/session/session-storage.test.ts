import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "./session-storage";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-session-storage-"));
	tempDirs.push(dir);
	return dir;
}

test("writeTextSync keeps open readers on the original file when replacement initially fails with EPERM", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "original snapshot\n");
	const reader = fs.openSync(sessionPath, "r");
	const original = fs.fstatSync(reader);
	const renameSync = storage.renameSync.bind(storage);
	let failed = false;
	spyOn(storage, "renameSync").mockImplementation((source, target) => {
		if (!failed && target === sessionPath) {
			failed = true;
			throw Object.assign(new Error("replace blocked"), { code: "EPERM" });
		}
		renameSync(source, target);
	});

	try {
		storage.writeTextSync(sessionPath, "replacement snapshot\n");
		expect(fs.readFileSync(reader, "utf8")).toBe("original snapshot\n");
		expect(fs.statSync(sessionPath).ino).not.toBe(original.ino);
		expect(await Bun.file(sessionPath).text()).toBe("replacement snapshot\n");
		expect(fs.readdirSync(tempDir)).toEqual(["session.jsonl"]);
	} finally {
		fs.closeSync(reader);
	}
});

test("writeTextSync restores the original identity and content when the EPERM retry fails", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "original\n");
	const original = fs.statSync(sessionPath);
	const renameSync = storage.renameSync.bind(storage);
	let attempts = 0;
	spyOn(storage, "renameSync").mockImplementation((source, target) => {
		if (source.endsWith(".tmp") && target === sessionPath) {
			attempts++;
			throw Object.assign(new Error(attempts === 1 ? "replace blocked" : "retry failed"), {
				code: attempts === 1 ? "EPERM" : "EIO",
			});
		}
		renameSync(source, target);
	});

	expect(() => storage.writeTextSync(sessionPath, "replacement\n")).toThrow("retry failed");
	expect(fs.statSync(sessionPath).ino).toBe(original.ino);
	expect(await Bun.file(sessionPath).text()).toBe("original\n");
	expect(fs.readdirSync(tempDir)).toEqual(["session.jsonl"]);
});

test("writeTextSync preserves the original when staging the replacement fails with EPERM", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "original\n");
	const original = fs.statSync(sessionPath);
	const writeFileSync = fs.writeFileSync;
	spyOn(fs, "writeFileSync").mockImplementation((file, content, options) => {
		if (typeof file === "string" && path.dirname(file) === tempDir && file.endsWith(".tmp")) {
			throw Object.assign(new Error("staging denied"), { code: "EPERM" });
		}
		writeFileSync(file, content, options);
	});

	expect(() => storage.writeTextSync(sessionPath, "replacement\n")).toThrow("staging denied");
	expect(fs.statSync(sessionPath).ino).toBe(original.ino);
	expect(await Bun.file(sessionPath).text()).toBe("original\n");
	expect(fs.readdirSync(tempDir)).toEqual(["session.jsonl"]);
});
