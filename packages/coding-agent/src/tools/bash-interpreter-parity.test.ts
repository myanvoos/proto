import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");

interface Program {
	name: string;
	code: string;
	args?: string[];
	input?: string;
}

const pythonPrograms: Program[] = [
	{ name: "asyncio.run", code: "import asyncio\nasync def main(): return 42\nprint(asyncio.run(main()))" },
	{
		name: "main module identity",
		code: "import pickle, __main__\ndef square(x): return x*x\nprint(__main__.square is square, pickle.loads(pickle.dumps(square))(7))",
	},
	{
		name: "program argv",
		code: "import sys, json; print(json.dumps(sys.argv))",
		args: ["space value", "--flag", "λ"],
	},
	{ name: "stdin descriptor", code: "import sys; print(sys.stdin.fileno())" },
	{ name: "descriptor input", code: "import os; print(os.read(0, 5))", input: "hello" },
	{
		name: "inherited subprocess stdin",
		code: "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'import sys; print(sys.stdin.read().upper())'], check=True)",
		input: "hello",
	},
	{ name: "binary write result", code: "import sys; sys.stdout.buffer.write(bytes([0, 255, 65]))" },
	{ name: "both program streams", code: "import sys; print('out'); print('err', file=sys.stderr)" },
	{ name: "file receipt isolation", code: "from pathlib import Path\nPath('side-effect.txt').write_text('written')" },
	{ name: "exit status", code: "import sys; sys.exit(7)" },
];

const jsPrograms: Program[] = [
	{
		name: "const assignment",
		code: 'const fixed = 1; try { eval("fixed = 2") } catch (error) { console.log(error.name) }',
	},
	{
		name: "temporal dead zone",
		code: "try { console.log(typeof later) } catch (error) { console.log(error.name) }; let later = 1;",
	},
	{
		name: "class temporal dead zone",
		code: "try { console.log(typeof LaterClass) } catch (error) { console.log(error.name) }; class LaterClass {}",
	},
	{ name: "program argv", code: "console.log(JSON.stringify(process.argv))", args: ["space value", "--flag", "λ"] },
	{ name: "binary write result", code: "process.stdout.write(Buffer.from([0, 255, 65]))" },
	{ name: "both program streams", code: 'console.log("out"); console.error("err")' },
	{ name: "referenced callback completion", code: 'setImmediate(() => console.log("callback")); console.log("body")' },
	{ name: "file receipt isolation", code: 'require("node:fs").writeFileSync("side-effect.txt", "written")' },
	{ name: "exit status", code: "process.exit(7)" },
];

for (const language of ["python3", "node", "bun"] as const) {
	const interpreter = Bun.which(language);
	test.skipIf(!interpreter)(
		`${language} cells preserve native program bytes, argv, effects and status`,
		async () => {
			using dir = TempDir.createSync("@kernel-interpreter-parity-");
			const owner = `native-parity:${crypto.randomUUID()}`;
			const settings = new Map<string, unknown>();
			const session = {
				cwd: dir.path(),
				settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
				getArtifactsDir: () => path.join(dir.path(), "artifacts"),
				getSessionId: () => owner,
				getEvalSessionId: () => owner,
				getEvalKernelOwnerId: () => owner,
			} as unknown as ToolSession;
			const bash = new BashTool(session);
			const flag = language === "python3" ? "-c" : "-e";
			try {
				for (const [index, program] of (language === "python3" ? pythonPrograms : jsPrograms).entries()) {
					const nativeCwd = path.join(dir.path(), `native-${index}`);
					const kernelCwd = path.join(dir.path(), `kernel-${index}`);
					await fs.mkdir(nativeCwd);
					await fs.mkdir(kernelCwd);
					const native = Bun.spawn([interpreter!, flag, program.code, ...(program.args ?? [])], {
						cwd: nativeCwd,
						stdin: program.input === undefined ? "ignore" : new TextEncoder().encode(program.input),
						stdout: "pipe",
						stderr: "pipe",
					});
					const [nativeExit, stdout, stderr] = await Promise.all([
						native.exited,
						new Response(native.stdout).arrayBuffer(),
						new Response(native.stderr).arrayBuffer(),
					]);
					const command = `${program.input === undefined ? "" : `printf %s ${quote(program.input)} | `}${language} ${flag} ${quote(program.code)} ${(program.args ?? []).map(quote).join(" ")} > program.out 2> program.err`;
					const result = await bash.execute(`parity:${program.name}`, { command, cwd: kernelCwd, timeout: 30 });
					expect(result.details?.execution?.exitCode, program.name).toBe(nativeExit);
					expect(
						Buffer.from(await fs.readFile(path.join(kernelCwd, "program.out"))),
						`${program.name}: stdout`,
					).toEqual(Buffer.from(stdout));
					expect(
						Buffer.from(await fs.readFile(path.join(kernelCwd, "program.err"))),
						`${program.name}: stderr`,
					).toEqual(Buffer.from(stderr));
					expect(
						result.details?.execution?.stages?.some(
							stage => stage.route === (language === "python3" ? "py" : language),
						),
						`${program.name}: kernel route`,
					).toBe(true);
					if (program.name === "file receipt isolation") {
						expect(await fs.readFile(path.join(kernelCwd, "side-effect.txt"), "utf8")).toBe(
							await fs.readFile(path.join(nativeCwd, "side-effect.txt"), "utf8"),
						);
						expect(textOf(result)).toContain("<kernel> note:");
					}
				}
			} finally {
				await Promise.all([
					disposeBashSessions(owner),
					disposeKernelSessionsByOwner(owner),
					disposeVmContextsByOwner(owner),
				]);
			}
		},
		120_000,
	);
}

test("kernel displays stay outside pipes, substitutions and merged redirections", async () => {
	using dir = TempDir.createSync("@kernel-display-sideband-");
	const owner = `display-sideband:${crypto.randomUUID()}`;
	const settings = new Map<string, unknown>();
	const bash = new BashTool({
		cwd: dir.path(),
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(dir.path(), "artifacts"),
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession);
	try {
		for (const [language, flag, source] of [
			["python3", "-c", 'print("payload"); display("visible-only"); 42'],
			["node", "-e", 'console.log("payload"); display("visible-only"); 42'],
			["bun", "-e", 'console.log("payload"); display("visible-only"); 42'],
		]) {
			const command = `${language} ${flag} ${quote(source)}`;
			const pipeline = await bash.execute("pipe", { command: `${command} 2>&1 | cat > ${language}.out` });
			expect(pipeline.details?.execution?.exitCode).toBe(0);
			expect(await fs.readFile(path.join(dir.path(), `${language}.out`), "utf8")).toBe("payload\n");
			expect(textOf(pipeline)).toContain("visible-only");
			expect(textOf(pipeline)).toContain("42");
			const substitution = await bash.execute("substitution", {
				command: `value=$(${command}); printf '<%s>' "$value" > ${language}.sub`,
			});
			expect(substitution.details?.execution?.exitCode).toBe(0);
			expect(await fs.readFile(path.join(dir.path(), `${language}.sub`), "utf8")).toBe("<payload>");
			expect(textOf(substitution)).toContain("visible-only");
		}
	} finally {
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
	}
});
