import { afterEach, expect, test, vi } from "bun:test";
import { LRUCache } from "./lru";

function useClock(): (milliseconds: number) => void {
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return milliseconds => {
		now += milliseconds;
		vi.advanceTimersByTime(milliseconds);
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("eager expiry releases idle values and their accounted bytes without a lookup", () => {
	const advance = useClock();
	const disposed: string[] = [];
	const cache = new LRUCache<string, string>({
		maxSize: 100,
		sizeCalculation: value => value.length,
		ttl: 100,
		ttlAutopurge: true,
		dispose: (value, key, reason) => disposed.push(`${key}:${value}:${reason}`),
	});
	const timersBefore = vi.getTimerCount();
	cache.set("old", "retained");
	expect(vi.getTimerCount()).toBe(timersBefore + 1);
	advance(101);
	expect(vi.getTimerCount()).toBe(timersBefore);
	expect(disposed).toEqual(["old:retained:expire"]);
	expect(cache.size).toBe(0);
	expect(cache.calculatedSize).toBe(0);

	// An emptied cache can start a new sweeper on the next insertion.
	cache.set("new", "again");
	advance(101);
	expect(disposed).toEqual(["old:retained:expire", "new:again:expire"]);
	expect(cache.size).toBe(0);
});

test("idle expiry preserves accessed entries but does not refresh merely inspected entries", () => {
	const advance = useClock();
	const expired: string[] = [];
	const cache = new LRUCache<string, string>({
		max: 3,
		ttl: 100,
		ttlAutopurge: true,
		updateAgeOnGet: true,
		dispose: (_value, key, reason) => {
			if (reason === "expire") expired.push(key);
		},
	});
	const timersBefore = vi.getTimerCount();
	cache.set("hot", "hot value").set("cold", "cold value");
	expect(vi.getTimerCount()).toBe(timersBefore + 1);
	advance(60);
	expect(cache.get("hot")).toBe("hot value");
	expect(cache.peek("cold")).toBe("cold value");
	expect(cache.has("cold")).toBe(true);
	advance(60);
	expect(expired).toEqual(["cold"]);
	expect(cache.get("hot")).toBe("hot value");
	advance(101);
	expect(expired).toEqual(["cold", "hot"]);
	expect(cache.size).toBe(0);
});

test("expiry tolerates disposal clearing and repopulating the cache", () => {
	const advance = useClock();
	const cache = new LRUCache<string, string>({
		maxSize: 100,
		sizeCalculation: value => value.length,
		ttl: 100,
		ttlAutopurge: true,
		dispose: (_value, key, reason) => {
			if (key !== "first" || reason !== "expire") return;
			cache.clear();
			cache.set("second", "replacement");
		},
	});
	cache.set("first", "old").set("second", "old");
	advance(101);
	expect(cache.size).toBe(1);
	expect(cache.calculatedSize).toBe("replacement".length);
	expect(cache.get("second")).toBe("replacement");
	advance(101);
	expect(cache.size).toBe(0);
	expect(cache.calculatedSize).toBe(0);
});

test("clearing a cache cancels old expiry and a subsequent insertion still expires", () => {
	const advance = useClock();
	const reasons: string[] = [];
	const cache = new LRUCache<string, string>({
		max: 2,
		ttl: 100,
		ttlAutopurge: true,
		dispose: (_value, _key, reason) => reasons.push(reason),
	});
	const timersBefore = vi.getTimerCount();
	cache.set("first", "value");
	expect(vi.getTimerCount()).toBe(timersBefore + 1);
	cache.clear();
	expect(vi.getTimerCount()).toBe(timersBefore);
	advance(101);
	expect(reasons).toEqual(["delete"]);
	cache.set("second", "value");
	advance(101);
	expect(reasons).toEqual(["delete", "expire"]);
});

test("lazy expiry remains the default for unrelated caches", () => {
	const advance = useClock();
	const cache = new LRUCache<string, string>({ max: 1, ttl: 100 });
	cache.set("key", "value");
	advance(101);
	expect(cache.size).toBe(1);
	expect(cache.get("key")).toBeUndefined();
	expect(cache.size).toBe(0);
});

test("accounted size evicts the least recently read entry and rejects oversized replacements", () => {
	const cache = new LRUCache<string, string>({
		maxSize: 10,
		maxEntrySize: 6,
		sizeCalculation: value => value.length * 2,
	});
	cache.set("first", "aa").set("second", "bb");
	cache.get("first");
	cache.set("third", "cc");
	expect(cache.get("second")).toBeUndefined();
	expect(cache.get("first")).toBe("aa");
	expect(cache.calculatedSize).toBe(8);
	cache.set("first", "oversized");
	expect(cache.get("first")).toBeUndefined();
	expect(cache.get("third")).toBe("cc");
	expect(cache.calculatedSize).toBe(4);
});

test("eager expiry requires a finite positive TTL", () => {
	expect(() => new LRUCache({ max: 1, ttlAutopurge: true })).toThrow("ttlAutopurge requires ttl");
});
