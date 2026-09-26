import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { disposeEvalArtifacts } from "../eval/artifact-values";
import { bridgeCwdFor } from "../eval/bridge-cwd";
import { disposeSessionDelegations } from "../eval/delegation";
import { disposeSessionExecutionEvents } from "../eval/execution-events";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { KERNEL_LANGUAGES } from "../eval/kernel-environment";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import { daemonClientForProject } from "../launch/client";
import { daemonRuntimeDir } from "../launch/paths";
import { ArtifactManager } from "../session/artifacts";
import { createTools, type Tool, type ToolSession } from ".";

async function fixture(run: (tools: Map<string, Tool>, cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-capabilities-"));
	const owner = `kernel-capabilities:${crypto.randomUUID()}`;
	const artifacts = new ArtifactManager(path.join(cwd, "artifacts"));
	const jobs = new AsyncJobManager({});
	const session: ToolSession = {
		get cwd() {
			return bridgeCwdFor(session) ?? cwd;
		},
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": false,
			"tools.xdev": true,
			"bash.direnv": "off",
		}),
		getSessionId: () => owner,
		getAsyncJobOwnerId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: kind => artifacts.allocatePath(kind),
		asyncJobManager: jobs,
	};
	try {
		await createTools(session, ["bash", "context", "read", "jobs"]);
		const tools = session.toolRegistry!;
		session.getToolByName = name => tools.get(name);
		session.getToolForEvalBridge = name => tools.get(name);
		session.getEvalBridgeToolNames = () => [...tools.keys()];
		await run(tools, cwd);
	} finally {
		await disposeSessionExecutionEvents(session);
		await disposeSessionDelegations(session);
		await jobs.dispose();
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		disposeEvalArtifacts(session);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

for (const language of KERNEL_LANGUAGES) {
	test(`${language} shares supervised process references with shell jobs across cell directories`, async () => {
		await fixture(async (tools, cwd) => {
			const bash = tools.get("bash")!;
			const cellDir = path.join(cwd, "cell");
			const otherDir = path.join(cwd, "other");
			await Promise.all([fs.mkdir(cellDir), fs.mkdir(otherDir)]);
			const run = async (command: string, runCwd = cellDir, env?: Record<string, string>) => {
				const result = await bash.execute("process-route", { command, cwd: runCwd, env });
				const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
				expect(result.isError, text).not.toBe(true);
				return text;
			};
			const cell = (source: string, runCwd = cellDir) => run(`${language} <<'CELL'\n${source}\nCELL`, runCwd);
			const shellJobs = (args: Record<string, unknown>) =>
				run('protolens jobs --json "$JOBS_ARGS"', cellDir, { JOBS_ARGS: JSON.stringify(args) });
			const kernelJobs = async (args: Record<string, unknown>, runCwd = cellDir) => {
				const input = JSON.stringify(args);
				const output = await cell(
					language === "python"
						? `result = tool.jobs(json.loads(${JSON.stringify(input)}))\nassert not result.get("hasError"), result\nprint("RESULT=" + json.dumps({"ref": result["details"].get("ref"), "cwd": result["details"].get("process", {}).get("spec", {}).get("cwd"), "text": result["text"] if ${JSON.stringify(String(args.op))} == "logs" else ""}))`
						: `var result = await tool.jobs(${input}); if (result.hasError) throw new Error(JSON.stringify(result)); console.log("RESULT=" + JSON.stringify({ref: result.details.ref, cwd: result.details.process?.spec?.cwd, text: ${JSON.stringify(args.op)} === "logs" ? result.text : ""}));`,
					runCwd,
				);
				return JSON.parse(output.match(/^RESULT=(.+)$/m)![1]!);
			};
			const script =
				'console.log("READY:" + process.cwd()); for await (const line of console) { console.log("echo:" + line); if (line === "exit") break; }';
			const start = { application: process.execPath, args: ["-e", script], cwd: cellDir, pty: false };
			try {
				// Shell launch and kernel tools must use one broker even though cell cwd != session cwd.
				const started = await shellJobs({
					op: "start",
					name: "shell-service",
					...start,
					ready: { log: "READY:", timeoutMs: 10_000 },
				});
				const shellRef = JSON.parse(started.match(/Ref: (\{[^\n]+\})/)![1]!);
				const inspected = await kernelJobs({ op: "inspect", target: shellRef });
				expect(inspected.ref).toEqual(shellRef);
				expect(inspected.cwd).toBe(cellDir);
				const watched = await kernelJobs({ op: "watch", source: shellRef, match: "echo:exit" });
				await kernelJobs({ op: "input", target: shellRef, text: "exit" }, otherDir);
				await kernelJobs({ op: "wait", targets: [shellRef], timeoutMs: 10_000 });
				const logs = await kernelJobs({ op: "logs", target: shellRef }, otherDir);
				expect(logs.text).toContain("echo:exit");
				await kernelJobs({ op: "unwatch", target: watched.ref });

				// Kernel start must also be visible and controllable from the shell by its exact ref.
				const kernelStarted = await kernelJobs({
					op: "start",
					name: "kernel-service",
					...start,
					ready: { log: "READY:", timeoutMs: 10_000 },
				});
				const kernelRef = kernelStarted.ref;
				expect(await shellJobs({ op: "inspect", target: kernelRef })).toContain(kernelRef.id);
				await shellJobs({ op: "cancel", target: kernelRef });
				await shellJobs({ op: "wait", targets: [kernelRef], timeoutMs: 10_000 });
				expect(await shellJobs({ op: "logs", target: kernelRef })).toContain(`READY:${cellDir}`);

				const delegated = await cell(
					language === "python"
						? `lease = delegate([{"tool":"__runtime__","operations":["artifact_publish"]}], ttl_ms=60000)\nlaunched = launch_delegated(lease, name="delegated-service", application=${JSON.stringify(process.execPath)}, args=${JSON.stringify(start.args)}, cwd=${JSON.stringify(cellDir)})\nprint("PROCESS=" + json.dumps({key: launched["process"][key] for key in ["id", "name"]}))`
						: `var lease = await delegate([{tool:"__runtime__",operations:["artifact_publish"]}], {ttlMs:60000}); var launched = await launchDelegated(lease, {name:"delegated-service",application:${JSON.stringify(process.execPath)},args:${JSON.stringify(start.args)},cwd:${JSON.stringify(cellDir)}}); console.log("PROCESS=" + JSON.stringify({id: launched.process.id, name: launched.process.name}));`,
				);
				const processInfo = JSON.parse(delegated.match(/^PROCESS=(.+)$/m)![1]!);
				const delegatedRef = { kind: "process", id: processInfo.id, name: processInfo.name };
				expect(await shellJobs({ op: "inspect", target: delegatedRef })).toContain(delegatedRef.id);
				await shellJobs({ op: "input", target: delegatedRef, text: "exit" });
				await shellJobs({ op: "wait", targets: [delegatedRef], timeoutMs: 10_000 });
				expect(await shellJobs({ op: "logs", target: delegatedRef })).toContain("echo:exit");
				// Default process cwd follows the current cell, but lease cleanup keeps the session broker.
				const active = await cell(
					language === "python"
						? `active = launch_delegated(lease, name="delegated-active", application=${JSON.stringify(process.execPath)}, args=${JSON.stringify(start.args)})\nprint("PROCESS=" + json.dumps({key: active["process"][key] for key in ["id", "name"]}))`
						: `var active = await launchDelegated(lease, {name:"delegated-active",application:${JSON.stringify(process.execPath)},args:${JSON.stringify(start.args)}}); console.log("PROCESS=" + JSON.stringify({id: active.process.id, name: active.process.name}));`,
					otherDir,
				);
				const activeInfo = JSON.parse(active.match(/^PROCESS=(.+)$/m)![1]!);
				const activeRef = { kind: "process", id: activeInfo.id, name: activeInfo.name };
				expect((await kernelJobs({ op: "inspect", target: activeRef })).cwd).toBe(otherDir);
				await cell(language === "python" ? "revoke_delegation(lease)" : "await revokeDelegation(lease);", cwd);
				expect(await shellJobs({ op: "inspect", target: activeRef })).toContain("exited");
			} finally {
				// A broken implementation may have started a broker under either cell cwd.
				for (const project of [cwd, cellDir, otherDir]) {
					const client = await daemonClientForProject(project);
					await client.request({ op: "shutdown" }).finally(() => client.close());
					await fs.rm(daemonRuntimeDir(project), { recursive: true, force: true });
				}
			}
		});
	}, 60_000);

	test(`${language} delegates an ordinary interpreter client and revokes its lease without exporting the parent bridge`, async () => {
		await fixture(async tools => {
			const source =
				language === "python"
					? `
import subprocess, sys
lease = delegate([{"tool": "__runtime__", "operations": ["artifact_publish", "artifact_read"]}], ttl_ms=30000, max_requests=4, expose=True)
script = "from proto_session import SessionClient; import json, os; client=SessionClient.from_env(); ref=client.publish_artifact(bytes([0,128,255])); page=client.read_artifact(ref, encoding='base64'); print(json.dumps({'bytes':page['data'],'parentBridge':'PI_TOOL_BRIDGE_TOKEN' in os.environ},separators=(',',':')))"
child = subprocess.run([sys.executable, "-c", script], env={"PATH": os.environ["PATH"], **lease["env"]}, capture_output=True, text=True, check=True)
print(child.stdout.strip())
revoke_delegation(lease)
assert next(item for item in delegations()["leases"] if item["id"] == lease["lease"]["id"])["state"] == "revoked"
`
					: `
import { execFileSync } from "node:child_process";
const lease = await delegate([{tool: "__runtime__", operations: ["artifact_publish", "artifact_read"]}], {ttlMs: 30000, maxRequests: 4, expose: true});
const script = 'import {SessionClient} from ' + JSON.stringify(lease.clients.javascript.url) + '; const client=await SessionClient.fromEnv(); const ref=await client.publishArtifact(new Uint8Array([0,128,255])); const page=await client.readArtifact(ref,{encoding:"base64"}); console.log(JSON.stringify({bytes:page.data,parentBridge:"PI_TOOL_BRIDGE_TOKEN" in process.env}));';
const stdout = execFileSync("node", ["--input-type=module", "-e", script], {env: {PATH: process.env.PATH, ...lease.env}, encoding: "utf8"});
console.log(stdout.trim());
await revokeDelegation(lease);
if ((await delegations()).leases.find(item => item.id === lease.lease.id).state !== "revoked") throw new Error("lease remains active");
`;
			const command = language;
			const result = await tools
				.get("bash")!
				.execute("delegate-client", { command: `${command} <<'CELL'\n${source}\nCELL` });
			expect(result.isError).not.toBe(true);
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining('{"bytes":"AID/","parentBridge":false}'),
					}),
				]),
			);
		});
	}, 30_000);
	test(`${language} restores selected state and usable artifact handles after an outside-kernel reset`, async () => {
		await fixture(async tools => {
			const bash = tools.get("bash")!;
			const context = tools.get("context")!;
			const seed =
				language === "python"
					? `
items = {"values": [3, 5]}
blob = publish_artifact(bytes([0, 128, 255]), kind="binary")
previous_generation = kernel_state()["generation"]
save_state("selected.json", ["items", "blob", "previous_generation"])
`
					: `
const items = {values: [3, 5]};
const blob = await publishArtifact(new Uint8Array([0, 128, 255]), {kind: "binary"});
const previous_generation = kernelState().generation;
await saveState("selected.json", ["items", "blob", "previous_generation"]);
`;
			const command = language;
			const seeded = await bash.execute("seed-capabilities", {
				lane: "analysis",
				command: `${command} <<'CELL'\n${seed}\nCELL`,
			});
			expect(seeded.isError).not.toBe(true);
			const reset = await context.execute("reset-capabilities", {
				resource: "kernel",
				op: "reset",
				language,
				lane: "analysis",
			});
			expect(reset.isError).not.toBe(true);
			const restore =
				language === "python"
					? `
import base64
assert "items" not in globals()
load_state("selected.json")
assert previous_generation != kernel_state()["generation"]
print(json.dumps({"sum": sum(items["values"]), "bytes": list(base64.b64decode(read_artifact(blob, encoding="base64")["data"]))}, separators=(",", ":")))
`
					: `
if ("items" in globalThis) throw new Error("reset kept previous bindings");
await loadState("selected.json");
if (previous_generation === kernelState().generation) throw new Error("reset kept previous generation");
const page = await readArtifact(blob, {encoding: "base64"});
console.log(JSON.stringify({sum: items.values.reduce((sum, value) => sum + value, 0), bytes: [...Buffer.from(page.data, "base64")]}));
`;
			const restored = await bash.execute("restore-capabilities", {
				lane: "analysis",
				command: `${command} <<'CELL'\n${restore}\nCELL`,
			});
			expect(restored.isError).not.toBe(true);
			expect(restored.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining('{"sum":8,"bytes":[0,128,255]}'),
					}),
				]),
			);
		});
	}, 30_000);

	test(`${language} event iterator drains paged async Bash results and exposes failure instead of progress success`, async () => {
		await fixture(async tools => {
			const source =
				language === "python"
					? `
work = start_tool("bash", {"command": "printf progress; sleep 0.05; exit 7", "async": True})
rows = list(tool_events(work, limit=1))
result = next(row["data"] for row in rows if row["kind"] == "result")
job = result["jobs"][0]["value"]
print(json.dumps({"status": rows[-1]["data"]["status"], "terminal": rows[-1]["terminal"], "exit": job["result"]["details"]["execution"]["exitCode"]}, separators=(",", ":")))
dispose_tool(work)
`
					: `
const work = await startTool("bash", {command: "printf progress; sleep 0.05; exit 7", async: true});
const rows = [];
for await (const row of toolEvents(work, {limit: 1})) rows.push(row);
const result = rows.find(row => row.kind === "result").data;
const job = result.jobs[0].value;
console.log(JSON.stringify({status: rows.at(-1).data.status, terminal: rows.at(-1).terminal, exit: job.result.details.execution.exitCode}));
await disposeTool(work);
`;
			const command = language;
			const result = await tools
				.get("bash")!
				.execute("consume-events", { command: `${command} <<'CELL'\n${source}\nCELL` });
			expect(result.isError).not.toBe(true);
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining('{"status":"failed","terminal":true,"exit":7}'),
					}),
				]),
			);
		});
	}, 30_000);
}

