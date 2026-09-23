import { describe, expect, it } from "bun:test";
import { extractRetryHint, fetchWithRetry, isUnexpectedSocketCloseMessage } from "./fetch-retry";

describe("extractRetryHint account reset bodies", () => {
	it.each([
		["space-separated UTC", "Your limit will reset at 2099-09-01 09:44:51", Date.UTC(2099, 8, 1, 9, 44, 51)],
		["ISO-separated UTC", "Your limit will reset at 2099-09-01T09:44:51", Date.UTC(2099, 8, 1, 9, 44, 51)],
		[
			"explicit offset",
			"Your limit will reset at 2099-09-01 09:44:51+08:00",
			Date.parse("2099-09-01T09:44:51+08:00"),
		],
		["Chinese reset wording", "将在 2099-09-01 09:44:51 重置", Date.UTC(2099, 8, 1, 9, 44, 51)],
	])("parses %s absolute reset timestamp", (_label, body, targetMs) => {
		const expected = targetMs - Date.now();
		const hint = extractRetryHint(undefined, body);

		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("parses retry-after-ms from a response body", () => {
		expect(extractRetryHint(undefined, "request blocked; retry-after-ms=98497000")).toBe(98_497_000);
	});

	it("prefers an offset-bearing account reset over a shorter retry-after-ms hint", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`);
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	it("yields a timezone-naive reset stamp to any relative hint", () => {
		const naiveWall = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19).replace("T", " ");
		expect(extractRetryHint(undefined, `Your limit will reset at ${naiveWall} retry-after-ms=5000`)).toBe(5000);
	});

	it("applies the provider timezone offset to a naive reset stamp", () => {
		const expected = Date.parse("2099-09-01T09:44:51+08:00") - Date.now();
		const hint = extractRetryHint(undefined, "您的限额将在 2099-09-01 09:44:51 重置。retry-after-ms=5000", {
			naiveResetTimezoneOffset: "+08:00",
		});
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("prefers an account reset window over a shorter generic retry hint", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes. Please retry in 12s.")).toBe(
			13 * 60_000,
		);
	});

	it("keeps the longest of every body signal", () => {
		expect(extractRetryHint(undefined, "quota exceeded. reset in 5 minutes. retry-after-ms: 3600000")).toBe(
			3_600_000,
		);
		expect(extractRetryHint(undefined, "quota exceeded. reset in 5 minutes; retry-after=3600")).toBe(3_600_000);
		expect(extractRetryHint(undefined, "quota exceeded. retry-after-ms = 7200000")).toBe(7_200_000);
	});

	it("parses OpenCode Go day and compound resets", () => {
		expect(extractRetryHint(undefined, "429 Weekly usage limit reached. Resets in 3 days.")).toBe(3 * 86_400_000);
		expect(extractRetryHint(undefined, "429 5-hour usage limit reached. Resets in 2hr 15min.")).toBe(135 * 60_000);
	});

	it("preserves explicit zero and elapsed counters as retry-now", () => {
		expect(extractRetryHint(undefined, "quota exceeded. retry-after-ms=0")).toBe(0);
		expect(extractRetryHint(undefined, `rate limited, x-ratelimit-reset=${Math.floor(Date.now() / 1000) - 60}`)).toBe(
			0,
		);
		expect(extractRetryHint(undefined, "quota exceeded. reset in 5 minutes. retry-after-ms=0")).toBe(5 * 60_000);
	});

	it("returns undefined when only an elapsed account reset is present", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(extractRetryHint(undefined, `Your limit will reset at ${past}`)).toBeUndefined();
	});
});

describe("isUnexpectedSocketCloseMessage", () => {
	it("recognizes a bare closed-socket transport error", () => {
		expect(isUnexpectedSocketCloseMessage("Socket is closed")).toBe(true);
	});

	it("does not match closed-socket wording embedded in an application error", () => {
		expect(isUnexpectedSocketCloseMessage("validation failed because socket is closed to remote control")).toBe(
			false,
		);
	});
});

describe("fetchWithRetry response body handling", () => {
	it("bounds the inspected retry body and discards the retried response", async () => {
		const oversizedBody = "x".repeat(1024 * 1024);
		const retriedResponse = new Response(oversizedBody, { status: 503 });
		let inspectedBody = "";
		let fetchCalls = 0;

		const response = await fetchWithRetry("https://example.test", {
			maxAttempts: 2,
			defaultDelayMs: 0,
			shouldRetryResponse: (_response, body) => {
				inspectedBody = body;
				return true;
			},
			fetch: async () => {
				fetchCalls++;
				return fetchCalls === 1 ? retriedResponse : new Response("ok");
			},
		});

		expect(await response.text()).toBe("ok");
		expect(inspectedBody.length).toBeLessThan(oversizedBody.length);
		expect(retriedResponse.bodyUsed).toBe(true);
	});

	it("stops retrying an endpoint that cannot be reached at all", async () => {
		let fetchCalls = 0;
		const started = Date.now();

		await expect(
			fetchWithRetry("https://example.test", {
				maxAttempts: 5,
				fetch: async () => {
					fetchCalls++;
					throw new Error("Unable to connect. Is the computer able to access the url?");
				},
			}),
		).rejects.toThrow("Unable to connect");

		// One extra attempt covers a restarting local server; the full ladder would
		// only turn a wrong base URL into a multi-second hang per request.
		expect(fetchCalls).toBe(2);
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("still uses the full attempt ladder for other network errors", async () => {
		let fetchCalls = 0;

		await expect(
			fetchWithRetry("https://example.test", {
				maxAttempts: 4,
				defaultDelayMs: 0,
				fetch: async () => {
					fetchCalls++;
					throw new Error("socket hang up");
				},
			}),
		).rejects.toThrow("socket hang up");

		expect(fetchCalls).toBe(4);
	});

	it("preserves the full body when the retry predicate declines", async () => {
		const body = "x".repeat(128 * 1024);
		const response = await fetchWithRetry("https://example.test", {
			maxAttempts: 2,
			shouldRetryResponse: () => false,
			fetch: async () => new Response(body, { status: 503 }),
		});

		expect(await response.text()).toBe(body);
	});
});
