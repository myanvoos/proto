import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const KERNEL_OWNER = `eval-prepare-test:${process.pid}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-prepare-"));

function stubSession(): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd: dir,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(dir, "artifacts"),
		getEvalSessionId: () => "eval-prepare-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function cellCommand(code: string): string {
	return `python <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function statusOf(result: { isError?: boolean }): "complete" | "error" {
	return result.isError ? "error" : "complete";
}

async function runCell(code: string) {
	return await new BashTool(stubSession()).execute("bash-kernel-prepare-test", {
		command: cellCommand(code),
		timeout: 60,
	});
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
	await fs.rm(dir, { recursive: true, force: true });
});

test("Python assignment heredocs fail before any cell statements execute", async () => {
	const result = await runCell(
		[
			'Path("unsupported-syntax.txt").write_text("must not execute")',
			"PAYLOAD = <<DATA",
			"body",
			"DATA",
			'print("must not execute")',
		].join("\n"),
	);
	expect(statusOf(result)).toBe("error");
	expect(textOf(result)).toContain("SyntaxError: invalid syntax");
	expect(textOf(result)).toContain('File "<stdin>", line 2');
	expect(await Bun.file(path.join(dir, "unsupported-syntax.txt")).exists()).toBe(false);
});

test("ordinary Python string assignments write quote-heavy payloads through shell heredocs", async () => {
	const content = [
		`line "one" with \\backslash and \${dollar_braces} and %d and !bang`,
		"''' single triple quotes",
		'""" double triple quotes',
		"",
	].join("\n");
	const result = await runCell(
		[`payload = ${JSON.stringify(content)}`, 'Path("literal-payload.txt").write_text(payload)'].join("\n"),
	);
	expect(statusOf(result)).toBe("complete");
	expect(await fs.readFile(path.join(dir, "literal-payload.txt"), "utf8")).toBe(content);
});

test("magic translation leaves multiline Python string bodies untouched", async () => {
	const content = ["%not_a_magic", "!not_a_command", "  indented text", ""].join("\n");
	const result = await runCell(
		[
			'payload = """%not_a_magic',
			"!not_a_command",
			"  indented text",
			'"""',
			'Path("multiline-payload.txt").write_text(payload)',
			"!printf translated-magic",
		].join("\n"),
	);
	expect(statusOf(result)).toBe("complete");
	expect(await fs.readFile(path.join(dir, "multiline-payload.txt"), "utf8")).toBe(content);
	expect(textOf(result)).toContain("translated-magic");
});

test("native bitshifts keep ordinary Python behavior", async () => {
	const result = await runCell("value = 5 << 3\nprint(value)");
	expect(statusOf(result)).toBe("complete");
	expect(textOf(result)).toContain("40");
});
test("markdown-wrapped cells are stripped with a disclosure note", async () => {
	const result = await runCell(["```python", "print('fenced-marker')", "```"].join("\n"));
	expect(statusOf(result)).toBe("complete");
	const output = textOf(result);
	expect(output).toContain("fenced-marker");
	expect(output).toContain("<kernel> note:");
	expect(output).toContain("markdown code fence");
});

test("smart quotes are normalized with disclosure only when the cell fails to parse", async () => {
	const repaired = await runCell("print(“smart”)");
	expect(statusOf(repaired)).toBe("complete");
	const repairedOutput = textOf(repaired);
	expect(repairedOutput).toContain("smart");
	expect(repairedOutput).toContain("curly double quote");

	const untouched = await runCell('x = "café — menu"\nprint(x)');
	expect(statusOf(untouched)).toBe("complete");
	const untouchedOutput = textOf(untouched);
	expect(untouchedOutput).toContain("café — menu");
	expect(untouchedOutput).not.toContain("<kernel> note:");
});

test("unterminated triple-quoted string reports the opening line", async () => {
	const result = await runCell(['text = """first', "still inside", 'print("never")'].join("\n"));
	expect(statusOf(result)).toBe("error");
	const output = textOf(result);
	expect(output).toContain("never closed");
	expect(output).toContain("line 1");
});

test("invalid escape in string literal suggests a raw string", async () => {
	const result = await runCell('p = "C:\\Users\\x"');
	expect(statusOf(result)).toBe("error");
	expect(textOf(result)).toContain("raw string");
});
