import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileSessionStorage,
	MemorySessionStorage,
	SessionStorageLockError,
	type SessionStorageWriter,
	SessionWriteConflictError,
} from "./session-storage";
import { serializeTitleSlot } from "./session-title-slot";

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

test("openWriter excludes a second writer until the first releases the session", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "header\n");
	const first = storage.openWriter(sessionPath);
	let second: SessionStorageWriter | undefined;
	let secondOpenError: unknown;

	try {
		first.appendSync?.("first committed entry\n");
		try {
			second = storage.openWriter(sessionPath);
		} catch (error) {
			secondOpenError = error;
		}
		await second?.close();

		expect(secondOpenError).toBeInstanceOf(SessionStorageLockError);
		expect(await Bun.file(sessionPath).text()).toBe("header\nfirst committed entry\n");
	} finally {
		await first.close();
	}

	const afterRelease = storage.openWriter(sessionPath);
	try {
		afterRelease.appendSync?.("entry after release\n");
	} finally {
		await afterRelease.close();
	}
	expect(await Bun.file(sessionPath).text()).toBe("header\nfirst committed entry\nentry after release\n");
});

test("openWriter excludes an appender in another process", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "cross-process-session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "header\n");
	const first = storage.openWriter(sessionPath);

	try {
		first.appendSync?.("parent committed entry\n");
		const moduleUrl = JSON.stringify(new URL("./session-storage.ts", import.meta.url).href);
		const childSource = `
import { FileSessionStorage } from ${moduleUrl};
let writer;
try {
	writer = new FileSessionStorage().openWriter(${JSON.stringify(sessionPath)});
} catch {
	process.exitCode = 73;
}
if (writer) {
	writer.appendSync?.("child entry\\n");
	await writer.close();
}
`;
		const child = Bun.spawn([process.execPath, "-e", childSource], {
			stdout: "ignore",
			stderr: "ignore",
		});

		expect(await child.exited).toBe(73);
		expect(await Bun.file(sessionPath).text()).toBe("header\nparent committed entry\n");
	} finally {
		await first.close();
	}
});

test("atomic rewrites cannot replace a file with an active append writer", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "locked-rewrite-session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "original\n");
	const writer = storage.openWriter(sessionPath);

	try {
		writer.appendSync?.("committed by writer\n");
		await expect(storage.writeTextAtomic(sessionPath, "replacement\n")).rejects.toBeInstanceOf(
			SessionStorageLockError,
		);
		expect(() => storage.writeTextSync(sessionPath, "replacement\n")).toThrow(SessionStorageLockError);
		expect(await Bun.file(sessionPath).text()).toBe("original\ncommitted by writer\n");
	} finally {
		await writer.close();
	}
});

test("openWriter releases its lock when opening the session file fails", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "blocked-session.jsonl");
	const storage = new FileSessionStorage();
	fs.mkdirSync(sessionPath);

	expect(() => storage.openWriter(sessionPath)).toThrow();
	fs.rmSync(sessionPath, { recursive: true, force: true });
	await Bun.write(sessionPath, "header\n");

	const afterFailure = storage.openWriter(sessionPath);
	await afterFailure.close();
});

test("closing a writer after an append error releases its lock", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "failed-append-session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "header\n");
	const writer = storage.openWriter(sessionPath);
	const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
		throw Object.assign(new Error("simulated append failure"), { code: "EIO" });
	});

	expect(() => writer.appendSync?.("failed entry\n")).toThrow("simulated append failure");
	await expect(writer.close()).rejects.toThrow("simulated append failure");
	writeSpy.mockRestore();

	const afterFailure = storage.openWriter(sessionPath);
	await afterFailure.close();
});

