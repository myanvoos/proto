import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, ptree, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { parseBlobRef } from "../../session/blob-store";
import { SessionManager } from "../../session/session-manager";
import { isPersistedReplayBlobRef, PERSISTED_REPLAY_BLOB_KEY } from "../../session/session-persistence";
import {
	activateSessionStateRestore,
	captureSessionState,
	prepareSessionStateRestore,
} from "../../session/state-manifest";
import type { Tool, ToolSession } from "../../tools";
import { BashTool } from "../../tools/bash";
import { MAX_GRAPH_FRAME_CHARS } from "../state-limits";
import { disposeKernelSessionsByOwner } from "./executor";
import { registerPythonHarnessRun } from "./harness-bridge";
import type { PythonHarnessContext } from "./harness-types";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";
import {
	capturePythonStore,
	dispatchPythonStoreRequest,
	validatePythonGraph,
	validatePythonStoreEnvironment,
} from "./python-store";
import { stagePythonRuntimeAssets } from "./runtime-assets";

test("real Python store preserves one rich graph across processes and rejects concurrent stale revisions durably", async () => {
	using directory = TempDir.createSync("@python-rich-store-");
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const owner = `store:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path(), inMemory: true });
	const session: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		settings,
		sessionManager: manager,
		getSessionSpawns: () => null,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getEvalKernelOwnerId: () => owner,
	};
	const availability = await checkPythonKernelAvailability(directory.path(), undefined, { forceProbe: true });
	if (!availability.pythonPath) throw new Error(availability.reason);
	const run = await registerPythonHarnessRun(session, { cwd: directory.path() });
	const execute = async (code: string) => {
		const process = Bun.spawn([availability.pythonPath!, "-c", code], {
			cwd: directory.path(),
			env: { ...Bun.env, ...run.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		expect(exit, stderr).toBe(0);
		return stdout;
	};
	try {
		const started = performance.now();
		await execute(`import proto_harness as harness
shared=[]
shared.append(shared)
class Box:
    def __init__(self, value): self.value=value
def outer(value): return lambda: value
with harness.store.transaction() as store:
    store["a"]=shared
    store["b"]=shared
    store["box"]=Box(shared)
    store["f"]=outer(shared)
`);
		expect(
			await execute(`import proto_harness as harness
s=harness.store
assert s["a"] is s["b"] and s["a"][0] is s["a"]
assert s["box"].value is s["a"] and s["f"]() is s["a"]
print("rich store intact")`),
		).toContain("rich store intact");
		const context: PythonHarnessContext = {
			session,
			runId: "test",
			lane: "main",
			cwd: directory.path(),
			signal: new AbortController().signal,
			toolCallId: "test",
		};
		const resourceRevision = capturePythonStore(owner, manager).revision;
		expect(
			await execute(`import proto_harness as harness
with open("live-resource.txt", "w") as resource:
    try:
        harness.store["bad"] = resource
    except TypeError:
        assert not resource.closed
        print("refused before commit")
    else:
        raise AssertionError("live resource was stored")
`),
		).toContain("refused before commit");
		expect(capturePythonStore(owner, manager).revision).toBe(resourceRevision);
		const current = capturePythonStore(owner, manager);
		const requests = await Promise.allSettled(
			[0, 1].map(() =>
				dispatchPythonStoreRequest(context, "store.put_graph", {
					expected_revision: current.revision,
					graph: current.graph,
				}),
			),
		);
		expect(requests.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const failure = requests.find(result => result.status === "rejected");
		expect(failure?.status === "rejected" ? String(failure.reason) : "").toContain("revision conflict");
		manager.appendMessage({ role: "user", content: "exact store boundary", timestamp: 0 });
		const boundary = manager.getLeafId();
		await captureSessionState(manager, owner);
		for (let turn = 0; turn < 23; turn++) {
			const latest = capturePythonStore(owner, manager);
			await dispatchPythonStoreRequest(context, "store.put_graph", {
				expected_revision: latest.revision,
				graph: latest.graph,
			});
			manager.appendMessage({ role: "user", content: `store turn ${turn}`, timestamp: turn + 1 });
			await captureSessionState(manager, owner);
		}
		const missing = manager.appendMessage({ role: "user", content: "uncaptured store boundary", timestamp: 30 });
		await expect(prepareSessionStateRestore(manager, owner, missing)).rejects.toThrow("exact history boundary");
		await captureSessionState(manager, owner);
		const prepared = await prepareSessionStateRestore(manager, owner, boundary);
		const fork = `store:${crypto.randomUUID()}`;
		const branch = await SessionManager.forkFrom(
			manager.getSessionFile()!,
			directory.path(),
			directory.join("forks"),
		);
		try {
			activateSessionStateRestore(prepared, fork, fork);
			expect(capturePythonStore(fork, branch).revision).toBe(current.revision + 1);
			const forkSession: ToolSession = {
				...session,
				sessionManager: branch,
				getSessionFile: () => branch.getSessionFile() ?? null,
				getEvalKernelOwnerId: () => fork,
			};
			await dispatchPythonStoreRequest({ ...context, session: forkSession }, "store.put_graph", {
				expected_revision: current.revision + 1,
				graph: current.graph,
			});
			expect(capturePythonStore(fork, branch).revision).toBe(current.revision + 2);
			expect(capturePythonStore(owner, manager).revision).toBe(current.revision + 24);
		} finally {
			await branch.close();
		}
		const file = manager.getSessionFile()!;
		const before = capturePythonStore(owner, manager);
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			expect(capturePythonStore(`reopen:${crypto.randomUUID()}`, reopened)).toEqual(before);
		} finally {
			await reopened.close();
		}
		process.stderr.write(
			`rich-store payload=${current.graph!.payload.length}B elapsed=${(performance.now() - started).toFixed(1)}ms disk=${Bun.file(file).size}B\n`,
		);
	} finally {
		await run.dispose();
		await manager.close();
	}
}, 30_000);

test("40 MiB Python graphs cross store HTTP and warm state framing; overlimit capture leaves the live namespace intact", async () => {
	using directory = TempDir.createSync("@python-large-graph-");
	const availability = await checkPythonKernelAvailability(directory.path(), undefined, { forceProbe: true });
	if (!availability.pythonPath) throw new Error(availability.reason);
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const owner = `large-store:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path(), inMemory: true });
	const session: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		settings,
		sessionManager: manager,
		getSessionSpawns: () => null,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getEvalKernelOwnerId: () => owner,
	};
	const run = await registerPythonHarnessRun(session, { cwd: directory.path() });
	const execute = async (code: string) => {
		const child = Bun.spawn([availability.pythonPath!, "-c", code], {
			cwd: directory.path(),
			env: { ...Bun.env, ...run.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, stderr).toBe(0);
		return stdout;
	};
	const start = performance.now();
	try {
		await execute(`import proto_harness as harness
blob=b"x" * (40 * 1024 * 1024)
with harness.store.transaction() as store:
    store["blob"]=blob
    store["alias"]=blob
print("large graph stored")`);
		expect(
			await execute(`import proto_harness as harness
store=harness.store
assert store["blob"] is store["alias"]
assert len(store["blob"]) == 40 * 1024 * 1024
print("large graph read")`),
		).toContain("large graph read");
		const graph = capturePythonStore(owner, manager).graph!;
		expect(graph.payload.length).toBeGreaterThan(32 * 1024 * 1024);
		const sessionFile = manager.getSessionFile()!;
		const persisted = Bun.JSONL.parse(await Bun.file(sessionFile).text()) as {
			customType?: string;
			data?: unknown;
		}[];
		const reference = persisted.find(entry => entry.customType === "python-store")?.data;
		if (!isPersistedReplayBlobRef(reference)) throw new Error("Large graph was not durably externalized");
		const hash = parseBlobRef(reference[PERSISTED_REPLAY_BLOB_KEY]);
		if (!hash) throw new Error("Invalid graph blob reference");
		const diskBytes = Bun.file(path.join(getBlobsDir(), hash)).size + Bun.file(sessionFile).size;
		expect(diskBytes).toBeGreaterThan(graph.payload.length);
		await manager.close();
		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(capturePythonStore(owner, reopened).graph?.payload).toBe(graph.payload);
		} finally {
			await reopened.close();
		}
		process.stderr.write(
			`large-store encoded=${graph.payload.length}B elapsed=${(performance.now() - start).toFixed(1)}ms durable=${diskBytes}B\n`,
		);
	} finally {
		await run.dispose();
		await manager.close();
	}
	const source = await PythonKernel.start({ cwd: directory.path(), interpreter: availability.pythonPath });
	const destination = await PythonKernel.start({ cwd: directory.path(), interpreter: availability.pythonPath });
	try {
		expect((await source.execute('blob=b"x" * (40 * 1024 * 1024)\nalias=blob')).status).toBe("ok");
		const captureStart = performance.now();
		const snapshot = await source.declaredState("capture");
		await destination.declaredState("restore", snapshot);
		validatePythonGraph(snapshot);
		const output: string[] = [];
		const restored = await destination.execute(
			'assert blob is alias\nassert len(blob) == 40 * 1024 * 1024\nprint("large namespace restored")',
			{
				onChunk: text => {
					output.push(text);
				},
			},
		);
		expect(restored.status).toBe("ok");
		expect(output.join("")).toContain("large namespace restored");
		const frameRefusalStart = performance.now();
		await expect(
			source.declaredState("restore", { ...snapshot, payload: "A".repeat(MAX_GRAPH_FRAME_CHARS + 1) }),
		).rejects.toThrow("transport limit");
		expect(performance.now() - frameRefusalStart).toBeLessThan(5000);
		expect((await source.execute('blob=b"x" * (49 * 1024 * 1024)\nalias=blob')).status).toBe("ok");
		const refusalStart = performance.now();
		await expect(source.declaredState("capture")).rejects.toThrow("64 MiB encoded payload limit");
		expect(performance.now() - refusalStart).toBeLessThan(5000);
		expect((await source.execute("assert len(blob) == 49 * 1024 * 1024\nassert blob is alias")).status).toBe("ok");
		process.stderr.write(
			`large-warm capture/restore=${(refusalStart - captureStart).toFixed(1)}ms overlimit-refusal=${(performance.now() - refusalStart).toFixed(1)}ms\n`,
		);
	} finally {
		await source.shutdown();
		await destination.shutdown();
	}
}, 60_000);

