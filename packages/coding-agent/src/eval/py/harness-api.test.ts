import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { currentExecutionOrigin } from "../../jobs/origin";
import { SessionManager } from "../../session/session-manager";
import type { Tool, ToolSession } from "../../tools";
import { BashTool } from "../../tools/bash";
import { ReadTool } from "../../tools/read";
import { namespaceSessionId } from "../backend-helpers";
import { bridgeCwdFor } from "../bridge-cwd";
import { releaseFsObservationLedger, retainFsObservationLedger } from "../fs-observations";
import { kernelLaneSessionId } from "../kernel-control";
import { setKernelLaneConfiguration } from "../kernel-environment";
import * as pythonExecutor from "./executor";
import { disposeKernelSessionsByOwner, type PythonExecutorOptions } from "./executor";
import { registerPythonHarnessRun } from "./harness-bridge";
import { dispatchPythonHarnessRequest } from "./harness-dispatch";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";
import { releasePythonStore } from "./python-store";
import { PYTHON_REMOTE_RUNNER_SOURCE } from "./runner-source";
import { PYTHON_RUNTIME_ASSETS, stagePythonRuntimeAssets } from "./runtime-assets";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const pythonTest = availability.ok ? test : test.skip;

function fixture(cwd: string) {
	const owner = `explicit-api:${crypto.randomUUID()}`;
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		hasUI: false,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	retainFsObservationLedger(owner, owner);
	return {
		session,
		tools,
		owner,
		async dispose() {
			await disposeKernelSessionsByOwner(owner);
			releaseFsObservationLedger(owner, owner);
		},
	};
}