test("an abandoned writer lock is released when its process exits", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "exited-process-session.jsonl");
	const storage = new FileSessionStorage();
	storage.writeTextSync(sessionPath, "header\n");
	const moduleUrl = JSON.stringify(new URL("./session-storage.ts", import.meta.url).href);
	const childSource = `
import { FileSessionStorage } from ${moduleUrl};
const writer = new FileSessionStorage().openWriter(${JSON.stringify(sessionPath)});
writer.appendSync?.("child committed entry\\n");
process.stdout.write("ready\\n");
// The writer's fd and lock are released by a FinalizationRegistry, so the child must keep a live
// reference until it is killed; otherwise GC can drop the lock while this process is still running.
// The reference is parked on globalThis because an expression-statement reference is removable by the
// optimizer, and under full-suite memory pressure it was in fact being collected.
(globalThis as Record<string, unknown>).__protoTestWriter = writer;
setInterval(() => {
	if (!(globalThis as Record<string, unknown>).__protoTestWriter) process.exit(3);
}, 1_000);
`;
	const child = Bun.spawn([process.execPath, "-e", childSource], {
		stdout: "pipe",
		stderr: "ignore",
	});
	let unexpectedWriter: SessionStorageWriter | undefined;
	let afterExit: SessionStorageWriter | undefined;

	try {
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		let output = "";
		while (!output.includes("ready\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`Writer child exited before ready: ${output}`);
			output += new TextDecoder().decode(chunk.value);
		}
		reader.releaseLock();

		let conflictError: unknown;
		try {
			unexpectedWriter = storage.openWriter(sessionPath);
		} catch (error) {
			conflictError = error;
		}
		expect(conflictError).toBeInstanceOf(Error);
		await unexpectedWriter?.close();

		child.kill();
		await child.exited;
		afterExit = storage.openWriter(sessionPath);
		expect(await Bun.file(sessionPath).text()).toBe("header\nchild committed entry\n");
	} finally {
		child.kill();
		await child.exited;
		await unexpectedWriter?.close();
		await afterExit?.close();
	}
});

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

test("title update failure leaves the previous complete slot intact", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "title-session.jsonl");
	const storage = new FileSessionStorage();
	const original = `${serializeTitleSlot({
		title: "Original title",
		source: "user",
		updatedAt: "2026-09-19T00:00:00.000Z",
	})}{"type":"session"}\n`;
	storage.writeTextSync(sessionPath, original);

	const renameSync = storage.renameSync.bind(storage);
	spyOn(storage, "renameSync").mockImplementation((source, target) => {
		if (source.endsWith(".tmp") && target === sessionPath) {
			throw Object.assign(new Error("simulated interrupted title replace"), { code: "EIO" });
		}
		renameSync(source, target);
	});

	await expect(
		storage.updateSessionTitle(sessionPath, {
			title: "Replacement title",
			source: "user",
			updatedAt: "2026-09-19T00:00:01.000Z",
		}),
	).rejects.toThrow("simulated interrupted title");
	expect(await Bun.file(sessionPath).text()).toBe(original);
});

test("title replacement respects the writer lock and fsyncs its committed rename", async () => {
	const tempDir = makeTempDir();
	const sessionPath = path.join(tempDir, "locked-title-session.jsonl");
	const storage = new FileSessionStorage();
	const originalSlot = serializeTitleSlot({
		title: "Original title",
		source: "user",
		updatedAt: "2026-09-19T00:00:00.000Z",
	});
	storage.writeTextSync(sessionPath, `${originalSlot}{"type":"session"}\n`);
	const writer = storage.openWriter(sessionPath);
	const replacement = {
		title: "Replacement title",
		source: "user" as const,
		updatedAt: "2026-09-19T00:00:01.000Z",
	};

	try {
		await expect(storage.updateSessionTitle(sessionPath, replacement)).rejects.toThrow("active writer");
		expect(await Bun.file(sessionPath).text()).toStartWith(originalSlot);
	} finally {
		await writer.close();
	}

	const fsyncSpy = spyOn(fs, "fsyncSync");
	await storage.updateSessionTitle(sessionPath, replacement);
	expect(await Bun.file(sessionPath).text()).toStartWith(serializeTitleSlot(replacement));
	expect(fsyncSpy).toHaveBeenCalled();
});

