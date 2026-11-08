import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { registerPythonHarnessRun } from "../eval/py/harness-bridge";
import type { PythonHarnessRun } from "../eval/py/harness-types";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

const python = Bun.which("python3");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");

function session(cwd: string, identity: string = crypto.randomUUID()): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getSessionId: () => identity,
		getEvalSessionId: () => identity,
		getEvalKernelOwnerId: () => identity,
		getArtifactsDir: () => path.join(cwd, "artifacts"),
	} as unknown as ToolSession;
}

async function request(run: PythonHarnessRun, token: string, body: unknown) {
	return await fetch(run.env.PI_PYTHON_HARNESS_URL!, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test.skipIf(!python)(
	"Bash Python preserves fresh namespaces, exact binary streams, stdin, argv, atexit and status",
	async () => {
		await using dir = await TempDir.create("@python-fresh-");
		const owner = crypto.randomUUID();
		const bash = new BashTool(session(dir.path(), owner));
		try {
			await bash.execute("seed", { command: `${python} -c 'marker = 41'` });
			const fresh = await bash.execute("fresh", {
				command: `${python} -c 'print("marker" in globals(), "tool" in globals())'`,
			});
			expect(textOf(fresh)).toContain("False False");
			const failed = await bash.execute("no-replay", {
				command: `${python} -c 'from pathlib import Path; p=Path("attempts.txt"); p.write_text(p.read_text()+"x" if p.exists() else "x"); raise RuntimeError("once")'`,
			});
			expect(failed.details?.execution?.exitCode).toBe(1);
			expect(await Bun.file(path.join(dir.path(), "attempts.txt")).text()).toBe("x");
			const syntax = await bash.execute("syntax", {
				command: `${python} - <<'PY'\nfrom pathlib import Path\nPath("forbidden.txt").write_text("no")\ninvalid = <<TEXT\nPY`,
			});
			expect(syntax.details?.execution?.exitCode).toBe(1);
			expect(await Bun.file(path.join(dir.path(), "forbidden.txt")).exists()).toBe(false);
			const code =
				'import sys,atexit,json; atexit.register(lambda: sys.stderr.write("bye")); sys.stdout.buffer.write(bytes([0,255,65])); sys.stderr.write(json.dumps(sys.argv)); sys.exit(7)';
			const result = await bash.execute("bytes", {
				command: `${python} -c ${quote(code)} 'space value' --flag > out.bin 2> err.txt`,
			});
			expect(result.details?.exitCode).toBe(7);
			expect(new Uint8Array(await Bun.file(path.join(dir.path(), "out.bin")).arrayBuffer())).toEqual(
				new Uint8Array([0, 255, 65]),
			);
			expect(await Bun.file(path.join(dir.path(), "err.txt")).text()).toBe('["-c", "space value", "--flag"]bye');
			const stdin = await bash.execute("stdin", {
				command: `printf %s native | ${python} -c 'import os,sys; print(os.read(0,6),sys.argv[1])' argument`,
			});
			expect(textOf(stdin)).toContain("b'native' argument");
			expect(result.details?.execution?.stages?.every(stage => stage.route !== "py")).toBe(true);
		} finally {
			await disposeBashSessions(owner);
		}
	},
);

test.skipIf(!python)(
	"Bash aliases, shebangs, modules, script files and subprocesses use real Python without builtin fallback",
	async () => {
		await using dir = await TempDir.create("@python-allforms-");
		const owner = crypto.randomUUID();
		const bash = new BashTool(session(dir.path(), owner));
		await Bun.write(
			path.join(dir.path(), "program.py"),
			`#!${python}\nimport os,sys\nprint('script',sys.argv[1], 'tool' in globals())\n`,
		);
		await fs.chmod(path.join(dir.path(), "program.py"), 0o700);
		await Bun.write(path.join(dir.path(), "module_probe.py"), "print('module-native')\n");
		try {
			const forms = await bash.execute("forms", {
				command: [
					`shopt -s expand_aliases\nalias pyreal=${quote(python!)}\npyreal -c 'print("alias-native")'`,
					`env ${python} program.py env-argument`,
					"./program.py shebang-argument",
					`${python} -m module_probe`,
					`${python} - second <<'PY'\nimport sys; print('heredoc',sys.argv)\nPY`,
					`${python} -c 'import subprocess,sys; subprocess.run([sys.executable,"-c","print(123)"] ,check=True)'`,
				].join("\n"),
			});
			const text = textOf(forms);
			expect(text).toContain("alias-native");
			expect(text).toContain("script env-argument False");
			expect(text).toContain("script shebang-argument False");
			expect(text).toContain("module-native");
			expect(text).toContain("heredoc ['-', 'second']");
			expect(text).toContain("123");
			await fs.mkdir(path.join(dir.path(), "test-bin"));
			const interpreterProbe = Bun.spawn([python!, "-c", "import sys; print(sys.executable)"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const nativeInterpreter = (await new Response(interpreterProbe.stdout).text()).trim();
			expect(await interpreterProbe.exited).toBe(0);
			await fs.symlink(nativeInterpreter, path.join(dir.path(), "test-bin", "python"));
			const envPath = await bash.execute("env-path", {
				command: "python -c 'print(8675309)'",
				env: { PATH: `${path.join(dir.path(), "test-bin")}:${process.env.PATH ?? ""}` },
			});
			expect(textOf(envPath)).toContain("8675309");
			const relativePath = await bash.execute("relative-path", {
				command: "PATH=test-bin python -c 'print(8675310)'",
			});
			expect(textOf(relativePath)).toContain("8675310");
			await fs.mkdir(path.join(dir.path(), "project"));
			await Bun.write(
				path.join(dir.path(), "project", "sitecustomize.py"),
				"import os; os.environ['LANE_SITE_CHAIN']='retained'\n",
			);
			await bash.execute("export-path", { command: 'export PYTHONPATH="$PWD/project"' });
			const lanePath = await bash.execute("lane-path", {
				command: `${python} -c 'import os; print(os.environ["LANE_SITE_CHAIN"])'`,
			});
			expect(textOf(lanePath)).toContain("retained");
			const immediateUnset = await bash.execute("unset-path", {
				command: `unset PYTHONPATH; ${python} -c 'import os; print("LANE_SITE_CHAIN" in os.environ)'`,
			});
			expect(textOf(immediateUnset)).toContain("False");
			const clearedPath = await bash.execute("cleared-path", {
				command: `${python} -c 'import os; print("LANE_SITE_CHAIN" in os.environ)'`,
			});
			expect(textOf(clearedPath)).toContain("False");
			const missing = await bash.execute("missing", { command: "PATH=/nonexistent python -c 'print(1)'" });
			expect(missing.details?.exitCode).toBe(127);
		} finally {
			await disposeBashSessions(owner);
		}
	},
);

test.skipIf(!python)(
	"Managed sitecustomize chains project customization, detects descendants, and respects -I/-E/-S",
	async () => {
		await using dir = await TempDir.create("@python-site-");
		await Bun.write(
			path.join(dir.path(), "sitecustomize.py"),
			"import os; os.environ['PROJECT_SITE_CHAINED']='yes'\n",
		);
		const run = await registerPythonHarnessRun(session(dir.path()), { env: { PYTHONPATH: dir.path() } });
		try {
			const execute = async (args: string[]) => {
				const child = Bun.spawn([python!, ...args], {
					cwd: dir.path(),
					env: { ...process.env, ...run.env },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, out, err] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(code, err).toBe(0);
				return out;
			};
			expect(
				await execute([
					"-c",
					'import os,sys; print(os.environ["PROJECT_SITE_CHAINED"], "proto_harness.helpers" in sys.modules); import subprocess; subprocess.run([sys.executable,"-c","pass"],check=True)',
				]),
			).toBe("yes False\n");
			expect(run.events.filter(event => event.type === "detection")).toHaveLength(2);
			for (const flag of ["-I", "-E", "-S"]) {
				expect(
					await execute([
						flag,
						"-c",
						'import os,sys; print(os.environ.get("PROJECT_SITE_CHAINED"), "proto_harness._client" in sys.modules)',
					]),
				).toBe("None False\n");
			}
			expect(run.events.filter(event => event.type === "detection")).toHaveLength(2);
		} finally {
			await run.dispose();
		}
	},
);

test("Run capabilities reject foreign tokens, peer session identifiers, revoked runs and inactive tool policy", async () => {
	await using dir = await TempDir.create("@python-auth-");
	const firstSession = {
		...session(dir.path(), "first"),
		getToolByName: (name: string) =>
			name === "owned_probe"
				? {
						name,
						label: name,
						description: "Authority fixture",
						parameters: { type: "object", additionalProperties: true },
						execute: async () => ({ content: [{ type: "text", text: "first-owner" }] }),
					}
				: undefined,
		beforeEvalToolCall: (_tool: unknown, _id: string, args: Record<string, unknown>) =>
			args.block ? { block: true, reason: "policy-denied" } : undefined,
	} as unknown as ToolSession;
	const first = await registerPythonHarnessRun(firstSession);
	const second = await registerPythonHarnessRun(session(dir.path(), "second"));
	const detection = {
		name: "_detect",
		args: { pid: 123, argv: ["-c"], cwd: dir.path(), executable: python ?? "python3" },
	};
	try {
		expect((await request(first, second.env.PI_PYTHON_HARNESS_TOKEN!, detection)).status).toBe(403);
		expect(
			(await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, { ...detection, sessionId: "second" })).status,
		).toBe(400);
		expect((await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, detection)).status).toBe(200);
		const denied = await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, {
			name: "unavailable_tool",
			args: { sessionId: "second" },
		});
		expect(denied.status).toBe(400);
		expect(await denied.text()).toContain("Unknown tool");
		const owned = await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, {
			name: "owned_probe",
			args: { sessionId: "second" },
		});
		expect(await owned.json()).toEqual({ value: "first-owner" });
		const blocked = await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, {
			name: "owned_probe",
			args: { block: true },
		});
		expect(blocked.status).toBe(400);
		expect(await blocked.text()).toContain("policy-denied");
		for (let offset = 0; offset < 264; offset += 8) {
			const responses = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, {
						...detection,
						args: { ...detection.args, pid: offset + index + 1 },
					}),
				),
			);
			expect(responses.every(response => response.status === 200)).toBe(true);
		}
		expect(first.events).toHaveLength(256);
		await first.dispose();
		let unavailable = false;
		try {
			const response = await request(first, first.env.PI_PYTHON_HARNESS_TOKEN!, detection);
			unavailable = response.status === 403;
		} catch {
			unavailable = true;
		}
		expect(unavailable).toBe(true);
		expect((await request(second, second.env.PI_PYTHON_HARNESS_TOKEN!, detection)).status).toBe(200);
	} finally {
		await Promise.all([first.dispose(), second.dispose()]);
	}
});