test("Python, Node, and Bun kernels restore each other's state snapshots", async () => {
	await fixture(async tools => {
		const bash = tools.get("bash")!;
		const cell = async (language: string, source: string) => {
			const result = await bash.execute(`state-${language}`, {
				lane: "state",
				command: `${language} <<'CELL'\n${source}\nCELL`,
			});
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(result.isError, text).not.toBe(true);
			return text;
		};
		await cell(
			"python",
			`
blob = publish_artifact(bytes([0, 128, 255]), kind="binary")
shared = {"values": [3, 5], "label": "雪", "zero": -0.0, "payload": b"\\x00\\xff", "mutable": bytearray(b"ab"), "blob": blob}
huge = 2**64
save_state("python.json", ["shared"])
save_state("huge.json", ["huge"])
`,
		);
		await cell(
			"node",
			`
await loadState("python.json");
if (!Buffer.isBuffer(shared.payload) || shared.payload[1] !== 255 || shared.mutable.toString() !== "ab") throw new Error("Python bytes are unusable in Node");
if (!Object.is(shared.zero, -0) || shared.label !== "雪" || shared.values[0] + shared.values[1] !== 8) throw new Error("Python values changed in Node");
if ((await readArtifact(shared.blob, {encoding: "base64"})).data !== "AID/") throw new Error("Python artifact ref is unreadable in Node");
let hugeError = "";
try { await loadState("huge.json"); } catch (error) { hugeError = error.message; }
if (!hugeError.includes("safe integer") || "huge" in globalThis) throw new Error("unsafe Python integer was not rejected: " + hugeError);
const relay = {...shared, bytes: new Uint8Array([1, 2]), raw: new Uint8Array([3]).buffer, bare: Object.assign(Object.create(null), {key: 7})};
await saveState("node.json", ["relay"]);
`,
		);
		await cell(
			"bun",
			`
await loadState("node.json");
if (!(relay.bytes instanceof Uint8Array) || Buffer.isBuffer(relay.bytes) || !(relay.raw instanceof ArrayBuffer)) throw new Error("Node byte kinds changed in Bun");
if (Object.getPrototypeOf(relay.bare) !== null || relay.bare.key !== 7 || !Object.is(relay.zero, -0)) throw new Error("Node values changed in Bun");
await saveState("bun.json", ["relay"]);
`,
		);
		const restored = await cell(
			"python",
			`
import math
del huge
load_state("bun.json")
load_state("huge.json")
assert huge == 2**64
assert all(type(relay[key]) is bytes for key in ("payload", "mutable", "bytes", "raw"))
assert relay["bare"] == {"key": 7} and math.copysign(1, relay["zero"]) < 0
print(json.dumps({"payload": list(relay["payload"]), "mutable": relay["mutable"].decode(), "bytes": list(relay["bytes"] + relay["raw"]), "artifact": read_artifact(relay["blob"], encoding="base64")["data"]}, separators=(",", ":")))
`,
		);
		expect(restored).toContain('{"payload":[0,255],"mutable":"ab","bytes":[1,2,3],"artifact":"AID/"}');
	});
}, 60_000);