for (const kind of ["file", "memory"] as const) {
	test(`${kind} atomic append preserves existing UTF-8 bytes without full reads or rewrites`, async () => {
		const storage = kind === "file" ? new FileSessionStorage() : new MemorySessionStorage();
		const target = path.join(makeTempDir(), "archive.jsonl");
		await storage.writeText(target, "é\n");
		const read = spyOn(storage, "readText");
		const write = spyOn(storage, "writeText");
		const rewrite = spyOn(storage, "writeTextAtomic");
		const writeSync = spyOn(storage, "writeTextSync");
		await storage.appendTextAtomic(target, "第二\n", { expectedSize: 3, durable: true });
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(rewrite).not.toHaveBeenCalled();
		expect(writeSync).not.toHaveBeenCalled();
		expect(await storage.readText(target)).toBe("é\n第二\n");
		await expect(storage.appendTextAtomic(target, "stale", { expectedSize: 3 })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		await expect(storage.appendTextAtomic(target, "stale", { expectedSize: null })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		await storage.appendTextAtomic(target, "cancelled", { commitGuard: () => false });
		expect(await storage.readText(target)).toBe("é\n第二\n");
		const missing = `${target}.new`;
		await expect(storage.appendTextAtomic(missing, "wrong", { expectedSize: 0 })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		await storage.appendTextAtomic(missing, "created", { expectedSize: null });
		expect(await storage.readText(missing)).toBe("created");
	});
}

test("atomic append shares the writer lock and fsyncs both file and directory", async () => {
	const storage = new FileSessionStorage();
	const target = path.join(makeTempDir(), "archive.jsonl");
	await storage.writeText(target, "old");
	const writer = storage.openWriter(target);
	try {
		await expect(storage.appendTextAtomic(target, "blocked")).rejects.toBeInstanceOf(SessionStorageLockError);
	} finally {
		await writer.close();
	}
	const sync = fs.fsyncSync;
	const synced: string[] = [];
	spyOn(fs, "fsyncSync").mockImplementation(fd => {
		synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
		sync(fd);
	});
	await storage.appendTextAtomic(target, "new", { durable: true, expectedSize: 3 });
	expect(synced).toEqual(process.platform === "win32" ? ["file"] : ["file", "directory"]);
	expect(await storage.readText(target)).toBe("oldnew");
});

test("a partial append failure truncates only the attempted suffix and releases the writer lock", async () => {
	const storage = new FileSessionStorage();
	const target = path.join(makeTempDir(), "archive.jsonl");
	await storage.writeText(target, "original é\n");
	const before = storage.statSync(target).size;
	const write = fs.writeSync;
	let writes = 0;
	const failedWrite = spyOn(fs, "writeSync").mockImplementation(
		(
			fd: number,
			data: NodeJS.ArrayBufferView | string,
			offset?: number | null,
			length?: number | BufferEncoding | null,
			position?: number | null,
		) => {
			if (++writes === 2) throw new Error("partial append rejected");
			if (typeof data === "string") throw new Error("expected byte append");
			return write(fd, data, offset, Math.min(2, typeof length === "number" ? length : data.byteLength), position);
		},
	);
	await expect(storage.appendTextAtomic(target, "new suffix", { durable: true })).rejects.toThrow(
		"partial append rejected",
	);
	failedWrite.mockRestore();
	expect(await storage.readText(target)).toBe("original é\n");
	await storage.appendTextAtomic(target, "retry", { expectedSize: before });
	expect(await storage.readText(target)).toBe("original é\nretry");
});

for (const failure of ["file", "directory"] as const) {
	test(`a durable ${failure} sync failure rolls back existing and newly created append targets`, async () => {
		if (failure === "directory" && process.platform === "win32") return;
		const storage = new FileSessionStorage();
		const target = path.join(makeTempDir(), "archive.jsonl");
		await storage.writeText(target, "original");
		const sync = fs.fsyncSync;
		for (const current of [target, `${target}.new`]) {
			let failed = false;
			const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
				const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
				if (!failed && kind === failure) {
					failed = true;
					throw new Error("durability unavailable");
				}
				sync(fd);
			});
			await expect(storage.appendTextAtomic(current, "suffix", { durable: true })).rejects.toThrow(
				"durability unavailable",
			);
			syncSpy.mockRestore();
			if (current === target) expect(await storage.readText(current)).toBe("original");
			else expect(await storage.exists(current)).toBe(false);
		}
	});
}