test.skipIf(!python)(
	"Aborting a Python run revokes its capability and drains the in-flight canonical tool",
	async () => {
		await using dir = await TempDir.create("@python-cancel-");
		const started = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		const tool = {
			name: "hold",
			label: "hold",
			description: "Cancelable fixture",
			parameters: { type: "object", properties: {} },
			async execute(_id: string, _args: unknown, signal?: AbortSignal) {
				const pending = Promise.withResolvers<never>();
				const abort = () => pending.reject(new Error("hold cancelled"));
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				started.resolve();
				try {
					await pending.promise;
				} finally {
					signal?.removeEventListener("abort", abort);
					stopped.resolve();
				}
				return { content: [] };
			},
		};
		const fixture = {
			...session(dir.path()),
			getToolByName: (name: string) => (name === "hold" ? tool : undefined),
		} as unknown as ToolSession;
		const controller = new AbortController();
		const run = await registerPythonHarnessRun(fixture, { signal: controller.signal });
		const child = Bun.spawn([python!, "-c", "import proto_harness as h; h.tool.hold({})"], {
			cwd: dir.path(),
			env: { ...process.env, ...run.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		try {
			await Promise.race([
				started.promise,
				child.exited.then(async () => {
					throw new Error(`Python helper exited before reaching tool: ${await stderr}`);
				}),
			]);
			controller.abort();
			await run.dispose();
			await stopped.promise;
			expect(await child.exited).not.toBe(0);
			expect(await stderr).toContain("HarnessError");
		} finally {
			child.kill();
			await run.dispose();
			await child.exited;
		}
	},
);