const NATIVE_PYTHON_39 =
	"/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9";
test.if(await Bun.file(NATIVE_PYTHON_39).exists())(
	"fork preflight validates a native Python 3.9 store in its own process while restoring a supported named namespace",
	async () => {
		using directory = TempDir.createSync("@python-store-mixed-runtime-");
		const manager = SessionManager.create(directory.path(), directory.join("sessions"));
		const owner = `store:${crypto.randomUUID()}`;
		const destination = `store:${crypto.randomUUID()}`;
		const settings = await Settings.loadReadOnly({
			cwd: directory.path(),
			agentDir: directory.path(),
			inMemory: true,
		});
		const tools = new Map<string, Tool>();
		const session: ToolSession = {
			cwd: directory.path(),
			hasUI: false,
			settings,
			sessionManager: manager,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => null,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getEvalSessionId: () => owner,
			getEvalKernelOwnerId: () => owner,
			getToolForEvalBridge: name => tools.get(name),
			getEvalBridgeToolNames: () => ["bash"],
		};
		tools.set("bash", new BashTool(session));
		const execute = async (target: ToolSession, code: string) => {
			const run = await registerPythonHarnessRun(target, { cwd: directory.path() });
			try {
				return (
					await ptree.exec([NATIVE_PYTHON_39, "-c", code], {
						cwd: directory.path(),
						env: { ...process.env, ...run.env },
						timeout: 20_000,
					})
				).stdout;
			} finally {
				await run.dispose();
			}
		};
		let fork: SessionManager | undefined;
		try {
			expect(
				await execute(
					session,
					`import proto_harness as harness
import sys
assert sys.version_info[:2] == (3, 9)
shared = []
shared.append(shared)
with harness.store.transaction() as store:
    store["answer"] = 42
    store["a"] = shared
    store["b"] = shared
result = harness.kernel("analysis").run("import sys; assert sys.version_info >= (3, 10); value = 41; closure = lambda: value; print('supported named namespace')")
assert result["exitCode"] == 0, result
print(result["output"])
`,
				),
			).toContain("supported named namespace");
			manager.appendMessage({ role: "user", content: "mixed runtime fork boundary", timestamp: 0 });
			await captureSessionState(manager, owner);
			const original = capturePythonStore(owner, manager);
			const version = original.graph?.metadata.version;
			if (!Array.isArray(version)) throw new Error("Missing captured native interpreter version");
			expect(version.slice(0, 2)).toEqual([3, 9]);
			const prepared = await prepareSessionStateRestore(manager, owner, manager.getLeafId());
			expect(prepared.kernels[0].interpreter).not.toBe(NATIVE_PYTHON_39);
			fork = await SessionManager.forkFrom(manager.getSessionFile()!, directory.path(), directory.join("forks"));
			activateSessionStateRestore(prepared, destination, destination);
			const forkSession: ToolSession = {
				...session,
				sessionManager: fork,
				getSessionId: () => fork!.getSessionId(),
				getSessionFile: () => fork!.getSessionFile() ?? null,
				getEvalSessionId: () => destination,
				getEvalKernelOwnerId: () => destination,
			};
			expect(
				await execute(
					forkSession,
					`import proto_harness as harness
assert harness.store["answer"] == 42
assert harness.store["a"] is harness.store["b"] and harness.store["a"][0] is harness.store["a"]
result = harness.kernel("analysis").run("assert value == 41 and closure() == 41; value = 73; print('fork restored')")
assert result["exitCode"] == 0, result
harness.store["answer"] = 73
print(result["output"])
`,
				),
			).toContain("fork restored");
			expect(
				await execute(
					session,
					`import proto_harness as harness
assert harness.store["answer"] == 42
result = harness.kernel("analysis").run("assert value == 41 and closure() == 41; print('source intact')")
assert result["exitCode"] == 0, result
try:
    harness.kernel("unsupported", interpreter=${JSON.stringify(NATIVE_PYTHON_39)}).run("should_not_run = True")
except RuntimeError as error:
    assert "older than Python 3.10" in str(error), error
else:
    raise AssertionError("Python 3.9 must remain unsupported for named warm kernels")
print(result["output"])
`,
				),
			).toContain("source intact");
		} finally {
			await disposeKernelSessionsByOwner(owner);
			await disposeKernelSessionsByOwner(destination);
			await fork?.close();
			await manager.close();
		}
	},
	60_000,
);

