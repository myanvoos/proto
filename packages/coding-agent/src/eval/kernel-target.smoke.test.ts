import { expect, test } from "bun:test";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { disposeBashSessions } from "../exec/bash-executor";
import { ArtifactManager } from "../session/artifacts";
import { createTools, type ToolSession } from "../tools";
import { disposeEvalArtifacts } from "./artifact-values";
import { disposeVmContextsByOwner, executeInVmContext } from "./js/context-manager";
import type { KernelControlResult } from "./kernel-control";
import { buildKernelTargetCommand, type KernelTarget, kernelTransportEnv, spawnKernelTarget } from "./kernel-target";
import { disposeKernelSessionsByOwner } from "./py/executor";
import { PythonKernel } from "./py/kernel";
import { registerPyToolBridge } from "./py/tool-bridge";

const hostEntry = process.env.PROTO_KERNEL_TARGET_TEST_CLI ?? `${import.meta.dir}/../cli.ts`;
const targets: KernelTarget[] = [];
if (process.env.PROTO_KERNEL_TARGET_TEST_SSH)
	targets.push({
		kind: "ssh",
		host: process.env.PROTO_KERNEL_TARGET_TEST_SSH,
		cwd: "/tmp",
		hostCommand: [process.execPath, hostEntry],
	});
if (process.env.PROTO_KERNEL_TARGET_TEST_CONTAINER)
	targets.push({
		kind: "container",
		container: process.env.PROTO_KERNEL_TARGET_TEST_CONTAINER,
		cwd: "/tmp/proto-kernel-target-work",
		hostCommand: ["/opt/proto-test-bun", hostEntry],
	});
if (!targets.length) test.skip("real targets require explicit existing SSH/container fixture environment", () => {});

async function sessionFixture(cwd: string): Promise<{ session: ToolSession; calls: string[] }> {
	const artifacts = new ArtifactManager(`${cwd}/artifacts`);
	const calls: string[] = [];
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactManager: () => artifacts,
		getArtifactsDir: () => artifacts.dir,
		allocateOutputArtifact: (kind: string) => artifacts.allocatePath(kind),
		getToolByName: (name: string) =>
			name === "target_probe"
				? {
						name,
						label: name,
						description: "",
						parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
						execute: async (_id: string, args: { value: string }) => {
							calls.push(args.value);
							return { content: [{ type: "text", text: `parent:${args.value}` }] };
						},
					}
				: undefined,
	} as unknown as ToolSession;
	return { session, calls };
}

