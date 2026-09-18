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

	it("prefers an absolute account reset over a shorter retry-after-ms hint", () => {
		const targetMs = Date.UTC(2099, 8, 1, 9, 44, 51);
		const expected = targetMs - Date.now();
		const hint = extractRetryHint(undefined, "Your limit will reset at 2099-09-01 09:44:51; retry-after-ms=5000");

		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("prefers an account reset window over a shorter generic retry hint", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes. Please retry in 12s.")).toBe(
			13 * 60_000,
		);
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
