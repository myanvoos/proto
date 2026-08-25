import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	DetachedSessionHolder,
	detachedSessionHolder,
} from "@oh-my-pi/pi-coding-agent/session/detached-session-holder";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

type MockSession = {
	abort: Mock<(...args: Array<unknown>) => unknown>;
};

type MockManager = {
	id: string;
};

function makeSession(): MockSession {
	return { abort: vi.fn() };
}

function makeManager(id = "mgr"): MockManager {
	return { id };
}

describe("DetachedSessionHolder", () => {
	beforeEach(() => {
		detachedSessionHolder.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		detachedSessionHolder.clear();
	});

	describe("park/take: has/peek/delete/clear/size", () => {
		it("park then take returns same entry", () => {
			const holder = new DetachedSessionHolder();
			const session = makeSession();
			const manager = makeManager("m1");
			const file = "/tmp/a/session.jsonl";

			holder.park(file, session as unknown as AgentSession, manager as unknown as SessionManager);

			expect(holder.size()).toBe(1);
			expect(holder.has(file)).toBe(true);
			const peeked = holder.peek(file);
			expect(peeked?.session).toBe(session as unknown as AgentSession);
			expect(peeked?.manager).toBe(manager as unknown as SessionManager);

			const taken = holder.take(file);
			expect(taken?.session).toBe(session as unknown as AgentSession);
			expect(taken?.manager).toBe(manager as unknown as SessionManager);
			expect(holder.size()).toBe(0);
			expect(holder.has(file)).toBe(false);
			expect(holder.peek(file)).toBeUndefined();
			expect(holder.take(file)).toBeUndefined();
		});

		it("delete removes entry, clear empties all, has/peek reflect state", () => {
			const holder = new DetachedSessionHolder();
			const s1 = makeSession();
			const s2 = makeSession();
			const m1 = makeManager("m1");
			const m2 = makeManager("m2");
			const f1 = "/tmp/a/one.jsonl";
			const f2 = "/tmp/a/two.jsonl";

			holder.park(f1, s1 as unknown as AgentSession, m1 as unknown as SessionManager);
			holder.park(f2, s2 as unknown as AgentSession, m2 as unknown as SessionManager);
			expect(holder.size()).toBe(2);

			holder.delete(f1);
			expect(holder.has(f1)).toBe(false);
			expect(holder.has(f2)).toBe(true);
			expect(holder.size()).toBe(1);
			expect(holder.peek(f1)).toBeUndefined();

			holder.clear();
			expect(holder.size()).toBe(0);
			expect(holder.has(f2)).toBe(false);
		});

		it("singleton park/take works and clear isolates", () => {
			const s = makeSession();
			const m = makeManager("singleton");
			const file = "/tmp/singleton/session.jsonl";
			detachedSessionHolder.park(file, s as unknown as AgentSession, m as unknown as SessionManager);
			expect(detachedSessionHolder.has(file)).toBe(true);
			const taken = detachedSessionHolder.take(file);
			expect(taken?.session).toBe(s as unknown as AgentSession);
			expect(detachedSessionHolder.size()).toBe(0);
		});
	});

	describe("null-file no-ops", () => {
		it("park(null), park(undefined), park(in-memory), park non-jsonl are no-ops", () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			const m = makeManager();

			holder.park(null, s as unknown as AgentSession, m as unknown as SessionManager);
			holder.park(undefined, s as unknown as AgentSession, m as unknown as SessionManager);
			holder.park("in-memory", s as unknown as AgentSession, m as unknown as SessionManager);
			holder.park("/tmp/foo.txt", s as unknown as AgentSession, m as unknown as SessionManager);
			holder.park("/tmp/foo.json", s as unknown as AgentSession, m as unknown as SessionManager);
			holder.park("", s as unknown as AgentSession, m as unknown as SessionManager);

			expect(holder.size()).toBe(0);
			expect(holder.take(null)).toBeUndefined();
			expect(holder.take(undefined)).toBeUndefined();
			expect(holder.take("in-memory")).toBeUndefined();
			expect(holder.take("/tmp/foo.txt")).toBeUndefined();
			expect(holder.has(null)).toBe(false);
			expect(holder.has(undefined)).toBe(false);
			expect(holder.has("in-memory")).toBe(false);
			expect(holder.has("/tmp/foo.txt")).toBe(false);
			expect(holder.peek(null)).toBeUndefined();
			expect(holder.peek("/tmp/foo.txt")).toBeUndefined();
			holder.delete(null);
			holder.delete(undefined);
			holder.delete("in-memory");
			holder.delete("/tmp/foo.txt");
			expect(holder.size()).toBe(0);
		});
	});

	describe("path.resolve identity", () => {
		it("park with one path and has with normalized path resolves true", () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			const m = makeManager();
			const canonical = "/a/b/session.jsonl";
			const withDotDot = "/a/../a/b/session.jsonl";
			const withDotSlash = "/a/b/./session.jsonl";

			holder.park(canonical, s as unknown as AgentSession, m as unknown as SessionManager);
			expect(holder.has(withDotDot)).toBe(true);
			expect(holder.has(withDotSlash)).toBe(true);
			expect(holder.peek(withDotDot)?.session).toBe(s as unknown as AgentSession);
			expect(holder.take(withDotDot)?.session).toBe(s as unknown as AgentSession);
			expect(holder.size()).toBe(0);
		});

		it("take with resolved variant removes canonical key", () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			const m = makeManager();
			const file = "/tmp/../tmp/test/session.jsonl";
			const canonical = path.resolve(file);
			holder.park(file, s as unknown as AgentSession, m as unknown as SessionManager);
			expect(holder.has(canonical)).toBe(true);
			const taken = holder.take(canonical);
			expect(taken?.session).toBe(s as unknown as AgentSession);
		});
	});

	describe("evictLRU", () => {
		it("park 9 files with different lastActivity, evictLRU(8) returns 1 oldest, aborts it, size 8, peek oldest missing", async () => {
			const holder = new DetachedSessionHolder();
			const base = Date.now();
			for (let i = 0; i < 9; i++) {
				const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base + i * 1000);
				const s = makeSession();
				const manager = makeManager(`m${i}`);
				holder.park(`/tmp/evict/${i}.jsonl`, s as unknown as AgentSession, manager as unknown as SessionManager);
				nowSpy.mockRestore();
			}
			expect(holder.size()).toBe(9);

			const holder2 = new DetachedSessionHolder();
			const tracked: Array<{ file: string; session: MockSession }> = [];
			for (let i = 0; i < 9; i++) {
				const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base + i * 1000);
				const s = makeSession();
				const manager = makeManager(`m${i}`);
				const file = `/tmp/evict2/${i}.jsonl`;
				holder2.park(file, s as unknown as AgentSession, manager as unknown as SessionManager);
				tracked.push({ file: path.resolve(file), session: s });
				nowSpy.mockRestore();
			}

			const evicted = await holder2.evictLRU(8);
			expect(evicted.length).toBe(1);
			expect(holder2.size()).toBe(8);
			expect(evicted[0]).toBe(path.resolve("/tmp/evict2/0.jsonl"));
			expect(tracked[0].session.abort).toHaveBeenCalledWith({ goalReason: "internal" });
			expect(holder2.peek("/tmp/evict2/0.jsonl")).toBeUndefined();
			expect(holder2.has("/tmp/evict2/0.jsonl")).toBe(false);
			expect(holder2.has("/tmp/evict2/8.jsonl")).toBe(true);
		});

		it("evictLRU does nothing when size <= limit", async () => {
			const holder = new DetachedSessionHolder();
			const base = Date.now();
			for (let i = 0; i < 3; i++) {
				const spy = vi.spyOn(Date, "now").mockReturnValue(base + i);
				holder.park(
					`/tmp/small/${i}.jsonl`,
					makeSession() as unknown as AgentSession,
					makeManager() as unknown as SessionManager,
				);
				spy.mockRestore();
			}
			const evicted = await holder.evictLRU(5);
			expect(evicted.length).toBe(0);
			expect(holder.size()).toBe(3);
		});
	});

	describe("LRU ordering with touch", () => {
		it("park 3 files, touch middle, evictLRU(2) should evict oldest not touched", async () => {
			const holder = new DetachedSessionHolder();
			const base = Date.now();
			const sessions: Record<string, MockSession> = {};

			for (const [name, offset] of [
				["a", 0],
				["b", 1000],
				["c", 2000],
			] as const) {
				const spy = vi.spyOn(Date, "now").mockReturnValue(base + offset);
				const s = makeSession();
				sessions[name] = s;
				holder.park(
					`/tmp/lru/${name}.jsonl`,
					s as unknown as AgentSession,
					makeManager(name) as unknown as SessionManager,
				);
				spy.mockRestore();
			}

			const touchSpy = vi.spyOn(Date, "now").mockReturnValue(base + 5000);
			holder.touch("/tmp/lru/b.jsonl");
			touchSpy.mockRestore();

			const evicted = await holder.evictLRU(2);
			expect(evicted.length).toBe(1);
			expect(evicted[0]).toBe(path.resolve("/tmp/lru/a.jsonl"));
			expect(sessions.a.abort).toHaveBeenCalledWith({ goalReason: "internal" });
			expect(holder.has("/tmp/lru/a.jsonl")).toBe(false);
			expect(holder.has("/tmp/lru/b.jsonl")).toBe(true);
			expect(holder.has("/tmp/lru/c.jsonl")).toBe(true);
			expect(holder.size()).toBe(2);
		});

		it("touch updates lastActivity so eviction skips touched entry", async () => {
			const holder = new DetachedSessionHolder();
			const base = Date.now();
			const sA = makeSession();
			const sB = makeSession();
			{
				const spy = vi.spyOn(Date, "now").mockReturnValue(base);
				holder.park(
					"/tmp/touch/a.jsonl",
					sA as unknown as AgentSession,
					makeManager("a") as unknown as SessionManager,
				);
				spy.mockRestore();
			}
			{
				const spy = vi.spyOn(Date, "now").mockReturnValue(base + 1000);
				holder.park(
					"/tmp/touch/b.jsonl",
					sB as unknown as AgentSession,
					makeManager("b") as unknown as SessionManager,
				);
				spy.mockRestore();
			}
			{
				const spy = vi.spyOn(Date, "now").mockReturnValue(base + 5000);
				holder.touch("/tmp/touch/a.jsonl");
				spy.mockRestore();
			}
			const evicted = await holder.evictLRU(1);
			expect(evicted.length).toBe(1);
			expect(evicted[0]).toBe(path.resolve("/tmp/touch/b.jsonl"));
			expect(sB.abort).toHaveBeenCalled();
			expect(sA.abort).not.toHaveBeenCalled();
		});

		it("touch on missing file is no-op", () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			holder.park(
				"/tmp/touch/exists.jsonl",
				s as unknown as AgentSession,
				makeManager() as unknown as SessionManager,
			);
			holder.touch("/tmp/touch/missing.jsonl");
			expect(holder.size()).toBe(1);
		});
	});

	describe("touch updates lastActivity timestamp", () => {
		it("touch sets lastActivity to Date.now", () => {
			const holder = new DetachedSessionHolder();
			const base = 1_000_000;
			{
				const spy = vi.spyOn(Date, "now").mockReturnValue(base);
				holder.park(
					"/tmp/touch2/file.jsonl",
					makeSession() as unknown as AgentSession,
					makeManager() as unknown as SessionManager,
				);
				spy.mockRestore();
			}
			const beforeEntry = holder.peek("/tmp/touch2/file.jsonl");
			expect(beforeEntry?.lastActivity).toBe(base);
			{
				const spy = vi.spyOn(Date, "now").mockReturnValue(base + 9999);
				holder.touch("/tmp/touch2/file.jsonl");
				spy.mockRestore();
			}
			const afterEntry = holder.peek("/tmp/touch2/file.jsonl");
			expect(afterEntry?.lastActivity).toBe(base + 9999);
		});
	});

	describe("stopAndRemove", () => {
		it("takes the entry, awaits its abort, and reports existence", async () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			holder.park("/tmp/stop/a.jsonl", s as unknown as AgentSession, makeManager("a") as unknown as SessionManager);

			const existed = await holder.stopAndRemove("/tmp/stop/a.jsonl");

			expect(existed).toBe(true);
			expect(s.abort).toHaveBeenCalledWith({ goalReason: "internal" });
			expect(holder.has("/tmp/stop/a.jsonl")).toBe(false);
			expect(holder.size()).toBe(0);
		});

		it("returns false without aborting anything when no entry exists", async () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			holder.park("/tmp/stop/keep.jsonl", s as unknown as AgentSession, makeManager() as unknown as SessionManager);

			const existed = await holder.stopAndRemove("/tmp/stop/other.jsonl");

			expect(existed).toBe(false);
			expect(s.abort).not.toHaveBeenCalled();
			expect(holder.has("/tmp/stop/keep.jsonl")).toBe(true);
		});

		it("survives a rejecting abort: entry is still removed", async () => {
			const holder = new DetachedSessionHolder();
			const s = makeSession();
			(s.abort as unknown as { mockRejectedValue(value: unknown): void }).mockRejectedValue(
				new Error("abort refused"),
			);
			holder.park("/tmp/stop/bad.jsonl", s as unknown as AgentSession, makeManager() as unknown as SessionManager);

			const existed = await holder.stopAndRemove("/tmp/stop/bad.jsonl");

			expect(existed).toBe(true);
			expect(holder.has("/tmp/stop/bad.jsonl")).toBe(false);
		});
	});

	describe("evictLRU rejection safety", () => {
		it("resolves and drops entries even when an evicted session's abort rejects", async () => {
			const holder = new DetachedSessionHolder();
			const bad = makeSession();
			(bad.abort as unknown as { mockRejectedValue(value: unknown): void }).mockRejectedValue(new Error("boom"));
			const good = makeSession();
			const base = Date.now();
			const spy1 = vi.spyOn(Date, "now").mockReturnValue(base);
			holder.park(
				"/tmp/evict-bad/bad.jsonl",
				bad as unknown as AgentSession,
				makeManager("bad") as unknown as SessionManager,
			);
			spy1.mockRestore();
			const spy2 = vi.spyOn(Date, "now").mockReturnValue(base + 1000);
			holder.park(
				"/tmp/evict-bad/good.jsonl",
				good as unknown as AgentSession,
				makeManager("good") as unknown as SessionManager,
			);
			spy2.mockRestore();

			const evicted = await holder.evictLRU(1);

			expect(evicted).toEqual([path.resolve("/tmp/evict-bad/bad.jsonl")]);
			expect(bad.abort).toHaveBeenCalled();
			expect(holder.has("/tmp/evict-bad/good.jsonl")).toBe(true);
		});
	});
});
