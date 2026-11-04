import { afterAll, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const KERNEL_OWNER = `eval-prepare-test:${process.pid}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-prepare-"));

const python = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });

function stubSession(): ToolSession {
	if (!python.pythonPath) throw new Error("Python interpreter unavailable");
	const bin = path.join(dir, "test-bin");
	fsSync.mkdirSync(bin, { recursive: true });
	for (const name of ["python", "python3"]) {
		try {
			fsSync.symlinkSync(python.pythonPath, path.join(bin, name));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	const settings = new Map<string, unknown>();
	return {
		cwd: dir,
		settings: {
			get: (key: string) => settings.get(key),
			getShellConfig: () => ({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` } }),
		},
		getArtifactsDir: () => path.join(dir, "artifacts"),
		getEvalSessionId: () => "eval-prepare-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function cellCommand(code: string): string {
	return `${JSON.stringify(python.pythonPath)} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function statusOf(result: { details?: { execution?: { exitCode?: number } } }): "complete" | "error" {
	return result.details?.execution?.exitCode === 0 ? "complete" : "error";
}

async function runCell(code: string) {
	return await new BashTool(stubSession()).execute("bash-kernel-prepare-test", {
		command: cellCommand(code),
		env: { PATH: `${path.join(dir, "test-bin")}:${process.env.PATH ?? ""}` },
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
	expect(statusOf(result), textOf(result)).toBe("error");
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
		[
			"from pathlib import Path",
			`payload = ${JSON.stringify(content)}`,
			'Path("literal-payload.txt").write_text(payload)',
		].join("\n"),
	);
	expect(statusOf(result), textOf(result)).toBe("complete");
	expect(await fs.readFile(path.join(dir, "literal-payload.txt"), "utf8")).toBe(content);
});

test("native Python preserves magic-looking lines inside multiline string bodies", async () => {
	const content = ["%not_a_magic", "!not_a_command", "  indented text", ""].join("\n");
	const result = await runCell(
		[
			"from pathlib import Path",
			'payload = """%not_a_magic',
			"!not_a_command",
			"  indented text",
			'"""',
			'Path("multiline-payload.txt").write_text(payload)',
			'print("native-marker")',
		].join("\n"),
	);
	expect(statusOf(result), textOf(result)).toBe("complete");
	expect(await fs.readFile(path.join(dir, "multiline-payload.txt"), "utf8")).toBe(content);
	expect(textOf(result)).toContain("native-marker");
});

test("native bitshifts keep ordinary Python behavior", async () => {
	const result = await runCell("value = 5 << 3\nprint(value)");
	expect(statusOf(result), textOf(result)).toBe("complete");
	expect(textOf(result)).toContain("40");
});
test.each([
	["markdown code fences", ["```python", "print('fenced-marker')", "```"].join("\n")],
	["smart quotes", "print(“smart”)"],
	["shell magic", "!printf shell-marker"],
	["line magic", "%time print(42)"],
	["cell magic", "%%capture captured\nprint(42)"],
])("native Python rejects %s without rewriting source", async (_label, code) => {
	const result = await runCell(code);
	expect(statusOf(result), textOf(result)).toBe("error");
	expect(textOf(result)).toContain("SyntaxError");
	expect(textOf(result)).not.toContain("<kernel> note:");
});

test("native Python preserves Unicode punctuation inside valid strings", async () => {
	const result = await runCell('x = "café — menu"\nprint(x)');
	expect(statusOf(result), textOf(result)).toBe("complete");
	expect(textOf(result)).toContain("café — menu");
});

test("unterminated triple-quoted string reports the opening line", async () => {
	const result = await runCell(['text = """first', "still inside", 'print("never")'].join("\n"));
	expect(statusOf(result), textOf(result)).toBe("error");
	const output = textOf(result);
	expect(output).toMatch(/unterminated triple-quoted string|EOF while scanning triple-quoted string/);
	expect(output).toContain("line 1");
});

test("invalid Unicode escape reports the native decoder error", async () => {
	const result = await runCell('p = "C:\\Users\\x"');
	expect(statusOf(result), textOf(result)).toBe("error");
	expect(textOf(result)).toContain("unicodeescape");
});