async function python(session: ToolSession, code: string) {
	const run = await registerPythonHarnessRun(session);
	try {
		const proc = Bun.spawn([availability.pythonPath!, "-c", code], {
			cwd: session.cwd,
			env: { ...process.env, ...run.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, error, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exit, error).toBe(0);
		return { output, error, events: [...run.events] };
	} finally {
		await run.dispose();
	}
}

pythonTest(
	"explicit Python helpers enforce host policy and validate extension-rewritten tool input",
	async () => {
		using dir = TempDir.createSync("@harness-policy-");
		const f = fixture(dir.path());
		let executed = 0;
		f.tools.set("accept", {
			name: "accept",
			label: "accept",
			description: "Accept a typed integer",
			parameters: {
				type: "object",
				properties: { value: { type: "integer" } },
				required: ["value"],
				additionalProperties: false,
			},
			execute: async () => {
				executed++;
				return { content: [{ type: "text", text: "accepted" }] };
			},
		});
		f.session.beforeEvalToolCall = async (_tool, _id, args) =>
			args.value === 1
				? { block: true, reason: "extension refused mutation" }
				: { args: { value: "invalid rewrite" } };
		try {
			const result = await python(
				f.session,
				`import proto_harness as harness
assert not any(key in globals() for key in ("tool", "Path", "completion", "parallel"))
for value in (1, 2):
    try:
        harness.tool.accept(value=value)
    except RuntimeError as error:
        print(error)
    else:
        raise AssertionError("policy bypassed")`,
			);
			expect(result.output).toContain("extension refused mutation");
			expect(result.output).toContain("Validation failed");
			expect(executed).toBe(0);
		} finally {
			await f.dispose();
		}
	},
	30_000,
);

pythonTest(
	"atomic harness edits reject cross-process and read-tool stale content without truncating",
	async () => {
		using dir = TempDir.createSync("@harness-fs-");
		const f = fixture(dir.path());
		const file = dir.join("edit.txt");
		try {
			await Bun.write(file, "before");
			await python(
				f.session,
				`import proto_harness as harness; assert harness.fs.read_text("edit.txt") == "before"`,
			);
			await Bun.write(file, "external");
			const stale = await python(
				f.session,
				`import proto_harness as harness
try:
    harness.fs.write_text("edit.txt", "clobber")
except harness.StaleWriteError:
    print("stale refused")
else:
    raise AssertionError("stale overwrite")`,
			);
			expect(stale.output).toBe("stale refused\n");
			expect(await Bun.file(file).text()).toBe("external");
			await python(
				f.session,
				`import proto_harness as harness
assert harness.fs.read_text("edit.txt") == "external"
harness.fs.replace("edit.txt", "external", "replacement")`,
			);
			expect(await Bun.file(file).text()).toBe("replacement");
			await f.tools.get("read")!.execute("actual-read-tool", { path: file });
			await Bun.write(file, "later");
			await expect(
				dispatchPythonHarnessRequest(
					{
						session: f.session,
						runId: "test",
						lane: "main",
						cwd: dir.path(),
						signal: new AbortController().signal,
						toolCallId: "test",
					},
					"fs.write",
					{ path: file, data: "eA==" },
				),
			).rejects.toThrow("StaleWriteError");
			expect(await Bun.file(file).text()).toBe("later");
		} finally {
			await f.dispose();
		}
	},
	30_000,
);

pythonTest(
	"named kernels retain only explicit state, nest different names and refuse self-dependency",
	async () => {
		using dir = TempDir.createSync("@harness-kernels-");
		const f = fixture(dir.path());
		try {
			const first = await python(
				f.session,
				`import proto_harness as harness
k = harness.kernel("outer")
result = k.run("import proto_harness as harness; value = 41; assert 'tool' not in globals(); print(value)")
assert result["exitCode"] == 0, result
print(result["output"], end="")`,
			);
			expect(first.output).toContain("41");
			const next = await python(
				f.session,
				`import proto_harness as harness
outer = harness.kernel("outer")
result = outer.run("value += 1; print(value); inner = harness.kernel('inner').run('nested = 7; print(nested)'); print(inner['output'])")
assert result["exitCode"] == 0, result
print(result["output"], end="")
result = outer.run("try:\\n    harness.kernel('outer').run('print(0)')\\nexcept RuntimeError as error:\\n    print(error)")
assert result["exitCode"] == 0, result
print(result["output"], end="")
assert outer.status()["state"] == "idle"
outer.restart()
result = outer.run("print('value' in globals())")
assert result["exitCode"] == 0, result
print(result["output"], end="")
outer.stop()
assert outer.status()["state"] == "stopped"`,
			);
			expect(next.output).toContain("42");
			expect(next.output).toContain("7");
			expect(next.output).toContain("self-dependency refused");
			expect(next.output).toContain("False");
		} finally {
			await f.dispose();
		}
	},
	60_000,
);

pythonTest(
	"aborting an explicit named kernel waits for cancellation before reuse",
	async () => {
		using dir = TempDir.createSync("@harness-kernel-cancel-");
		const f = fixture(dir.path());
		const abort = new AbortController();
		const started = Promise.withResolvers<void>();
		const context = {
			session: f.session,
			runId: "test",
			lane: "main",
			cwd: dir.path(),
			signal: abort.signal,
			toolCallId: "test",
			emit: (event: { type: string; event?: { op: string } }) => {
				if (event.type === "status" && event.event?.op === "kernel-state") started.resolve();
			},
		};
		try {
			const pending = dispatchPythonHarnessRequest(context, "kernel.run", {
				name: "cancel",
				code: "import time; time.sleep(30)",
			});
			await started.promise;
			abort.abort(new Error("test cancellation"));
			const result = (await pending) as { cancelled: boolean };
			expect(result.cancelled).toBe(true);
			const next = await python(
				f.session,
				`import proto_harness as harness
result = harness.kernel("cancel").run("print('after cancel')")
assert result['exitCode'] == 0, result
print(result['output'], end='')`,
			);
			expect(next.output).toContain("after cancel");
		} finally {
			await f.dispose();
		}
	},
	60_000,
);

pythonTest(
	"python -m proto_harness.kernel streams binary stdout/stderr and native program input",
	async () => {
		using dir = TempDir.createSync("@harness-kernel-cli-");
		const f = fixture(dir.path());
		const run = await registerPythonHarnessRun(f.session);
		try {
			const payload = new Uint8Array([0, 255, 10, 128, 1]);
			const proc = Bun.spawn(
				[
					availability.pythonPath!,
					"-m",
					"proto_harness.kernel",
					"cli",
					"-c",
					"import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.buffer.write(bytes([255,0,10]))",
				],
				{
					cwd: dir.path(),
					env: { ...process.env, ...run.env },
					stdin: payload,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [out, err, exit] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).arrayBuffer(),
				proc.exited,
			]);
			expect(new Uint8Array(out)).toEqual(payload);
			expect(new Uint8Array(err)).toEqual(new Uint8Array([255, 0, 10]));
			expect(exit).toBe(0);
		} finally {
			await run.dispose();
			await f.dispose();
		}
	},
	30_000,
);

pythonTest(
	"fresh rich display shares MIME conversion and keeps huge integers and nonfinite floats readable",
	async () => {
		using dir = TempDir.createSync("@harness-rich-display-");
		const f = fixture(dir.path());
		try {
			const result = await python(
				f.session,
				`import proto_harness as harness
harness.display({"large": 2**64, "nan": float("nan")})
class Image:
    def _repr_mimebundle_(self):
        return {"image/png": b"png bytes", "text/plain": "a figure"}
harness.display(Image())`,
			);
			expect(result.output).toBe("");
			expect(result.events).toContainEqual({
				type: "display",
				output: { type: "json", data: { large: "18446744073709551616", nan: "nan" } },
			});
			expect(result.events).toContainEqual({
				type: "display",
				output: { type: "image", data: "cG5nIGJ5dGVz", mimeType: "image/png" },
			});
		} finally {
			await f.dispose();
		}
	},
	30_000,
);

pythonTest(
	"a stale client syntax failure never adds diagnostics or prevents project sitecustomize",
	async () => {
		using dir = TempDir.createSync("@harness-stale-startup-");
		const runtime = dir.join("runtime");
		const project = dir.join("project");
		await Bun.write(`${runtime}/sitecustomize.py`, PYTHON_RUNTIME_ASSETS["sitecustomize.py"]!);
		await Bun.write(`${runtime}/proto_harness/__init__.py`, "");
		await Bun.write(`${runtime}/proto_harness/_client.py`, "def stale_syntax(:\n");
		await Bun.write(`${project}/sitecustomize.py`, "import os; os.environ['PROJECT_CUSTOMIZATION_RAN']='yes'\n");
		const proc = Bun.spawn(
			[availability.pythonPath!, "-c", "import os; print(os.environ['PROJECT_CUSTOMIZATION_RAN'])"],
			{
				cwd: dir.path(),
				env: { ...process.env, PYTHONPATH: `${runtime}:${project}`, PI_PYTHON_HARNESS_TOKEN: "stale" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(out).toBe("yes\n");
		expect(err).toBe("");
		expect(exit).toBe(0);
	},
	30_000,
);

pythonTest(
	"real child stdio callbacks preserve host authority, lane and cwd, revoke old runs, and drain cancellation",
	async () => {
		using dir = TempDir.createSync("@harness-stdio-");
		const f = fixture(dir.path());
		f.session.sessionManager = SessionManager.create(dir.path(), dir.join("sessions"));
		const cwd = dir.join("remote-cwd");
		await fs.mkdir(cwd);
		const realCwd = await fs.realpath(cwd);
		const target = { kind: "ssh" as const, host: "stdio-contract-no-ssh-connection", cwd: dir.path() };
		const kernel = new PythonKernel(crypto.randomUUID(), target, availability.pythonPath);
		const compressed = Buffer.from(Bun.gzipSync(PYTHON_REMOTE_RUNNER_SOURCE)).toString("base64");
		const source = `import base64,gzip;__file__="<proto-python-runner>";exec(compile(gzip.decompress(base64.b64decode("${compressed}")),__file__,"exec"))`;
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("PI_PYTHON_HARNESS_") && key !== "PYTHONPATH"),
		);
		// The actual child runs the production remote bootstrap and stdio protocol locally.
		// This proves callback transport, not SSH/container provisioning or connectivity.
		kernel.setProcess(
			Bun.spawn([availability.pythonPath!, "-u", "-c", source], {
				cwd: dir.path(),
				env: {
					...env,
					PI_KERNEL_STDIO_BRIDGE: "1",
					PI_KERNEL_REMOTE: "1",
					PI_KERNEL_TARGET: JSON.stringify(target),
				},
				detached: true,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const calls: { owner: string | null | undefined; cwd: string | undefined; lane: string | undefined }[] = [];
		f.tools.set("probe", {
			name: "probe",
			label: "probe",
			description: "Report authenticated callback scope",
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
			execute: async () => {
				calls.push({
					owner: f.session.getEvalKernelOwnerId?.(),
					cwd: bridgeCwdFor(f.session),
					lane: currentExecutionOrigin()?.lane,
				});
				return { content: [{ type: "text", text: "bound" }] };
			},
		});
		f.session.beforeEvalToolCall = async (_tool, _id, args) =>
			args.value === "denied" ? { block: true, reason: "host policy denied" } : undefined;
		const run = await registerPythonHarnessRun(f.session, {
			transport: "stdio",
			lane: "remote-owned",
			cwd: dir.path(),
		});
		const resumed = await registerPythonHarnessRun(f.session, {
			transport: "stdio",
			lane: "second-owned",
			cwd: dir.path(),
		});
		const abort = new AbortController();
		const cancelled = await registerPythonHarnessRun(f.session, {
			transport: "stdio",
			lane: "cancel-owned",
			cwd: dir.path(),
			signal: abort.signal,
		});
		try {
			expect(run.env).toEqual({});
			expect((await kernel.requestStatus())?.busy).toBe(0);
			let firstOutput = "";
			const first = await kernel.execute(
				`import os, json
import proto_harness as harness
from proto_harness import _client
os.chdir(${JSON.stringify(cwd)})
print(harness.tool.probe(value="allowed"))
print(_client._transport.__globals__["_current_run_id"]())`,
				{
					onToolRequest: run.request,
					onChunk: text => {
						firstOutput += text;
					},
					timeoutMs: 10_000,
				},
			);
			expect(first.status, JSON.stringify(first.error)).toBe("ok");
			expect(calls).toEqual([{ owner: f.owner, cwd: realCwd, lane: "remote-owned" }]);
			const oldId = firstOutput.trim().split("\n").at(-1)!;
			await run.dispose();
			await expect(run.request({ name: "probe", args: { value: "late" } })).rejects.toThrow("revoked");
			let secondOutput = "";
			const second = await kernel.execute(
				`import threading
os.chdir(${JSON.stringify(cwd)})
wire = _client._transport.__globals__
event = threading.Event()
replies = []
wire["_BRIDGE_REPLIES"]["late-contract"] = (event, replies)
wire["_emit"]({"type":"tool_request","id":${JSON.stringify(oldId)},"requestId":"late-contract","payload":{"name":"probe","args":{"value":"late"},"cwd":os.getcwd()}})
assert event.wait(5), "late callback was not answered"
assert not replies[0]["ok"]
assert "No active parent-owned Python harness run" in replies[0]["error"]["message"]
wire["_BRIDGE_REPLIES"].pop("late-contract")
try:
    harness.tool.probe(value="denied")
except RuntimeError as error:
    assert "host policy denied" in str(error)
else:
    raise AssertionError("host policy bypassed")
print(harness.tool.probe(value="allowed"))`,
				{
					onToolRequest: resumed.request,
					onChunk: text => {
						secondOutput += text;
					},
					timeoutMs: 10_000,
				},
			);
			expect(second.status, JSON.stringify(second.error)).toBe("ok");
			expect(secondOutput).toContain("bound");
			expect(calls).toEqual([
				{ owner: f.owner, cwd: realCwd, lane: "remote-owned" },
				{ owner: f.owner, cwd: realCwd, lane: "second-owned" },
			]);
			const largeGraph = await kernel.execute(
				`with harness.store.transaction() as store:
    store["blob"] = b"x" * (40 * 1024 * 1024)
    store["alias"] = store["blob"]
harness.store.refresh()
assert len(harness.store["blob"]) == 40 * 1024 * 1024
assert harness.store["blob"] is harness.store["alias"]`,
				{
					onToolRequest: resumed.request,
					timeoutMs: 20_000,
				},
			);
			expect(largeGraph.status, JSON.stringify(largeGraph.error)).toBe("ok");
			const unregistered = await kernel.execute('harness.tool.probe(value="unregistered")', { timeoutMs: 10_000 });
			expect(unregistered.status).toBe("error");
			expect(unregistered.error?.value).toContain("No active parent-owned Python harness run");
			f.session.getEvalKernelOwnerId = () => "different-owner";
			const movedOwner = await kernel.execute('harness.tool.probe(value="wrong-owner")', {
				onToolRequest: resumed.request,
				timeoutMs: 10_000,
			});
			expect(movedOwner.status).toBe("error");
			expect(movedOwner.error?.value).toContain("revoked");
			expect(calls).toHaveLength(2);
			f.session.getEvalKernelOwnerId = () => f.owner;
			const started = Promise.withResolvers<void>();
			const observedAbort = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let drained = false;
			f.tools.set("hold", {
				name: "hold",
				label: "hold",
				description: "Acknowledge owned cancellation",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				execute: async (_id, _args, signal) => {
					const onAbort = () => observedAbort.resolve();
					signal?.addEventListener("abort", onAbort, { once: true });
					started.resolve();
					try {
						await release.promise;
						drained = true;
						return { content: [] };
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				},
			});
			let settled = false;
			const running = kernel
				.execute("harness.tool.hold()", {
					onToolRequest: cancelled.request,
					signal: abort.signal,
					timeoutMs: 10_000,
				})
				.finally(() => {
					settled = true;
				});
			await started.promise;
			abort.abort(new Error("contract interruption"));
			await observedAbort.promise;
			expect(drained).toBe(false);
			expect(settled).toBe(false);
			release.resolve();
			expect((await running).cancelled).toBe(true);
			expect(drained).toBe(true);
			await expect(cancelled.request({ name: "probe", args: { value: "late" } })).rejects.toThrow("revoked");
		} finally {
			await Promise.all([run.dispose(), resumed.dispose(), cancelled.dispose()]);
			await kernel.shutdown();
			releasePythonStore(f.owner);
			await f.dispose();
		}
	},
	30_000,
);

pythonTest(
	"warm CLI preserves the configured interpreter identity unless --interpreter explicitly overrides it",
	async () => {
		using dir = TempDir.createSync("@harness-cli-configured-");
		const f = fixture(dir.path());
		const configuredCwd = dir.join("configured");
		await fs.mkdir(configuredCwd);
		await ptree.exec([availability.pythonPath!, "-m", "venv", "--without-pip", dir.join("venv")], {
			timeout: 20_000,
		});
		const venvBin = dir.join("venv", process.platform === "win32" ? "Scripts" : "bin");
		const interpreter = path.join(venvBin, process.platform === "win32" ? "python.exe" : "python");
		try {
			await python(
				f.session,
				`import proto_harness as harness
result = harness.kernel("configured", interpreter=${JSON.stringify(interpreter)}, cwd=${JSON.stringify(configuredCwd)}).run("value = 41")
assert result["exitCode"] == 0, result`,
			);
			const run = await registerPythonHarnessRun(f.session);
			try {
				const inherited = await ptree.exec(
					[
						availability.pythonPath!,
						"-m",
						"proto_harness.kernel",
						"configured",
						"-c",
						`import os, sys
value += 1
assert os.path.samefile(sys.prefix, ${JSON.stringify(dir.join("venv"))})
assert os.path.samefile(os.getcwd(), ${JSON.stringify(dir.path())})
print("configured warm", value)`,
					],
					{ cwd: dir.path(), env: { ...process.env, ...run.env }, timeout: 20_000 },
				);
				expect(inherited.stdout).toContain("configured warm 42");
				const fromPath = await ptree.exec(
					[
						availability.pythonPath!,
						"-m",
						"proto_harness.kernel",
						"path-selected",
						"--interpreter",
						process.platform === "win32" ? "python" : "python3",
						"-c",
						`import os, sys; assert os.path.samefile(sys.prefix, ${JSON.stringify(dir.join("venv"))}); print("PATH venv selected")`,
					],
					{
						cwd: dir.path(),
						env: { ...process.env, ...run.env, PATH: `${venvBin}${path.delimiter}${process.env.PATH ?? ""}` },
						timeout: 20_000,
					},
				);
				expect(fromPath.stdout).toContain("PATH venv selected");
				const relative = await ptree.exec(
					[
						availability.pythonPath!,
						"-m",
						"proto_harness.kernel",
						"relative-selected",
						"--interpreter",
						process.platform === "win32" ? "./venv/Scripts/python.exe" : "./venv/bin/python",
						"-c",
						`import os, sys; assert os.path.samefile(sys.prefix, ${JSON.stringify(dir.join("venv"))}); print("relative venv selected")`,
					],
					{ cwd: dir.path(), env: { ...process.env, ...run.env }, timeout: 20_000 },
				);
				expect(relative.stdout).toContain("relative venv selected");
				const overridden = await ptree.exec(
					[
						availability.pythonPath!,
						"-m",
						"proto_harness.kernel",
						"configured",
						"--interpreter",
						availability.pythonPath!,
						"-c",
						'assert "value" not in globals(); print("explicit interpreter override")',
					],
					{ cwd: dir.path(), env: { ...process.env, ...run.env }, timeout: 20_000 },
				);
				expect(overridden.stdout).toContain("explicit interpreter override");
			} finally {
				await run.dispose();
			}
		} finally {
			await f.dispose();
		}
	},
	60_000,
);

test("named remote dispatch uses configured target cwd rather than host invocation cwd while local dispatch keeps invocation cwd", async () => {
	using dir = TempDir.createSync("@harness-remote-selection-");
	const f = fixture(dir.path());
	const sessionId = namespaceSessionId(kernelLaneSessionId(f.session, "configured"), "python:");
	const context = {
		session: f.session,
		runId: "routing-seam",
		lane: "main",
		cwd: dir.path(),
		signal: new AbortController().signal,
		toolCallId: "routing-seam",
	};
	const options: PythonExecutorOptions[] = [];
	const boundary = new Error("Remote execution transport deliberately not started");
	const execute = spyOn(pythonExecutor, "executePython").mockImplementation(async (_code, selected) => {
		if (!selected) throw new Error("Missing execution configuration");
		options.push(selected);
		throw boundary;
	});
	try {
		setKernelLaneConfiguration(f.owner, "python", sessionId, {
			cwd: "/target/work",
			interpreter: "/target/venv/bin/python",
			target: { kind: "ssh", host: "configured-host", cwd: "/target/work" },
		});
		await expect(
			dispatchPythonHarnessRequest(context, "kernel.run", { name: "configured", code: "pass" }),
		).rejects.toBe(boundary);
		expect(options[0]).toMatchObject({
			cwd: "/target/work",
			runCwd: "/target/work",
			interpreter: "/target/venv/bin/python",
			target: { kind: "ssh", host: "configured-host" },
		});
		await expect(
			dispatchPythonHarnessRequest(context, "kernel.run", {
				name: "configured",
				cwd: "/target/explicit",
				code: "pass",
			}),
		).rejects.toBe(boundary);
		expect(options[1].runCwd).toBe("/target/explicit");
		setKernelLaneConfiguration(f.owner, "python", sessionId, {
			cwd: dir.join("configured-local"),
			target: { kind: "local" },
		});
		await expect(
			dispatchPythonHarnessRequest(context, "kernel.run", { name: "configured", code: "pass" }),
		).rejects.toBe(boundary);
		expect(options[2]).toMatchObject({
			cwd: dir.join("configured-local"),
			runCwd: dir.path(),
			target: { kind: "local" },
		});
	} finally {
		execute.mockRestore();
		await f.dispose();
	}
});

pythonTest(
	"warm CLI forwards an explicit target-only interpreter literally and omits an unset selector at the API boundary",
	async () => {
		const received: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name: string; args: Record<string, unknown> };
				if (body.name !== "kernel.run")
					return Response.json({ error: { message: "Unexpected operation" } }, { status: 400 });
				received.push(body.args);
				return Response.json({ value: { exitCode: 0 } });
			},
		});
		try {
			const env = {
				...process.env,
				PYTHONPATH: await stagePythonRuntimeAssets(),
				PI_PYTHON_HARNESS_URL: new URL("request", server.url).href,
				PI_PYTHON_HARNESS_TOKEN: "test-token",
			};
			const remoteOnly = "/target-only/not-on-host/venv/bin/python";
			await ptree.exec(
				[
					availability.pythonPath!,
					"-m",
					"proto_harness.kernel",
					"configured-remote",
					"--interpreter",
					remoteOnly,
					"-c",
					"pass",
				],
				{ env, timeout: 15_000 },
			);
			await ptree.exec([availability.pythonPath!, "-m", "proto_harness.kernel", "configured-remote", "-c", "pass"], {
				env,
				timeout: 15_000,
			});
			expect(received[0]).toMatchObject({ name: "configured-remote", interpreter: remoteOnly, code: "pass" });
			expect(received[1]).not.toHaveProperty("interpreter");
		} finally {
			await server.stop(true);
		}
	},
	30_000,
);
