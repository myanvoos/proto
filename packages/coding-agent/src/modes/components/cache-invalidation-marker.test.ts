import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { detectCacheInvalidation } from "./cache-invalidation-marker";

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn or a predecessor that only wrote the cache", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 }))).toBeUndefined();
	});

	it("flags a cacheRead collapse after a warm turn and reports reprocessed tokens", () => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 50_999 });
	});

	it("flags a collapse that still reads the system block other sessions keep warm", () => {
		// Observed after an idle gap: concurrent sessions on the same system prompt
		// kept its ~15k-token block warm, so the request read that back while
		// re-writing the expired 364k-token history behind it.
		const prev = usage({ cacheRead: 369_518, cacheWrite: 1_983, input: 1 });
		const current = usage({ cacheRead: 15_282, cacheWrite: 364_343, input: 3 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 364_346 });
	});

	it("does not flag a turn that read back at least half of the warm prefix", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 }))).toBeUndefined();
		// Expiry behind a predecessor that read only the shared system block.
		const shared = usage({ cacheRead: 15_282, cacheWrite: 35_000, input: 4 });
		expect(
			detectCacheInvalidation(shared, usage({ cacheRead: 15_282, cacheWrite: 36_100, input: 2 })),
		).toBeUndefined();
	});

	it("does not flag implicit best-effort caches that report no cacheWrite", () => {
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});
});
