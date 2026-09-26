import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// The JS prelude's symbols()/blockRange() mirror Python's symbols()/block_range() through the
// host tree-sitter bridge; node (real Node.js) and bun cells must agree with the Python kernel.
const KERNEL_OWNER = `bash-kernel-js-helpers-test:${process.pid}`;
const JS_INTERPRETERS = ["node", "bun"] as const;

// Method body (lines 5-9) is long enough to fold; the kept last line is indented.
const SHAPE_PY = [
	"class C:",
	"    def __init__(self, r):",
	"        self.r = r",
	"    def area(self):",
	"        a = 1",
	"        b = 2",
	"        c = 3",
	"        d = 4",
	"        return a",
	"",
].join("\n");

let dir = "";
let tool: BashTool;

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-kernel-js-helpers-"));
	tool = new BashTool({
		cwd: dir,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(dir, "artifacts"),
		getEvalSessionId: () => `bash-kernel-js-helpers-test:${dir}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession);
	await Bun.write(path.join(dir, "shape.py"), SHAPE_PY);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function runCell(interpreter: string, code: string): Promise<string> {
	const result = await tool.execute("bash-kernel-js-helpers-test", {
		command: `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`,
		timeout: 60,
	});
	const output = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	expect(result.isError, output).not.toBe(true);
	return output.replace(/\s*Wall time: [\d.]+ seconds\s*$/, "").trimEnd();
}

test("symbols() outlines a file identically in python, node and bun, keeping indentation of folded bodies", async () => {
	const expected = [
		"1-5: class C:",
		"    def __init__(self, r):",
		"        self.r = r",
		"    def area(self):",
		"        a = 1",
		"6-8: <elided>",
		"9-9:         return a",
	].join("\n");
	expect(await runCell("python", 'print(symbols("shape.py"))')).toBe(expected);
	for (const interpreter of JS_INTERPRETERS) {
		expect(await runCell(interpreter, 'print(await symbols("shape.py"))')).toBe(expected);
		// In-memory code with an explicit lang outlines the same as the file on disk.
		expect(
			await runCell(
				interpreter,
				`print(await symbols(undefined, { code: ${JSON.stringify(SHAPE_PY)}, lang: "python" }))`,
			),
		).toBe(expected);
	}
});

test("symbols() reports no outline instead of echoing unparsed source", async () => {
	await Bun.write(path.join(dir, "notes.txt"), "hello\nworld\n");
	const notes = `<no symbols parsed for ${path.join(dir, "notes.txt")}>`;
	const source = "def g():\n    pass\n";

	expect(await runCell("python", `print(symbols(code=${JSON.stringify(source)}))\nprint(symbols("notes.txt"))`)).toBe(
		`<no symbols parsed for <code> (pass lang=, e.g. lang="python")>\n${notes}`,
	);
	for (const interpreter of JS_INTERPRETERS) {
		expect(
			await runCell(
				interpreter,
				`print(await symbols({ code: ${JSON.stringify(source)} }))\nprint(await symbols("notes.txt"))`,
			),
		).toBe(`<no symbols parsed for <code> (pass { lang }, e.g. { lang: "ts" })>\n${notes}`);
	}
});

test("JS symbols() rejects ambiguous or malformed arguments", async () => {
	const cell = [
		'for (const args of [["shape.py", { code: "x" }], [], [undefined, { code: 42 }], ["shape.py", "python"]]) {',
		"  try { print(await symbols(...args)); } catch (err) { print(err.name, err.message); }",
		"}",
	].join("\n");
	for (const interpreter of JS_INTERPRETERS) {
		expect(await runCell(interpreter, cell)).toBe(
			[
				"TypeError symbols() takes exactly one of a path or { code }",
				"TypeError symbols() takes exactly one of a path or { code }",
				"TypeError symbols() code must be a string, got number",
				"TypeError symbols() options must be a plain object like { code, lang }",
			].join("\n"),
		);
	}
});

test("blockRange() returns the enclosing block like block_range(), null past EOF, and resolves local://", async () => {
	await Bun.write(path.join(dir, "artifacts", "local", "shape.py"), SHAPE_PY);
	expect(await runCell("python", 'print(block_range("shape.py", 2), block_range("shape.py", 99))')).toBe(
		"(2, 3) None",
	);
	const cell = [
		'print(JSON.stringify([await blockRange("shape.py", 2), await blockRange("shape.py", 99), await blockRange("local://shape.py", 4)]))',
		'try { await blockRange("shape.py", 0); } catch (err) { print(err.name, err.message); }',
	].join("\n");
	for (const interpreter of JS_INTERPRETERS) {
		expect(await runCell(interpreter, cell)).toBe(
			"[[2,3],null,[4,9]]\nRangeError blockRange() line must be an integer >= 1, got 0",
		);
	}
});
