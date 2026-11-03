import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { isConclusiveProbeStatus, PlatformProbeCache } from "./utils";

afterEach(() => vi.restoreAllMocks());

test("concurrent platform probes share a verdict and retry inconclusive failures", async () => {
	const cache = new PlatformProbeCache();
	const pending = Promise.withResolvers<boolean | undefined>();
	let attempts = 0;
	const first = cache.resolve("https://example.test", () => {
		attempts++;
		return pending.promise;
	});
	const second = cache.resolve("https://example.test", async () => {
		throw new Error("duplicate probe");
	});
	pending.resolve(undefined);
	expect(await first).toBe(false);
	expect(await second).toBe(false);
	expect(
		await cache.resolve("https://example.test", async () => {
			attempts++;
			return true;
		}),
	).toBe(true);
	expect(attempts).toBe(2);
});

test("negative platform verdicts expire while positives survive and LRU remains bounded", async () => {
	let now = 0;
	spyOn(performance, "now").mockImplementation(() => now);
	const cache = new PlatformProbeCache(2);
	cache.record("negative", false);
	cache.record("positive", true);
	now = 10 * 60_000;
	expect(cache.get("negative")).toBeUndefined();
	expect(await cache.get("positive")).toBe(true);
	cache.record("next", false);
	cache.record("last", true);
	expect(cache.get("positive")).toBeUndefined();
	expect(await cache.get("last")).toBe(true);
});

test("auth, bot walls, rate limits and server failures never settle a platform probe", () => {
	for (const status of [undefined, 401, 403, 408, 429, 500, 503, 999])
		expect(isConclusiveProbeStatus(status)).toBe(false);
	expect(isConclusiveProbeStatus(404)).toBe(true);
});
