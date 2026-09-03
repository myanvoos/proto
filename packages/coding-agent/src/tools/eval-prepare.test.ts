import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-prepare-test:${process.pid}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-prepare-"));

function stubSession(): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd: dir,
		settings: {
			get: (key: string) => settings.get(key),
		},
		getEvalSessionId: () => "eval-prepare-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

async function runCell(code: string) {
	const tool = new EvalTool(stubSession());
	return await tool.execute("eval-prepare-test", {
		language: "py",
		code,
		title: "preprocessing",
		timeout: 60,
	});
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
	await fs.rm(dir, { recursive: true, force: true });
});

test("#@embed block binds content verbatim without any escaping", async () => {
	const result = await runCell(
		["#@embed TXT", 'line "one" with \\backslash and %d and !bang', '""" triple quotes', "#@end", "print(TXT)"].join(
			"\n",
		),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain('line "one" with \\backslash and %d and !bang');
	expect(output).toContain('""" triple quotes');
	expect(output).toContain("#@embed TXT: bound");
});

test("#@embed with until= terminator round-trips content containing #@end through write()", async () => {
	const content = ["alpha", "#@end", 'beta "quoted" \\backslash %magic !shell'].join("\n");
	const result = await runCell(
		[
			"#@embed TXT until=EOF_EMBED",
			content,
			"EOF_EMBED",
			'open("embed-roundtrip.txt", "w").write(TXT)',
			"print(len(TXT))",
		].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const written = await fs.readFile(path.join(dir, "embed-roundtrip.txt"), "utf8");
	expect(written).toBe(content);
});

test("unterminated #@embed fails naming the opening line", async () => {
	const result = await runCell(["#@embed X", "print('after')"].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("error");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("#@embed 'X' (line 1) is never closed");
	expect(output).toContain("#@end");
});

test("markdown-wrapped cells are stripped with a disclosure note", async () => {
	const result = await runCell(["```python", "print('fenced-marker')", "```"].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("fenced-marker");
	expect(output).toContain("<kernel> note:");
	expect(output).toContain("markdown code fence");
});

test("smart quotes are normalized with disclosure only when the cell fails to parse", async () => {
	const repaired = await runCell("print(\u201csmart\u201d)");
	expect(repaired.details?.cells?.[0]?.status).toBe("complete");
	const repairedOutput = repaired.details?.cells?.[0]?.output ?? "";
	expect(repairedOutput).toContain("smart");
	expect(repairedOutput).toContain("curly double quote");

	const untouched = await runCell('x = "caf\u00e9 \u2014 menu"\nprint(x)');
	expect(untouched.details?.cells?.[0]?.status).toBe("complete");
	const untouchedOutput = untouched.details?.cells?.[0]?.output ?? "";
	expect(untouchedOutput).toContain("café — menu");
	expect(untouchedOutput).not.toContain("<kernel> note:");
});

test("unterminated triple-quoted string reports the opening line", async () => {
	const result = await runCell(['text = """first', "still inside", 'print("never")'].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("error");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("never closed");
	expect(output).toContain("line 1");
});

test("invalid escape in string literal suggests a raw string", async () => {
	const result = await runCell('p = "C:\\Users\\x"');
	expect(result.details?.cells?.[0]?.status).toBe("error");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("raw string");
});
