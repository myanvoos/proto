import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "./logger";

let logDir: string;

beforeEach(() => {
	logDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-bounds-"));
	logger.setTransports({ file: logDir });
});

afterAll(() => {
	logger.setTransports({ file: true });
});

function writtenLines(): string[] {
	const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"));
	expect(files.length).toBe(1);
	return fs.readFileSync(path.join(logDir, files[0]!), "utf8").split("\n").filter(Boolean);
}

describe("logger bounded serialization", () => {
	test("deeply nested context is truncated instead of producing an unbounded line", () => {
		let deep: Record<string, unknown> = { leaf: "end" };
		for (let i = 0; i < 60; i++) deep = { nested: deep };
		logger.warn("deep", { deep });
		const [line] = writtenLines();
		expect(line).toContain("[log truncated]");
		expect(line.length).toBeLessThan(50_000);
	});

	test("oversized strings and arrays are bounded", () => {
		logger.warn("huge", { blob: "x".repeat(200_000), items: Array.from({ length: 500 }, (_, i) => i) });
		const [line] = writtenLines();
		expect(line).toContain("[log truncated]");
		expect(line).toContain("[+436 more]");
		expect(line.length).toBeLessThan(50_000);
	});

	test("circular references are marked, not dropped or fatal", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		logger.info("cycle", { circular });
		const [line] = writtenLines();
		expect(line).toContain("cycle");
		expect(line).toContain("[log circular]");
	});

	test("shared non-circular references still serialize at each use site", () => {
		const shared = { x: 1 };
		logger.info("shared", { a: shared, b: shared });
		const [line] = writtenLines();
		expect(line).not.toContain("[log circular]");
		expect(line.split('"x":1').length - 1).toBe(2);
	});

	test("long Error cause chains stay bounded but keep the root message", () => {
		let cause: Error = new Error("boom");
		for (let i = 0; i < 40; i++) cause = new Error(`layer-${i}`, { cause });
		logger.error("wrapped", { error: cause });
		const [line] = writtenLines();
		// The cause chain is serialized outermost-first and cut at the depth cap; the direct
		// cause (layer-39) is the actionable one and must survive, "boom" at depth 40 must not.
		expect(line).toContain("layer-39");
		expect(line).not.toContain("boom");
		expect(line).toContain("[log truncated]");
		expect(line.length).toBeLessThan(50_000);
	});
});
