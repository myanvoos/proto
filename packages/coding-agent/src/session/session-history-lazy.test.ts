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

async function probe(mode: string): Promise<Record<string, number>> {
	const child = Bun.spawn(
		[process.execPath, path.resolve(import.meta.dir, "../../test/fixtures/session-history-retention.ts"), mode],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`History probe exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout) as Record<string, number>;
}

test("persistence truncation owns only the retained string rather than the oversized input backing store", async () => {
	const result = await probe("persistence");
	expect(result.retainedChars).toBe(8_000_000);
	expect(result.retainedBytes).toBeLessThan(28 * 1024 * 1024);
}, 30_000);

test("evicted history payloads collect while complete rewind and streaming export remain available", async () => {
	const result = await probe("history");
	expect(result.survivors).toBe(0);
	expect(result.contextMessages).toBe(2);
	expect(result.firstLength).toBe(256 * 1024);
	expect(result.exportedCharacters).toBe(100 * 256 * 1024 + "active tail".length);
}, 30_000);

test("active context and maintenance do not read compacted-away oversized backing files", async () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	manager.appendModelChange("anthropic/model");
	const first = manager.appendMessage({ role: "user", content: "historical".repeat(120_000), timestamp: 0 });
	for (let index = 1; index < 12; index++)
		manager.appendMessage({ role: "user", content: `${index}${"x".repeat(1024 * 1024)}`, timestamp: index });
	const kept = manager.appendMessage({ role: "user", content: "kept tail", timestamp: 12 });
	manager.appendCompaction("summary", undefined, kept, 100_000);
	const snapshot = manager.captureState();
	const raw = snapshot.rawEntryFiles.find(([id]) => id === first)?.[1];
	if (!raw || !snapshot.rawEntryDirectory) throw new Error("Expected historical backing file");
	const file = path.join(snapshot.rawEntryDirectory, raw.name);
	const bytes = fs.readFileSync(file);
	fs.unlinkSync(file);
	const warnings: string[] = [];
	manager.onHistoryDegraded(message => warnings.push(message));
	try {
		const context = manager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user"]);
		expect(context.models.default).toBe("anthropic/model");
		expect(
			manager
				.getActiveBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.id),
		).toEqual([kept]);
		expect(warnings).toEqual([]);
	} finally {
		fs.writeFileSync(file, bytes);
	}
	const restored = manager.getEntry(first);
	expect(restored?.type === "message" && restored.message.role === "user" ? restored.message.content : undefined).toBe(
		"historical".repeat(120_000),
	);
});

test("read-only window paging reopens archived history without changing its durable bytes", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-lazy-history-window-"));
	directories.push(directory);
	const writer = SessionManager.create(directory, directory);
	managers.push(writer);
	const ids: string[] = [];
	for (let index = 0; index < 6; index++)
		ids.push(writer.appendMessage({ role: "user", content: `message ${index}`, timestamp: index }));
	writer.appendCompaction("summary", undefined, ids[4]!, 100);
	await writer.ensureOnDisk();
	await writer.archiveCompactedHistory(ids[4]!);
	const file = writer.getSessionFile()!;
	const before = fs.readFileSync(file, "utf8");
	const archiveBefore = fs.readFileSync(`${file}.archive.jsonl.gz`, "utf8");
	const reader = await SessionManager.openReadOnly(file);
	managers.push(reader);
	const latest = reader.buildSessionContext({
		transcript: true,
		window: { pageFromLatest: 0, maxMessages: 3, maxBytes: 4096 },
	});
	expect(latest.window).toEqual({ start: 4, end: 7, pageFromLatest: 0, totalMessages: 7 });
	const older = reader.buildSessionContext({
		transcript: true,
		window: { pageFromLatest: 1, maxMessages: 3, maxBytes: 4096 },
	});
	expect(older.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
		"message 1",
		"message 2",
		"message 3",
	]);
	reader.branch(ids[0]!);
	expect(reader.buildSessionContext().messages).toMatchObject([{ role: "user", content: "message 0" }]);
	await reader.close();
	expect(fs.readFileSync(file, "utf8")).toBe(before);
	expect(fs.readFileSync(`${file}.archive.jsonl.gz`, "utf8")).toBe(archiveBefore);
});

test("custom-entry iteration hydrates only consumed matches and returns detached branch-aware snapshots", () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	const first = manager.appendCustomEntry("spawn", { text: "first" });
	manager.appendCustomEntry("unrelated", { text: "not a spawn" });
	const secondText = "complete spawn payload ".repeat(1024);
	const second = manager.appendCustomEntry("spawn", { text: secondText });
	for (let index = 0; index < 70; index++)
		manager.appendMessage({ role: "user", content: `later ${index}`, timestamp: index });
	const snapshot = manager.captureState();
	const raw = snapshot.rawEntryFiles.find(([id]) => id === second)?.[1];
	if (!raw || !snapshot.rawEntryDirectory) throw new Error("Expected custom-entry backing file");
	const file = path.join(snapshot.rawEntryDirectory, raw.name);
	const saved = fs.readFileSync(file);
	const warnings: string[] = [];
	manager.onHistoryDegraded(message => warnings.push(message));
	fs.unlinkSync(file);
	const entries = manager.iterateCustomEntries("spawn");
	try {
		const result = entries.next();
		expect(result.done).toBe(false);
		if (result.done) throw new Error("Expected first custom entry");
		expect(result.value.id).toBe(first);
		expect(result.value.data).toEqual({ text: "first" });
		result.value.data = { text: "caller-owned mutation" };
		expect(warnings).toEqual([]);
	} finally {
		fs.writeFileSync(file, saved);
	}
	expect([...entries].map(entry => entry.data)).toEqual([{ text: secondText }]);
	manager.branch(first);
	expect([...manager.iterateCustomEntries("spawn", { branch: true })].map(entry => entry.data)).toEqual([
		{ text: "first" },
	]);
	expect(manager.getCustomEntries("spawn").map(entry => entry.id)).toEqual([first, second]);
	expect(warnings).toEqual([]);
});

test("an oversized transcript group displays an explicit notice without hydrating or deleting its full payload", () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	const content = "complete source ".repeat(100_000);
	const id = manager.appendMessage({ role: "user", content, timestamp: 1 });
	const context = manager.buildSessionContext({
		transcript: true,
		window: { pageFromLatest: 0, maxMessages: 5, maxBytes: 1024 },
	});
	expect(context.messages).toMatchObject([{ role: "custom", customType: "history-window-limit" }]);
	expect(JSON.stringify(context.messages).length).toBeLessThan(1024);
	const full = manager.getEntry(id);
	expect(full?.type === "message" && full.message.role === "user" ? full.message.content : undefined).toBe(content);
});

test("a lost history backing file cannot overwrite durable transcript content with its preview", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proto-lost-history-safety-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	try {
		const first = manager.appendMessage({
			role: "user",
			content: "durable full history ".repeat(1000),
			timestamp: 0,
		});
		for (let index = 1; index < 70; index++)
			manager.appendMessage({ role: "user", content: `later ${index}`, timestamp: index });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		const before = fs.readFileSync(file, "utf8");
		const snapshot = manager.captureState();
		const raw = snapshot.rawEntryFiles.find(([id]) => id === first)?.[1];
		if (!raw || !snapshot.rawEntryDirectory) throw new Error("Expected historical backing file");
		fs.unlinkSync(path.join(snapshot.rawEntryDirectory, raw.name));
		manager.getEntry(first);
		await expect(manager.rewriteEntries()).rejects.toThrow("history backing file was lost");
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		const reopened = await SessionManager.openReadOnly(file);
		managers.push(reopened);
		const recovered = reopened.getEntry(first);
		expect(
			recovered?.type === "message" && recovered.message.role === "user" ? recovered.message.content : undefined,
		).toBe("durable full history ".repeat(1000));
	} finally {
		await manager.close().catch(() => undefined);
	}
});
