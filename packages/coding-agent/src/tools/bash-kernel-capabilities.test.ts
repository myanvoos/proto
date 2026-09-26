import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { disposeEvalArtifacts } from "../eval/artifact-values";
import { disposeSessionDelegations } from "../eval/delegation";
import { disposeSessionExecutionEvents } from "../eval/execution-events";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { KERNEL_LANGUAGES } from "../eval/kernel-environment";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import { ArtifactManager } from "../session/artifacts";
import { createTools, type Tool, type ToolSession } from ".";

async function fixture(run: (tools: Map<string, Tool>, cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-capabilities-"));
	const owner = `kernel-capabilities:${crypto.randomUUID()}`;
	const artifacts = new ArtifactManager(path.join(cwd, "artifacts"));
	const jobs = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": false,
			"tools.xdev": false,
			"bash.direnv": "off",
		}),
		getSessionId: () => owner,
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
		await createTools(session, ["bash", "kernel", "read"]);
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
			const kernel = tools.get("kernel")!;
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
			const reset = await kernel.execute("reset-capabilities", { op: "reset", language, lane: "analysis" });
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