test("store graph preflight preserves a virtualenv launcher instead of silently choosing its base interpreter", async () => {
	using directory = TempDir.createSync("@python-store-venv-launcher-");
	const available = await checkPythonKernelAvailability(directory.path(), undefined, { forceProbe: true });
	if (!available.pythonPath) throw new Error(available.reason);
	const venvRoot = directory.join("venv");
	await ptree.exec([available.pythonPath, "-m", "venv", "--without-pip", venvRoot], { timeout: 20_000 });
	const venv = await fs.realpath(venvRoot);
	const interpreter = path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const packageRoot = await stagePythonRuntimeAssets();
	const result = await ptree.exec(
		[
			interpreter,
			"-c",
			'import json; from proto_harness import _serialization; print(json.dumps(_serialization.dumps({"answer": 42})))',
		],
		{
			cwd: directory.path(),
			env: { ...process.env, PYTHONPATH: packageRoot },
			timeout: 15_000,
		},
	);
	const graph: unknown = JSON.parse(result.stdout);
	validatePythonGraph(graph);
	expect(graph.metadata.executable).toBe(interpreter);
	await validatePythonStoreEnvironment(graph);
	const wrong = structuredClone(graph);
	wrong.metadata.prefix = directory.join("nonexistent-environment");
	await expect(validatePythonStoreEnvironment(wrong)).rejects.toThrow("incompatible");
}, 40_000);
