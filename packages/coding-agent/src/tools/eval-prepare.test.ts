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

test("assignment heredoc binds hostile payload text verbatim", async () => {
	const content = [
		`line "one" with \\backslash and \${dollar_braces} and %d and !bang`,
		"''' single triple quotes",
		'""" double triple quotes',
	].join("\n");
	const result = await runCell(
		["PAYLOAD = <<DATA", content, "DATA", 'Path("heredoc-payload.txt").write_text(PAYLOAD)'].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-payload.txt"), "utf8")).toBe(content);
	expect(result.details?.cells?.[0]?.output ?? "").toContain("heredoc PAYLOAD: bound");
});

test("empty and trailing-newline heredocs preserve delimiter-boundary semantics", async () => {
	const result = await runCell(
		[
			"EMPTY=<<END_EMPTY",
			"END_EMPTY",
			"TRAILING = << END_TRAILING",
			"line",
			"",
			"END_TRAILING",
			'Path("heredoc-empty.txt").write_text(EMPTY)',
			'Path("heredoc-trailing.txt").write_text(TRAILING)',
		].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-empty.txt"), "utf8")).toBe("");
	expect(await fs.readFile(path.join(dir, "heredoc-trailing.txt"), "utf8")).toBe("line\n");
});

test("custom delimiter closes only when alone at the header indentation", async () => {
	const content = ["alpha", "OTHER", "  FINAL", "omega"].join("\n");
	const result = await runCell(
		["COLLISION = <<FINAL", content, "FINAL\t", 'Path("heredoc-collision.txt").write_text(COLLISION)'].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-collision.txt"), "utf8")).toBe(content);
});

test("CRLF source recognizes physical heredoc lines without retaining carriage returns", async () => {
	const result = await runCell(
		["CRLF\t=\t<<\tEND", "alpha", "END\t", 'Path("heredoc-crlf.txt").write_text(CRLF)'].join("\r\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-crlf.txt"), "utf8")).toBe("alpha");
});

test("hostile payload quotes do not hide subsequent heredocs", async () => {
	const hostile = String.raw`""" hostile quote and \backslash`;
	const result = await runCell(
		[
			"FIRST = <<ONE",
			hostile,
			"ONE",
			"SECOND = <<TWO",
			`after \${literal}`,
			"TWO",
			'Path("heredoc-first.txt").write_text(FIRST)',
			'Path("heredoc-second.txt").write_text(SECOND)',
		].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-first.txt"), "utf8")).toBe(hostile);
	expect(await fs.readFile(path.join(dir, "heredoc-second.txt"), "utf8")).toBe(`after \${literal}`);
});

test("heredocs preserve Python execution position in branches and functions", async () => {
	const prepared = await runCell(
		[
			"if False:",
			"    HIDDEN = <<STOP",
			"    false branch",
			"    STOP",
			'    Path("heredoc-hidden.txt").write_text(HIDDEN)',
			"def write_later():",
			"    LATER = <<DONE",
			"      body indentation is data",
			"    DONE",
			'    Path("heredoc-deferred.txt").write_text(LATER)',
		].join("\n"),
	);
	expect(prepared.details?.cells?.[0]?.status).toBe("complete");
	expect(await Bun.file(path.join(dir, "heredoc-hidden.txt")).exists()).toBe(false);
	expect(await Bun.file(path.join(dir, "heredoc-deferred.txt")).exists()).toBe(false);

	const invoked = await runCell("write_later()");
	expect(invoked.details?.cells?.[0]?.status).toBe("complete");
	expect(await fs.readFile(path.join(dir, "heredoc-deferred.txt"), "utf8")).toBe("      body indentation is data");
});

test("unterminated heredoc reports its variable, opening line, and delimiter", async () => {
	const result = await runCell(["MISSING = <<STOP", "body", 'print("never")'].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("error");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("heredoc 'MISSING' (line 1) is never closed");
	expect(output).toContain("STOP");
});

test("heredoc replacement preserves following source line numbers", async () => {
	const result = await runCell(["VALUE = <<END", "payload", "END", 'raise RuntimeError("boom")'].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("error");
	expect(result.details?.cells?.[0]?.output ?? "").toContain('File "<cell>", line 4');
});

test("a hostile heredoc cannot expose a later fake header inside a real string", async () => {
	const result = await runCell(
		[
			"FIRST = <<ONE",
			'""" unmatched and indentation-hostile',
			`  ) % ! \${still_data}`,
			"ONE",
			'text = """',
			"FAKE = <<END",
			"must remain string data",
			"END",
			'"""',
			"SECOND = <<TWO",
			"real second payload",
			"TWO",
			"print(text, SECOND)",
		].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("FAKE = <<END");
	expect(output).toContain("must remain string data");
	expect(output).toContain("real second payload");
	expect(output).not.toContain("heredoc FAKE: bound");
});

test("heredoc-looking assignments inside outer parentheses are not transformed", async () => {
	const result = await runCell(["values = (", "    INNER = <<END", "    payload", "    END", ")"].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("error");
	expect(result.details?.cells?.[0]?.output ?? "").not.toContain("heredoc INNER: bound");
});

test("heredoc-looking declarations inside real strings stay literal", async () => {
	const result = await runCell(
		[
			'text = """',
			"FAKE = <<END",
			"not a heredoc",
			"END",
			'"""',
			'inline = "ALSO = <<TOKEN"',
			"shifted = 3 << 2",
			"print(text, inline, shifted)",
		].join("\n"),
	);
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("FAKE = <<END");
	expect(output).toContain("ALSO = <<TOKEN");
	expect(output).toContain("12");
	expect(output).not.toContain("<kernel> note: heredoc");
});

test("native bitshifts and old embed-looking comments keep ordinary Python behavior", async () => {
	const result = await runCell(["value = 5 << 3", "#@embed OLD", 'print(value, "ordinary")'].join("\n"));
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	const output = result.details?.cells?.[0]?.output ?? "";
	expect(output).toContain("40 ordinary");
	expect(output).not.toContain("<kernel> note: heredoc");
});

test("headers reject trailing comments and delimiter expressions", async () => {
	const commented = await runCell(["VALUE = <<END # comment", "body", "END"].join("\n"));
	expect(commented.details?.cells?.[0]?.status).toBe("error");
	expect(commented.details?.cells?.[0]?.output ?? "").not.toContain("never closed");

	const expression = await runCell(["VALUE = <<END.other", "body", "END"].join("\n"));
	expect(expression.details?.cells?.[0]?.status).toBe("error");
	expect(expression.details?.cells?.[0]?.output ?? "").not.toContain("never closed");
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
	const repaired = await runCell("print(“smart”)");
	expect(repaired.details?.cells?.[0]?.status).toBe("complete");
	const repairedOutput = repaired.details?.cells?.[0]?.output ?? "";
	expect(repairedOutput).toContain("smart");
	expect(repairedOutput).toContain("curly double quote");

	const untouched = await runCell('x = "café — menu"\nprint(x)');
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
	expect(result.details?.cells?.[0]?.output ?? "").toContain("raw string");
});
