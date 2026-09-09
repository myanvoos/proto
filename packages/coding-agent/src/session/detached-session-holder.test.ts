import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { detachedSessionHolder } from "./detached-session-holder";

function fakeSession(calls: string[]) {
	return {
		abort: async () => {
			calls.push("abort");
		},
		dispose: async () => {
			calls.push("dispose");
		},
	} as unknown as import("./agent-session").AgentSession;
}

function fakeManager() {
	return {} as unknown as import("./session-manager").SessionManager;
}

describe("DetachedSessionHolder eviction", () => {
	test("evictLRU aborts and fully disposes evicted sessions, keeping recent ones", async () => {
		const run = crypto.randomUUID();
		const aCalls: string[] = [];
		const bCalls: string[] = [];
		const cCalls: string[] = [];
		const a = `${run}-a.jsonl`;
		const b = `${run}-b.jsonl`;
		const c = `${run}-c.jsonl`;
		detachedSessionHolder.park(a, fakeSession(aCalls), fakeManager());
		detachedSessionHolder.park(b, fakeSession(bCalls), fakeManager());
		detachedSessionHolder.park(c, fakeSession(cCalls), fakeManager());
		detachedSessionHolder.touch(c);

		const evicted = await detachedSessionHolder.evictLRU(1);

		expect(evicted.sort()).toEqual([path.resolve(a), path.resolve(b)].sort());
		expect(aCalls).toEqual(["abort", "dispose"]);
		expect(bCalls).toEqual(["abort", "dispose"]);
		expect(cCalls).toEqual([]);
		expect(detachedSessionHolder.has(c)).toBe(true);
		detachedSessionHolder.delete(c);
	});
});
