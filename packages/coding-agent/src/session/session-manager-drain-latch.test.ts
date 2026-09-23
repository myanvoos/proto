import { describe, expect, it } from "bun:test";
import { IndexedSessionStorage, type SessionStorageBackend } from "./indexed-session-storage";
import { SessionManager } from "./session-manager";

/**
 * A backend whose fire-and-forget publish fails. `IndexedSessionStorage.writeTextSync` records that failure and
 * surfaces it only from `drain()` — the headless Redis/SQL condition where close()/flush() used to reject without
 * latching the persistence failure or telling any observer.
 */
class FailingPublishBackend implements SessionStorageBackend {
	readonly failure = new Error("backend publish failed");
	init = () => Promise.resolve();
	loadIndex = () => Promise.resolve([]);
	readFull = () => Promise.resolve(null);
	readSlices = (): Promise<[string, string]> => Promise.resolve(["", ""]);
	writeFull = () => Promise.reject(this.failure);
	append = () => Promise.resolve();
	updateSessionTitle = () => Promise.resolve();
	truncate = () => Promise.resolve();
	remove = () => Promise.resolve();
	move = () => Promise.resolve();
}

describe("drain-only storage failures", () => {
	it.each(["close", "flush"] as const)("%s latches the failure and notifies observers before rejecting", async op => {
		const backend = new FailingPublishBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const observed: Error[] = [];
		manager.onPersistenceError(error => observed.push(error));
		storage.writeTextSync("/sessions/headless.jsonl", '{"type":"session"}\n');

		await expect(manager[op]()).rejects.toBe(backend.failure);
		expect(observed).toEqual([backend.failure]);
	});
});
