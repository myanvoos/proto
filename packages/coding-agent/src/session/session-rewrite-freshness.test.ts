/**
 * A full rewrite publishes this manager's in-memory transcript over the file. When another writer appended after
 * this manager loaded, that rewrite used to erase the other writer's durable turns (#11496). Every full rewrite now
 * carries the byte length this manager last loaded or wrote, and storage rejects it when the target changed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "./session-manager";
import { FileSessionStorage, type SessionStorage, SessionWriteConflictError } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-rewrite-freshness-"));
	tempDirs.push(dir);
	return dir;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function messageTexts(manager: SessionManager): string[] {
	return manager.getEntries().flatMap(entry => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") return [];
		if (typeof message.content === "string") return [message.content];
		const texts: string[] = [];
		for (const block of message.content) if (block.type === "text") texts.push(block.text);
		return texts;
	});
}

async function reopenTexts(sessionFile: string, storage: SessionStorage): Promise<string[]> {
	const reopened = await SessionManager.open(sessionFile, undefined, storage, { suppressBreadcrumb: true });
	try {
		return messageTexts(reopened);
	} finally {
		await reopened.close();
	}
}

describe("session rewrite freshness", () => {
	it("refuses to erase a turn another manager appended after this one loaded", async () => {
		const dir = await makeTempDir();
		const first = SessionManager.create(dir, dir, new FileSessionStorage());
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const second = await SessionManager.open(sessionFile, dir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		second.appendMessage({ role: "user", content: "durable second-writer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await reopenTexts(sessionFile, new FileSessionStorage())).toContain("durable second-writer turn");
	});

	it("keeps a manager locked out by the active writer from erasing that writer's turns", async () => {
		const dir = await makeTempDir();
		const seed = SessionManager.create(dir, dir);
		seed.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		seed.appendMessage(assistant("seed reply"));
		await seed.flush();
		const sessionFile = seed.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await seed.close();

		const holder = await SessionManager.open(sessionFile);
		const lockedOut = await SessionManager.open(sessionFile);
		holder.appendMessage({ role: "user", content: "holder question", timestamp: Date.now() });
		holder.appendMessage(assistant("holder reply"));
		await holder.flush();
		// The holder's open writer owns the file lock, so this append stays in memory and needs a full rewrite later.
		lockedOut.appendMessage({ role: "user", content: "locked-out question", timestamp: Date.now() });
		await lockedOut.flush().catch(() => {});
		await holder.close();

		lockedOut.appendMessage(assistant("locked-out reply"));
		await expect(lockedOut.flush()).rejects.toBeInstanceOf(SessionWriteConflictError);
		await lockedOut.close().catch(() => {});

		expect(await reopenTexts(sessionFile, new FileSessionStorage())).toEqual([
			"first",
			"seed reply",
			"holder question",
			"holder reply",
		]);
	});

	it("tracks its own appends, title updates, and rewrites without a false conflict", async () => {
		const dir = await makeTempDir();
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		manager.appendMessage(assistant("answer"));
		await manager.flush();
		await manager.setSessionName("named session", "user");
		manager.appendMessage({ role: "user", content: "follow-up", timestamp: Date.now() });
		await manager.flush();
		await manager.rewriteEntries();
		manager.appendMessage(assistant("second answer"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		expect(await reopenTexts(sessionFile, new FileSessionStorage())).toEqual([
			"question",
			"answer",
			"follow-up",
			"second answer",
		]);
	});

	it("rejects a stale rewrite at a shared SQL backend another storage instance appended to", async () => {
		const client = new Bun.SQL("sqlite://:memory:");
		try {
			const firstStorage = await SqlSessionStorage.create({ client });
			const first = SessionManager.create("/work", "/sessions/work", firstStorage);
			first.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
			first.appendMessage(assistant("answer"));
			await first.flush();
			await firstStorage.drain();
			const sessionFile = first.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");

			// A peer process sharing the table: its own index, so only the backend sees both writers.
			const peerStorage = await SqlSessionStorage.create({ client });
			const peer = await SessionManager.open(sessionFile, undefined, peerStorage, { suppressBreadcrumb: true });
			peer.appendMessage({ role: "user", content: "peer turn", timestamp: Date.now() });
			await peer.close();
			await peerStorage.drain();

			await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
			const verifyStorage = await SqlSessionStorage.create({ client });
			expect(await reopenTexts(sessionFile, verifyStorage)).toContain("peer turn");
		} finally {
			await client.end();
		}
	});
});
