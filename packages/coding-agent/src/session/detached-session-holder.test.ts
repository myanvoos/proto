import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { DetachedSessionHolder, detachedSessionHolder } from "./detached-session-holder";

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

	test("disposeAll aborts and disposes every parked session", async () => {
		const holder = new DetachedSessionHolder();
		const run = crypto.randomUUID();
		const aCalls: string[] = [];
		const bCalls: string[] = [];
		holder.park(`${run}-a.jsonl`, fakeSession(aCalls), fakeManager());
		holder.park(`${run}-b.jsonl`, fakeSession(bCalls), fakeManager());

		await holder.disposeAll();

		expect(aCalls).toEqual(["abort", "dispose"]);
		expect(bCalls).toEqual(["abort", "dispose"]);
		expect(holder.size()).toBe(0);
	});

	test("stopAndRemove disposes a parked session instead of only aborting it", async () => {
		const holder = new DetachedSessionHolder();
		const file = `${crypto.randomUUID()}.jsonl`;
		const calls: string[] = [];
		holder.park(file, fakeSession(calls), fakeManager());

		expect(await holder.stopAndRemove(file)).toBe(true);

		expect(calls).toEqual(["abort", "dispose"]);
		expect(holder.size()).toBe(0);
	});
});
