import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../sdk";
import { executeJsonQuery, parseJsonSelector, resolveJsonReadPath } from "./read-json";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(content: string, name = "data.json") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-json-test-"));
	roots.push(root);
	const file = path.join(root, name);
	await Bun.write(file, content);
	return { root, file };
}

test("JSON modifiers use identity and preserve literal plus operators", async () => {
	const { file } = await fixture('{"a":2,"b":3}');
	expect(await executeJsonQuery(file, parseJsonSelector("q=.a+.b")!)).toBe("5");
	expect(await executeJsonQuery(file, parseJsonSelector("compact=true")!)).toBe('{"a":2,"b":3}');
	expect(parseJsonSelector("q=")?.query).toBe(".");
	expect(parseJsonSelector("unknown=true")).toBeNull();
});

test("JSON pages single arrays as arrays and result streams as values", async () => {
	const { file } = await fixture("[0,1,2,3,4]");
	expect(await executeJsonQuery(file, parseJsonSelector("compact=true&limit=2&offset=1")!)).toBe(
		"[1,2]\n[2 more items; append ?q=.&compact=true&limit=2&offset=3 to continue]",
	);
	const stream = await executeJsonQuery(file, parseJsonSelector("q=.[]&raw=true&limit=2&offset=1")!);
	expect(stream).toStartWith("1\n2\n[more results;");
	expect(await executeJsonQuery(file, parseJsonSelector("q=.[]&limit=2&offset=9")!)).toContain(
		"offset 9 is past the last result (5 total)",
	);
});

test("JSON query admission accepts JSON-looking extensionless files but leaves media alone", async () => {
	const { root, file } = await fixture(' \n {"value":1}', "response");
	const session = { cwd: root } as ToolSession;
	expect((await resolveJsonReadPath(session, `${file}?q=.value`, new Map()))?.absolutePath).toBe(file);
	await Bun.write(path.join(root, "image.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
	expect(await resolveJsonReadPath(session, "image.png?q=describe", new Map())).toBeNull();
	await Bun.write(path.join(root, "text.txt"), "ordinary text");
	expect(await resolveJsonReadPath(session, "text.txt?q=.", new Map())).toBeNull();
});

test("JSONL debug diagnostics stay visible beside successful values without terminal escapes", async () => {
	const { file } = await fixture('{"x":1}\n{"x":3}\n', "data.jsonl");
	const result = await executeJsonQuery(file, parseJsonSelector("q=.x|debug&compact=true")!);
	expect(result).toContain("jq stderr:");
	expect(result).toContain("1\n3");
	expect(result).not.toContain("\u001b");
});

test("large jq error values preserve the diagnostic reason", async () => {
	const { file } = await fixture(JSON.stringify({ value: "x".repeat(20_000) }));
	await expect(executeJsonQuery(file, parseJsonSelector("q=.value[]")!)).rejects.toThrow(/iterate|Cannot|cannot/);
});
