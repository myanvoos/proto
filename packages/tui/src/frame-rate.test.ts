import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_MAX_FPS, maxFps, minFrameIntervalMs, parseMaxFps, setMaxFps } from "./frame-rate";

afterEach(() => setMaxFps(DEFAULT_MAX_FPS));

describe("frame-rate ceiling", () => {
	test("the interval follows the live ceiling", () => {
		setMaxFps(4);
		expect(maxFps()).toBe(4);
		expect(minFrameIntervalMs()).toBe(250);
		setMaxFps(DEFAULT_MAX_FPS);
		expect(minFrameIntervalMs()).toBe(1000 / DEFAULT_MAX_FPS);
	});

	test("parses whole frames per second from 1 to 120", () => {
		expect(parseMaxFps(1)).toBe(1);
		expect(parseMaxFps("30")).toBe(30);
		expect(parseMaxFps(120)).toBe(120);
		for (const value of [0, 121, 4.5, "fast", ""]) {
			expect(() => parseMaxFps(value)).toThrow();
		}
	});
});
