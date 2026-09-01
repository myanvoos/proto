import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { executeBash } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `bash-kernel-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-kernel-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("heredoc python routes to the kernel and state persists across bash calls", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-state-"));
	try {
		const bash = new BashTool(stubSession(dir));
		await bash.execute("set", { command: "python <<'EOF'\nprobe_state = 41\nprint('set-ok')\nEOF" });
		const second = await bash.execute("use", { command: "python3 - <<'EOF'\nprint('value', probe_state + 1)\nEOF" });
		expect(textOf(second)).toContain("value 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bash python shares the eval tool's kernel session", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-shared-"));
	try {
		const session = stubSession(dir);
		const bash = new BashTool(session);
		const evalTool = new EvalTool(session);
		const evalResult = await evalTool.execute("eval", {
			language: "py",
			code: "shared_marker = 'from-eval'",
			timeout: 60,
		});
		expect(evalResult.details?.cells?.[0]?.status).toBe("complete");
		const bashResult = await bash.execute("bash", { command: "python -c 'print(\"marker:\", shared_marker)'" });
		expect(textOf(bashResult)).toContain("marker: from-eval");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("script paths, --version, and -c with argv fall through to a real interpreter", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-script-"));
	try {
		await Bun.write(path.join(dir, "prog.py"), "import sys\nprint('argv', sys.argv[1])\n");
		const bash = new BashTool(stubSession(dir));
		expect(textOf(await bash.execute("script", { command: "python3 prog.py hello" }))).toContain("argv hello");
		expect(textOf(await bash.execute("version", { command: "python3 --version" }))).toContain("Python 3");
		expect(
			textOf(await bash.execute("argv", { command: "python3 -c 'import sys; print(sys.argv[1:])' one two" })),
		).toContain("['one', 'two']");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("routed python composes in pipelines and reports errors with real exit codes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-pipe-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const piped = await bash.execute("pipe", {
			command: "python <<'EOF' | rg -c line\nfor i in range(3):\n    print(f'line {i}')\nEOF",
		});
		expect(textOf(piped)).toContain("3");
		const failed = await bash.execute("err", { command: "python -c '1/0'; echo rc=$?" });
		expect(textOf(failed)).toContain("ZeroDivisionError");
		expect(textOf(failed)).toContain("rc=1");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("executeBash without a registered bridge falls through to real python", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-plain-"));
	try {
		const result = await executeBash("python3 -c 'import sys; print(sys.version_info.major)'", { cwd: dir });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("3");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("kernel cells honor the shell cwd and surface write events", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-write-"));
	try {
		await fs.mkdir(path.join(dir, "sub"));
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("write", {
			command: "cd sub && python <<'EOF'\nwrite('rel.txt', 'from-kernel\\n')\nprint('wrote')\nEOF",
		});
		expect(await Bun.file(path.join(dir, "sub", "rel.txt")).text()).toBe("from-kernel\n");
		expect(textOf(result)).toContain("[write");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bash timeout interrupts the cell while the kernel survives with state", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-timeout-"));
	try {
		const bash = new BashTool(stubSession(dir));
		await bash.execute("seed", { command: "python -c 'survivor = 7'" });
		const started = performance.now();
		await bash
			.execute("slow", { command: "python <<'EOF'\nimport time\ntime.sleep(120)\nEOF", timeout: 2 })
			.catch(() => undefined);
		expect(performance.now() - started).toBeLessThan(15000);
		const after = await bash.execute("check", { command: "python -c 'print(\"still\", survivor)'" });
		expect(textOf(after)).toContain("still 7");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("heredoc node routes to the JS kernel and state persists across bash calls", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-state-"));
	try {
		const bash = new BashTool(stubSession(dir));
		await bash.execute("set", { command: "node <<'EOF'\nglobalThis.jsProbe = 41;\nconsole.log('set-ok');\nEOF" });
		const second = await bash.execute("use", { command: "node -e 'console.log(\"value\", jsProbe + 1)'" });
		expect(textOf(second)).toContain("value 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bash node shares the eval tool's JS kernel session", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-shared-"));
	try {
		const session = stubSession(dir);
		const bash = new BashTool(session);
		const evalTool = new EvalTool(session);
		const evalResult = await evalTool.execute("eval", {
			language: "js",
			code: "globalThis.jsShared = 'from-eval-js'",
			timeout: 60,
		});
		expect(evalResult.details?.cells?.[0]?.status).toBe("complete");
		const bashResult = await bash.execute("bash", { command: "node -e 'console.log(\"marker:\", jsShared)'" });
		expect(textOf(bashResult)).toContain("marker: from-eval-js");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("node script paths fall through to the real node with argv", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-script-"));
	try {
		await Bun.write(path.join(dir, "prog.js"), "console.log('argv', process.argv[2]);\n");
		const bash = new BashTool(stubSession(dir));
		expect(textOf(await bash.execute("script", { command: "node prog.js hello" }))).toContain("argv hello");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("fleet python scripts execute as kernel orchestration", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-py-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const writeScript = [
			"cat > fleet://plan.py <<'EOF'",
			"results = parallel([lambda i=i: i * i for i in range(4)])",
			"write('out.txt', ','.join(str(value) for value in results) + '\\n')",
			"print('orchestrated', sum(results))",
			"EOF",
		].join("\n");
		const wrote = await bash.execute("write", { command: writeScript });
		expect(wrote.isError ?? false).toBe(false);
		expect(await Bun.file(path.join(dir, "artifacts", "fleet", "plan.py")).exists()).toBe(true);

		const run = await bash.execute("run", { command: "python fleet://plan.py" });
		expect(textOf(run)).toContain("orchestrated 14");
		expect(await Bun.file(path.join(dir, "out.txt")).text()).toBe("0,1,4,9\n");

		const after = await bash.execute("after", { command: "python -c 'print(\"kept\", results)'" });
		expect(textOf(after)).toContain("kept [0, 1, 4, 9]");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("fleet js scripts execute in the JS kernel", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-js-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const writeScript = [
			"cat > fleet://plan.mjs <<'EOF'",
			"await write('js-out.txt', 'from-node-fleet\\n');",
			"console.log('js-fleet-done');",
			"EOF",
		].join("\n");
		await bash.execute("write", { command: writeScript });
		const run = await bash.execute("run", { command: "node fleet://plan.mjs" });
		expect(textOf(run)).toContain("js-fleet-done");
		expect(await Bun.file(path.join(dir, "js-out.txt")).text()).toBe("from-node-fleet\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);
