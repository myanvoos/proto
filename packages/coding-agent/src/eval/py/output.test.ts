import { expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { registerArtifactsDir } from "../../internal-urls/registry-helpers";
import { AgentRegistry } from "../../registry/agent-registry";
import type { Tool, ToolSession } from "../../tools";
import { BashTool } from "../../tools/bash";
import { ReadTool } from "../../tools/read";
import { releaseFsObservationLedger, retainFsObservationLedger } from "../fs-observations";
import { registerPythonHarnessRun } from "./harness-bridge";
import { checkPythonKernelAvailability } from "./kernel";

async function fixture(cwd: string) {
	const owner = `output:${crypto.randomUUID()}`;
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		hasUI: false,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	retainFsObservationLedger(owner, owner);
	const available = await checkPythonKernelAvailability(cwd, undefined, { forceProbe: true });
	if (!available.pythonPath) throw new Error(available.reason);
	return {
		session,
		async run(code: string) {
			const run = await registerPythonHarnessRun(session);
			const env = { ...process.env, ...run.env };
			delete env.PI_SESSION_FILE;
			delete env.PI_ARTIFACTS_DIR;
			try {
				return (
					await ptree.exec(
						[
							available.pythonPath!,
							"-c",
							`import os
assert "PI_SESSION_FILE" not in os.environ and "PI_ARTIFACTS_DIR" not in os.environ
import proto_harness as harness
${code}`,
						],
						{ cwd, env, timeout: 20_000, maxStdoutBytes: 64 * 1024 },
					)
				).stdout;
			} finally {
				await run.dispose();
			}
		},
		dispose() {
			releaseFsObservationLedger(owner, owner);
		},
	};
}

test("fresh output reads complete host-published bodies and retains metadata, selection formats and artifact teaching without ambient session paths", async () => {
	using directory = TempDir.createSync("@python-output-host-");
	const host = directory.join("published");
	const unregister = registerArtifactsDir(host);
	const id = `output-${crypto.randomUUID()}`;
	const jsonId = `json-${crypto.randomUUID()}`;
	const ansiId = `ansi-${crypto.randomUUID()}`;
	const body = `first\n${"x".repeat(2 * 1024 * 1024)}\nlast\n`;
	const file = `${host}/${id}.md`;
	await Bun.write(file, body);
	await Bun.write(`${host}/${jsonId}.md`, '{"items":[{"value":1},{"value":42}]}');
	await Bun.write(`${host}/${ansiId}.md`, "\u001b[31mred\u001b[0m\n");
	const f = await fixture(directory.path());
	try {
		expect(
			await f.run(`value = harness.output(${JSON.stringify(id)})
assert len(value) == ${body.length} and value.startswith(${JSON.stringify("first\n")}) and value.endswith(${JSON.stringify("\nlast\n")})
meta = harness.output(${JSON.stringify(id)}, format="json", offset=3, limit=1)
assert meta == {"id": ${JSON.stringify(id)}, "path": ${JSON.stringify(file)}, "line_count": 3, "char_count": ${body.length}, "content": "last", "range": {"start_line": 3, "end_line": 3, "total_lines": 3}}, meta
assert harness.output(${JSON.stringify(jsonId)}, query=".items[-1].value") == "42"
assert harness.output(${JSON.stringify(ansiId)}, format="stripped") == ${JSON.stringify("red\n")}
query_meta = harness.output(${JSON.stringify(jsonId)}, query=".items[-1].value", format="json")
assert query_meta["query"] == ".items[-1].value" and query_meta["content"] == "42" and query_meta["char_count"] == 2
try: harness.output(${JSON.stringify(id)}, query=".items")
except ValueError as error: assert "not valid JSON" in str(error)
else: raise AssertionError("non-JSON query accepted")
assert len(harness.output(${JSON.stringify(id)}, ${JSON.stringify(jsonId)})) == 2
for kwargs, hint in [({"format":"invalid"}, "Invalid output format"), ({"query":".items", "offset":1}, "cannot be combined"), ({"offset":4}, "beyond end")]:
    try: harness.output(${JSON.stringify(id)}, **kwargs)
    except ValueError as error: assert hint in str(error), error
    else: raise AssertionError("invalid selection accepted")
for missing in [987654321, "artifact://987654321"]:
    try: harness.output(missing)
    except FileNotFoundError as error:
        assert "output() reads an agent/task output id" in str(error)
        assert "read artifact://987654321:A-B" in str(error)
    else: raise AssertionError("missing output accepted")
print("complete host output")`),
		).toContain("complete host output");
	} finally {
		f.dispose();
		unregister();
	}
}, 30_000);

test("fresh output retains protocol superseded and aborted progress warnings while querying the published JSON body", async () => {
	using directory = TempDir.createSync("@python-output-warnings-");
	const unregister = registerArtifactsDir(directory.path());
	const id = `busy-${crypto.randomUUID()}`;
	const aborted = `aborted-${crypto.randomUUID()}`;
	await Bun.write(directory.join(`${id}.md`), '{"answer":42}');
	const registry = AgentRegistry.global();
	registry.register({ id, label: id, kind: "sub", session: null, status: "running" });
	registry.register({ id: aborted, label: aborted, kind: "sub", session: null, status: "aborted" });
	const f = await fixture(directory.path());
	try {
		expect(
			await f.run(`warning = harness.output(${JSON.stringify(id)})
assert "PREVIOUS run" in warning and warning.rstrip().endswith('{"answer":42}'), warning
assert harness.output(${JSON.stringify(id)}, query=".answer") == "42"
meta = harness.output(${JSON.stringify(id)}, format="json")
assert meta["path"] == ${JSON.stringify(`agent://${id}`)} and meta["char_count"] == len(warning), meta
assert "(aborted)" in harness.output(${JSON.stringify(aborted)})
print("protocol warnings preserved")`),
		).toContain("protocol warnings preserved");
	} finally {
		f.dispose();
		registry.unregister(id);
		registry.unregister(aborted);
		unregister();
	}
}, 30_000);

test("fresh output honors host read and filesystem policy refusals without bypassing them through protocol fallback", async () => {
	using directory = TempDir.createSync("@python-output-policy-");
	const unregister = registerArtifactsDir(directory.path());
	const id = `private-${crypto.randomUUID()}`;
	await Bun.write(directory.join(`${id}.md`), "must not leak");
	const f = await fixture(directory.path());
	try {
		for (const name of ["read", "fs.read"]) {
			f.session.beforeEvalToolCall = async tool =>
				tool.name === name ? { block: true, reason: `policy denied ${name}` } : undefined;
			expect(
				await f.run(`try: harness.output(${JSON.stringify(id)})
except RuntimeError as error: assert ${JSON.stringify(`policy denied ${name}`)} in str(error), error
else: raise AssertionError("output policy bypassed")
print("policy respected")`),
			).toContain("policy respected");
		}
	} finally {
		f.dispose();
		unregister();
	}
}, 30_000);