for (const target of targets) {
	for (const language of ["python", "bun"] as const) {
		test(`${target.kind} ${language} kernel reset preserves the configured target through Bash save and restore`, async () => {
			if (target.kind === "local") throw new Error("This fixture must be remote");
			using tmp = TempDir.createSync("@kernel-target-tools-");
			const { session } = await sessionFixture(tmp.path());
			const owner = crypto.randomUUID();
			const checkpoint = `${target.cwd}/proto-target-state-${owner}.json`;
			session.getSessionId = () => owner;
			session.getEvalSessionId = () => owner;
			session.getEvalKernelOwnerId = () => owner;
			session.settings = Settings.isolated({
				"tools.xdev": false,
				"bash.autoBackground.enabled": false,
				"bash.direnv": "off",
			});
			try {
				await createTools(session, ["bash", "context"]);
				const context = session.toolRegistry!.get("context")!;
				const bash = session.toolRegistry!.get("bash")!;
				const lane = `target-${language}`;
				const started = await context.execute("target-start", {
					resource: "kernel",
					op: "start",
					language,
					lane,
					target,
					cwd: target.cwd,
				});
				expect(started.isError).not.toBe(true);
				const initial = (started.details as KernelControlResult).kernel!;
				const command = language;
				const seed =
					language === "python"
						? `remote_lane_value = 41\nsave_state(${JSON.stringify(checkpoint)}, ["remote_lane_value"])`
						: `globalThis.remote_lane_value = 41; await saveState(${JSON.stringify(checkpoint)}, ["remote_lane_value"]);`;
				expect(
					(await bash.execute("target-seed", { lane, command: `${command} <<'CELL'\n${seed}\nCELL` })).isError,
				).not.toBe(true);
				const read =
					language === "python"
						? 'print(str(remote_lane_value + 1) + ":" + kernel_state()["target"]["kind"])'
						: 'console.log(String(remote_lane_value + 1) + ":" + kernelState().target.kind)';
				expect(
					(await bash.execute("target-read", { lane, command: `${command} <<'CELL'\n${read}\nCELL` })).content,
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "text", text: expect.stringContaining(`42:${target.kind}`) }),
					]),
				);
				for (const explicitInterpreter of [false, true]) {
					const reset = await context.execute("target-reset", {
						resource: "kernel",
						op: "reset",
						language,
						lane,
						...(explicitInterpreter ? { interpreter: initial.interpreter } : {}),
					});
					expect(reset.isError).not.toBe(true);
					const restarted = (reset.details as KernelControlResult).kernel!;
					const restore =
						language === "python"
							? `
assert "remote_lane_value" not in globals()
assert kernel_state()["generation"] == ${JSON.stringify(restarted.generation)}
load_state(${JSON.stringify(checkpoint)})
${read}
`
							: `
if ("remote_lane_value" in globalThis) throw new Error("reset retained old bindings");
if (kernelState().generation !== ${JSON.stringify(restarted.generation)}) throw new Error("Bash launched a second kernel after reset");
await loadState(${JSON.stringify(checkpoint)});
${read}
`;
					const restored = await bash.execute("target-restore", {
						lane,
						command: `${command} <<'CELL'\n${restore}\nCELL`,
					});
					if (restored.isError) throw new Error(JSON.stringify(restored.content));
					expect(restored.content).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ type: "text", text: expect.stringContaining(`42:${target.kind}`) }),
						]),
					);
					expect(restarted.generation).not.toBe(initial.generation);
					if (!explicitInterpreter) expect(restarted.environment).toEqual(initial.environment);
					const listed = await context.execute("target-list", { resource: "kernel", op: "list", language, lane });
					expect((listed.details as KernelControlResult).kernels).toHaveLength(1);
				}
				expect(
					(await context.execute("target-close", { resource: "kernel", op: "close", language, lane })).isError,
				).not.toBe(true);
			} finally {
				await Promise.all([
					disposeBashSessions(owner),
					disposeKernelSessionsByOwner(owner),
					disposeVmContextsByOwner(owner),
				]);
				disposeEvalArtifacts(session);
				const cleanup = await buildKernelTargetCommand(target, ["rm", "-f", checkpoint], { cwd: target.cwd! });
				const removed = Bun.spawn(cleanup, {
					env: kernelTransportEnv(),
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
				});
				await new Response(removed.stderr).text();
				expect(await removed.exited).toBe(0);
			}
		}, 60_000);
	}
	test(`${target.kind} target shutdown terminates descendant processes rather than only the local transport`, async () => {
		if (target.kind === "local") throw new Error("This fixture must be remote");
		const launched = await spawnKernelTarget(target, ["sh", "-c", "sleep 60 & printf '%s\\n' \"$!\"; wait"], {
			cwd: target.cwd!,
		});
		const output = readLines(launched.proc.stdout)[Symbol.asyncIterator]();
		try {
			const first = await output.next();
			const pid = Number(new TextDecoder().decode(first.value));
			expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
			expect(await launched.terminate()).toBe(true);
			const check = await buildKernelTargetCommand(target, ["sh", "-c", `kill -0 ${pid}`], { cwd: target.cwd! });
			const probe = Bun.spawn(check, {
				env: kernelTransportEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await probe.exited).not.toBe(0);
		} finally {
			await launched.terminate();
			await output.return?.(undefined);
		}
	}, 30_000);
	test(`${target.kind} missing runtimes fail explicitly without falling back to a local interpreter`, async () => {
		if (target.kind === "local") throw new Error("This fixture must be remote");
		await expect(
			PythonKernel.start({ cwd: import.meta.dir, target: { ...target, interpreter: "/proto-test-missing-python" } }),
		).rejects.toThrow();
		await expect(
			PythonKernel.start({ cwd: import.meta.dir, target: { ...target, cwd: "/proto-test-missing-directory" } }),
		).rejects.toThrow("exited with code");
		using tmp = TempDir.createSync("@kernel-target-missing-");
		const { session } = await sessionFixture(tmp.path());
		const ownerId = crypto.randomUUID();
		try {
			await expect(
				executeInVmContext({
					runtime: "bun",
					sessionKey: ownerId,
					sessionId: ownerId,
					ownerId,
					session,
					cwd: target.cwd!,
					target: { ...target, hostCommand: ["/proto-test-missing-cli"] },
					code: 'throw Error("local execution must not happen")',
					filename: "missing-host.js",
					runState: {},
				}),
			).rejects.toThrow("Remote JavaScript requires an installed compatible proto");
		} finally {
			await disposeVmContextsByOwner(ownerId);
		}
	}, 30_000);
	test(`${target.kind} Python preserves state, streams bytes, proxies parent tools, identifies target, and cancels`, async () => {
		using tmp = TempDir.createSync("@kernel-target-smoke-");
		const { session, calls } = await sessionFixture(tmp.path());
		const bridge = `target:${crypto.randomUUID()}`;
		const kernel = await PythonKernel.start({
			cwd: import.meta.dir,
			target,
			env: {
				PI_TOOL_BRIDGE_SESSION: bridge,
				PI_TOOL_BRIDGE_TOKEN: "must-not-leak",
				PI_TOOL_BRIDGE_URL: "http://127.0.0.1:1",
			},
		});
		try {
			expect((await kernel.execute("target_value = 41")).status).toBe("ok");
			let output = "";
			const runId = crypto.randomUUID();
			const unregister = registerPyToolBridge(bridge, runId, { toolSession: session });
			try {
				const result = await kernel.execute(
					`import os,json
assert 'PI_TOOL_BRIDGE_TOKEN' not in os.environ
print(target_value + 1)
print(tool.target_probe(value="python"))
from pathlib import Path
import base64
remote_file = Path("proto-target-artifact-" + __import__("uuid").uuid4().hex)
try:
    remote_file.write_bytes(bytes([0,255,65]))
    remote_ref = publish_artifact(remote_file.read_bytes(), kind="binary")
    remote_file.write_bytes(base64.b64decode(read_artifact(remote_ref, encoding="base64")["data"]))
    assert remote_file.read_bytes() == bytes([0,255,65])
finally:
    remote_file.unlink(missing_ok=True)
print(json.dumps(kernel_state()))`,
					{
						id: runId,
						onChunk: text => {
							output += text;
						},
						timeoutMs: 15_000,
					},
				);
				expect(result.status).toBe("ok");
			} finally {
				unregister();
			}
			expect(calls).toEqual(["python"]);
			expect(output).toContain("42");
			expect(output).toContain("parent:python");
			const state = JSON.parse(output.split("\n").find(line => line.startsWith("{"))!);
			expect(state.target.kind).toBe(target.kind);
			expect(state.cwd).toBe(target.kind === "local" ? import.meta.dir : target.cwd);
			expect(state.generation).toBe(kernel.id);
			const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, index) => index % 256);
			const received: Uint8Array[] = [];
			const copied = await kernel.execute(
				`import sys
while chunk := sys.stdin.buffer.read(32768):
    sys.stdout.buffer.write(chunk)`,
				{
					stdin: new Blob([bytes]).stream(),
					onBytes: chunk => {
						received.push(chunk);
					},
					timeoutMs: 15_000,
				},
			);
			expect(copied.status).toBe("ok");
			expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
			const controller = new AbortController();
			const cancelled = await kernel.execute(
				`import asyncio
print("started", flush=True)
await asyncio.Event().wait()`,
				{
					signal: controller.signal,
					onChunk: text => {
						if (text.includes("started")) controller.abort(new Error("stop target"));
					},
					timeoutMs: 15_000,
				},
			);
			expect(cancelled.cancelled).toBe(true);
			expect(cancelled.kernelKilled).not.toBe(true);
			expect((await kernel.execute("assert target_value == 41")).status).toBe("ok");
		} finally {
			expect((await kernel.shutdown()).confirmed).toBe(true);
			disposeEvalArtifacts(session);
		}
	}, 60_000);

	test(`${target.kind} Bun JavaScript preserves state, streams bytes, proxies parent tools, identifies target, and cancels`, async () => {
		using tmp = TempDir.createSync("@kernel-target-smoke-");
		const { session, calls } = await sessionFixture(tmp.path());
		const ownerId = crypto.randomUUID();
		const options = {
			runtime: "bun" as const,
			sessionKey: ownerId,
			sessionId: ownerId,
			ownerId,
			session,
			target,
			cwd: target.kind === "local" ? import.meta.dir : target.cwd!,
			filename: "target-smoke.js",
			timeoutMs: 15_000,
		};
		try {
			await executeInVmContext({ ...options, code: "globalThis.target_value = 41", runState: {} });
			let output = "";
			await executeInVmContext({
				...options,
				code: 'console.log(target_value + 1); console.log(await tool.target_probe({value:"bun"})); const remoteFile = "proto-target-artifact-" + crypto.randomUUID(); try { await Bun.write(remoteFile, new Uint8Array([0,255,65])); const ref = await publishArtifact(new Uint8Array(await Bun.file(remoteFile).arrayBuffer()), {kind:"binary"}); const page = await readArtifact(ref,{encoding:"base64"}); await Bun.write(remoteFile, Buffer.from(page.data,"base64")); if (Buffer.from(await Bun.file(remoteFile).arrayBuffer()).toString("base64") !== "AP9B") throw Error("artifact transfer corrupted"); } finally { await Bun.file(remoteFile).delete(); } console.log(JSON.stringify(kernelState()));',
				runState: {
					onText: text => {
						output += text;
					},
				},
			});
			expect(calls).toEqual(["bun"]);
			expect(output).toContain("42");
			expect(output).toContain("parent:bun");
			const state = JSON.parse(output.split("\n").find(line => line.startsWith("{"))!);
			expect(state.target.kind).toBe(target.kind);
			expect(state.cwd).toBe(options.cwd);
			const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, index) => index % 256);
			const received: Uint8Array[] = [];
			await executeInVmContext({
				...options,
				code: 'import { once } from "node:events"; for await (const chunk of process.stdin) { if (!process.stdout.write(chunk)) await once(process.stdout,"drain"); }',
				stdin: new Blob([bytes]).stream(),
				runState: {
					onBytes: chunk => {
						received.push(chunk);
					},
				},
			});
			expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
			const controller = new AbortController();
			await expect(
				executeInVmContext({
					...options,
					code: 'console.log("started"); await Promise.withResolvers().promise',
					runState: {
						signal: controller.signal,
						onText: text => {
							if (text.includes("started")) controller.abort(new Error("stop target"));
						},
					},
				}),
			).rejects.toThrow("stop target");
		} finally {
			await disposeVmContextsByOwner(ownerId);
			disposeEvalArtifacts(session);
		}
	}, 60_000);
}
