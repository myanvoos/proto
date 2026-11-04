import { afterEach, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { disposeBashSessions, executeBash } from "../exec/bash-executor";
import { convertToLlm } from "../session/messages";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

const owners = new Map<string, string>();

const python = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });

function stubSession(cwd: string): ToolSession {
	if (!python.pythonPath) throw new Error("Python interpreter unavailable");
	const bin = path.join(cwd, "test-bin");
	fsSync.mkdirSync(bin, { recursive: true });
	for (const name of ["python", "python3"]) {
		try {
			fsSync.symlinkSync(python.pythonPath, path.join(bin, name));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	const owner = owners.get(cwd) ?? `bash-kernel-test:${crypto.randomUUID()}`;
	owners.set(cwd, owner);
	const settings = new Map<string, unknown>();
	const tools = new Map<string, BashTool | ReadTool>();
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
		settings: {
			get: (key: string) => settings.get(key),
			getShellConfig: () => ({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` } }),
		},
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionId: () => owner,
		getEvalSessionId: () => `bash-kernel-test:${cwd}`,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	return session;
}

async function makeBash(cwd: string): Promise<BashTool> {
	const bash = new BashTool(stubSession(cwd));
	const selected = await bash.execute("select-native-python", {
		command: `export PATH=${JSON.stringify(path.join(cwd, "test-bin"))}:$PATH`,
	});
	expect(selected.isError).not.toBe(true);
	return bash;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

afterEach(async () => {
	for (const owner of owners.values()) {
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
	}
	owners.clear();
});

test("explicit named Python kernel persists across heredoc and code calls", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-state-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("set", {
			command: "python -m proto_harness.kernel main <<'EOF'\nprobe_state = 41\nprint('set-ok')\nEOF",
		});
		const second = await bash.execute("use", {
			command: "python3 -m proto_harness.kernel main <<'EOF'\nprint('value', probe_state + 1)\nEOF",
		});
		expect(textOf(second)).toContain("value 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("explicit named Python kernel accepts heredoc and code invocations", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-shared-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("seed", {
			command: "python -m proto_harness.kernel main <<'EOF'\nshared_marker = 'from-heredoc'\nEOF",
		});
		const bashResult = await bash.execute("bash", {
			command: "python -m proto_harness.kernel main -c 'print(\"marker:\", shared_marker)'",
		});
		expect(textOf(bashResult)).toContain("marker: from-heredoc");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("script paths and --version stay native while -c preserves program argv", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-script-"));
	try {
		await Bun.write(path.join(dir, "prog.py"), "import sys\nprint('argv', sys.argv[1])\n");
		const bash = await makeBash(dir);
		expect(textOf(await bash.execute("script", { command: "python3 prog.py hello" }))).toContain("argv hello");
		expect(textOf(await bash.execute("version", { command: "python3 --version" }))).toContain("Python 3");
		expect(
			textOf(await bash.execute("argv", { command: "python3 -c 'import sys; print(sys.argv[1:])' one two" })),
		).toContain("['one', 'two']");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("native command resolution does not alias missing python to python3", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-py3only-"));
	try {
		const realPython3 = Bun.which("python3");
		if (!realPython3) return;
		const bin = path.join(dir, "bin");
		await fs.mkdir(bin);
		await fs.symlink(realPython3, path.join(bin, "python3"));
		await Bun.write(path.join(dir, "prog.py"), "import sys\nprint('argv', sys.argv[1])\n");
		const bash = await makeBash(dir);
		const ran = await bash.execute("py3only", {
			command: `(export PATH=${JSON.stringify(bin)}; python3 prog.py hello; echo rc=$?)`,
		});
		expect(textOf(ran)).toContain("argv hello");
		expect(textOf(ran)).toContain("rc=0");
		const unaliased = await bash.execute("unaliased", {
			command: `(export PATH=${JSON.stringify(bin)}; python prog.py hello; echo rc=$?)`,
		});
		expect(textOf(unaliased)).toContain("command not found: python");
		expect(textOf(unaliased)).toContain("rc=127");
		const empty = path.join(dir, "empty");
		await fs.mkdir(empty);
		const missing = await bash.execute("none", {
			command: `(export PATH=${JSON.stringify(empty)}; python prog.py hello; echo rc=$?)`,
		});
		expect(textOf(missing)).toContain("command not found: python");
		expect(textOf(missing)).toContain("rc=127");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("routed python composes in pipelines and reports errors with real exit codes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-pipe-"));
	try {
		const bash = await makeBash(dir);
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

test("a piped or redirected `-c` reads the caller's stdin instead of the kernel's", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-stdin-"));
	try {
		const bash = await makeBash(dir);
		// Program bytes must be isolated from the kernel's long-lived control pipe:
		// reading stdin must neither consume protocol frames nor wait for kernel exit.
		const piped = await bash.execute("consume", {
			command: `printf '{"a":1}' | python3 -c 'import json,sys; print("parsed", json.load(sys.stdin)["a"])'`,
		});
		expect(textOf(piped)).toContain("parsed 1");

		await Bun.write(path.join(dir, "in.json"), '{"a":7}');
		const redirected = await bash.execute("redirect", {
			command: `python3 -c 'import json,sys; print("parsed", json.load(sys.stdin)["a"])' < in.json`,
		});
		expect(textOf(redirected)).toContain("parsed 7");

		// Ordinary `-c` is fresh regardless of whether stdin was supplied.
		await bash.execute("set", { command: "python3 -c 'STDIN_GUARD_MARKER = 4242'" });
		expect(
			textOf(await bash.execute("get", { command: "python3 -c 'print(\"STDIN_GUARD_MARKER\" not in globals())'" })),
		).toContain("True");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a kernel cell stops as soon as its pipeline consumer exits", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-sigpipe-"));
	try {
		const bash = await makeBash(dir);
		const started = Date.now();
		const result = await bash.execute("early-close", {
			command: "python3 -c 'for i in range(2000000): print(i)' | head -1",
		});
		const elapsed = Date.now() - started;
		expect(textOf(result)).toContain("0");
		// A real interpreter dies on SIGPIPE here. The cell runs in the kernel process,
		// which never saw the broken pipe, so it used to run the whole loop (~20s) and
		// burn the command deadline after `head` had already taken its one line.
		expect(elapsed).toBeLessThan(5_000);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("large kernel output reaches shell pipeline consumers without quadratic frame parsing", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-large-pipe-"));
	try {
		const result = await (await makeBash(dir)).execute("large-pipe", {
			command: "node -e 'console.log(\"ü\".repeat(8 * 1024 * 1024))' | wc -c",
			timeout: 10,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result).split("\n", 1)[0]?.trim()).toBe("16777217");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

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

test("explicit Python filesystem operations honor shell cwd and surface mutation events", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-write-"));
	try {
		await fs.mkdir(path.join(dir, "sub"));
		const bash = await makeBash(dir);
		const result = await bash.execute("write", {
			command:
				"cd sub && python <<'EOF'\nimport proto_harness as harness\nharness.fs.write_text('rel.txt', 'from-kernel\\n')\nprint('wrote')\nEOF",
		});
		expect(await Bun.file(path.join(dir, "sub", "rel.txt")).text()).toBe("from-kernel\n");
		const writes = (result.details?.statusEvents ?? []).filter(event => event.op === "write");
		expect(writes.length, "write event surfaced as structured status, not stdout text").toBe(1);
		expect(textOf(result)).not.toContain("[write");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bash timeout interrupts the cell while the kernel survives with state", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-timeout-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("seed", { command: "python -m proto_harness.kernel main -c 'survivor = 7'" });
		const started = performance.now();
		await bash
			.execute("slow", {
				command: "python -m proto_harness.kernel main <<'EOF'\nimport time\ntime.sleep(120)\nEOF",
				timeout: 2,
			})
			.catch(() => undefined);
		expect(performance.now() - started).toBeLessThan(15000);
		const after = await bash.execute("check", {
			command: `${JSON.stringify(python.pythonPath)} -m proto_harness.kernel main -c 'print("still", survivor)'`,
		});
		expect(textOf(after)).toContain("still 7");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("heredoc node routes to the JS kernel and state persists across bash calls", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-state-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("set", { command: "node <<'EOF'\nglobalThis.jsProbe = 41;\nconsole.log('set-ok');\nEOF" });
		const second = await bash.execute("use", { command: "node -e 'console.log(\"value\", jsProbe + 1)'" });
		expect(textOf(second)).toContain("value 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bun heredoc routes to the JS kernel and state persists across calls", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bunsh-state-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("set", { command: "bun <<'EOF'\nglobalThis.bunProbe = 41;\nconsole.log('set-ok');\nEOF" });
		const second = await bash.execute("use", { command: "bun -e 'console.log(\"value\", bunProbe + 1)'" });
		expect(textOf(second)).toContain("value 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a js cell shows its own error with the user's stack but a kernel failure as just the harness message", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-errors-"));
	try {
		const bash = await makeBash(dir);
		const thrown = textOf(
			await bash.execute("user-error", {
				command: `bun -e 'function userFrame() { throw new TypeError("user boom") } userFrame()'; echo rc=$?`,
			}),
		);
		expect(thrown).toContain("TypeError: user boom");
		expect(thrown).toContain("at userFrame");
		expect(thrown).toContain("rc=1");
		const plain = textOf(await bash.execute("plain-throw", { command: `bun -e 'throw "plain value"'; echo rc=$?` }));
		expect(plain).toContain("plain value");
		expect(plain).not.toContain("    at ");
		expect(plain).toContain("rc=1");
		// The kernel process dies under the cell: a harness failure, not an error the cell raised.
		const died = textOf(
			await bash.execute("kernel-died", { command: `bun -e 'process.kill(process.pid, "SIGKILL")'; echo rc=$?` }),
		);
		expect(died).toContain("JS eval worker died during execution");
		expect(died).not.toContain("    at ");
		expect(died).toContain("rc=1");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("heredoc and -e js cells share one kernel session", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-shared-"));
	try {
		const bash = await makeBash(dir);
		await bash.execute("seed", { command: "node <<'EOF'\nglobalThis.jsShared = 'from-heredoc-js'\nEOF" });
		const bashResult = await bash.execute("bash", { command: "node -e 'console.log(\"marker:\", jsShared)'" });
		expect(textOf(bashResult)).toContain("marker: from-heredoc-js");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("node script paths fall through to the real node with argv", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jssh-script-"));
	try {
		await Bun.write(path.join(dir, "prog.js"), "console.log('argv', process.argv[2]);\n");
		const bash = await makeBash(dir);
		expect(textOf(await bash.execute("script", { command: "node prog.js hello" }))).toContain("argv hello");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("kernel bridge capabilities are shell-local and not inherited by child processes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-env-scope-"));
	try {
		const result = await (await makeBash(dir)).execute("env-scope", {
			command: [
				`printf 'shell=%s\n' "$PI_KERNEL_FLEET_ROOT"`,
				`if test -n "$PI_KERNEL_BRIDGE_ADDR" && test -n "$PI_KERNEL_BRIDGE_TOKEN"; then echo shell-bridge=set; else echo shell-bridge=unset; fi`,
				`sh -c 'if test -n "$PI_KERNEL_BRIDGE_ADDR$PI_KERNEL_BRIDGE_TOKEN$PI_KERNEL_FLEET_ROOT"; then echo child=set; else echo child=unset; fi'`,
			].join("; "),
		});
		const output = textOf(result);
		expect(output).toContain(`shell=${path.join(dir, "artifacts", "fleet")}`);
		expect(output).toContain("shell-bridge=set");
		expect(output).toContain("child=unset");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("fleet Python scripts use explicit orchestration helpers in a fresh process", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-py-"));
	try {
		const bash = await makeBash(dir);
		const writeScript = [
			"cat > fleet://plan.py <<'EOF'",
			"import proto_harness as harness",
			"results = harness.parallel([lambda i=i: i * i for i in range(4)])",
			"open('out.txt', 'w').write(','.join(str(value) for value in results) + '\\n')",
			"print('orchestrated', sum(results))",
			"EOF",
		].join("\n");
		const wrote = await bash.execute("write", { command: writeScript });
		expect(wrote.isError ?? false).toBe(false);
		expect(await Bun.file(path.join(dir, "artifacts", "fleet", "plan.py")).exists()).toBe(true);

		const run = await bash.execute("run", { command: "python fleet://plan.py" });
		expect(textOf(run)).toContain("orchestrated 14");
		expect(await Bun.file(path.join(dir, "out.txt")).text()).toBe("0,1,4,9\n");

		const after = await bash.execute("after", {
			command: 'python -c \'print("fresh", "results" not in globals())\'',
		});
		expect(textOf(after)).toContain("fresh True");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("fleet js scripts execute in the JS kernel", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-js-"));
	try {
		const bash = await makeBash(dir);
		const writeScript = [
			"cat > fleet://plan.mjs <<'EOF'",
			// `node` scripts run in real Node, so they use Node's APIs, not Bun's.
			"const { writeFile } = await import('node:fs/promises');",
			"await writeFile('js-out.txt', 'from-node-fleet\\n');",
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

test("execution metadata ignores timeout-looking successful output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-success-"));
	try {
		const bash = await makeBash(dir);
		const result = await bash.execute("success", { command: "printf 'timeout: 60\\n'" });
		expect(result.isError ?? false).toBe(false);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(0);
		expect(result.details?.execution?.timeout).toBeUndefined();
		expect(result.details?.execution?.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(textOf(result)).toContain("timeout: 60");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("failed command status outranks checks-passed output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-failure-"));
	try {
		const bash = await makeBash(dir);
		const result = await bash.execute("failure", { command: "printf 'all checks passed\\n'; exit 7" });
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(7);
		expect(result.details?.execution?.timeout).toBeUndefined();
		expect(textOf(result)).toContain("all checks passed");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("actual child timeout reports unknown process state and deadline scope", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-timeout-"));
	try {
		const bash = await makeBash(dir);
		const result = await bash.execute("timeout", { command: "sleep 120", timeout: 1 });
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.state).toBe("unknown");
		expect(result.details?.execution?.exitCode).toBeUndefined();
		expect(result.details?.execution?.timeout).toMatchObject({ cause: "deadline", scope: "command" });
		expect(result.details?.timedOut).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("artifact collector failure is distinct from successful process status", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-collector-"));
	try {
		const session = {
			...stubSession(dir),
			allocateOutputArtifact: async () => ({ id: "collector-failure", path: "/dev/null/proto-output.log" }),
		} as ToolSession;
		const bash = new BashTool(session);
		const result = await bash.execute("collector", { command: `python3 -c 'print("x" * 60000)'` });
		expect(result.isError ?? false).toBe(false);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(0);
		expect(result.details?.execution?.collector.state).toBe("failed");
		expect(result.details?.execution?.output?.disposition).toBe("truncated");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("raw output artifact and execution metadata survive replay", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-replay-"));
	const artifactPath = path.join(dir, "raw-output.log");
	try {
		const session = {
			...stubSession(dir),
			allocateOutputArtifact: async () => ({ id: "raw-output", path: artifactPath }),
		} as ToolSession;
		const result = await new BashTool(session).execute("replay", {
			command: `python3 -c 'print("diagnostic.py:17: error: retained raw output " + "x" * 60000)'`,
		});
		const execution = result.details?.execution;
		expect(execution?.state).toBe("exited");
		expect(execution?.exitCode).toBe(0);
		expect(execution?.output?.rawArtifactId).toBe("raw-output");
		expect(execution?.output?.disposition).toBe("truncated");
		expect(await Bun.file(artifactPath).exists()).toBe(true);
		expect(await Bun.file(artifactPath).text()).toContain("diagnostic.py:17: error");
		const replay = convertToLlm([
			{
				role: "bashExecution",
				command: "replay",
				output: textOf(result),
				exitCode: 0,
				cancelled: false,
				truncated: true,
				execution,
				timestamp: Date.now(),
			},
		] as never);
		const replayTextParts: string[] = [];
		for (const message of replay) {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "text") replayTextParts.push(block.text);
			}
		}
		const replayText = replayTextParts.join("\n");
		expect(replayText).toContain("Execution metadata: state=exited; exit=0");
		expect(replayText).toContain("diagnostic.py:17: error");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("running Bash updates carry execution state separately from output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-meta-running-"));
	try {
		const bash = await makeBash(dir);
		const updates: Array<{ state?: string }> = [];
		await bash.execute("running", { command: "printf 'all checks passed\\n'; sleep 0.1" }, undefined, update => {
			updates.push({ state: update.details?.execution?.state });
		});
		expect(updates.some(update => update.state === "running")).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("explicit heredoc filesystem edits expose each committed atomic mutation", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-file-edit-"));
	try {
		await fs.mkdir(path.join(dir, "sub"));
		await Bun.write(path.join(dir, "sub", "target.txt"), "before\n");
		const bash = await makeBash(dir);
		const result = await bash.execute("file-edit", {
			command: [
				"cd sub && python <<'PYEOF' && cat target.txt",
				"import proto_harness as harness",
				'target = "target.txt"',
				"source = harness.fs.read_text(target)",
				'assert source.count("before") == 1',
				'harness.fs.write_text(target, source.replace("before", "intermediate"))',
				'CONTENT = "after\\n"',
				"harness.fs.write_text(target, CONTENT)",
				"PYEOF",
			].join("\n"),
		});
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode, textOf(result)).toBe(0);
		expect(await Bun.file(path.join(dir, "sub", "target.txt")).text()).toBe("after\n");
		expect(textOf(result)).toContain("after");
		const writes = (result.details?.statusEvents ?? []).filter(event => event.op === "write");
		expect(writes).toHaveLength(2);
		expect(writes[0]?.diff).toMatch(/^-\d+\|before$/m);
		expect(writes[0]?.diff).toMatch(/^\+\d+\|intermediate$/m);
		expect(writes[1]?.diff).toMatch(/^-\d+\|intermediate$/m);
		expect(writes[1]?.diff).toMatch(/^\+\d+\|after$/m);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);
