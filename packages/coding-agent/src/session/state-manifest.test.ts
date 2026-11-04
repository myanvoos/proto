import { expect, spyOn, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { isDeclaredStateKernelSafeToRelease } from "../eval/declared-state";
import { disposeVmContextsByOwner, executeInVmContext } from "../eval/js/context-manager";
import { getKernelLaneConfiguration, setKernelLaneConfiguration } from "../eval/kernel-environment";
import { disposeKernelSessionsByOwner, executePython, listPythonKernelSessions } from "../eval/py/executor";
import type { ToolSession } from "../tools";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { EvalRunner } from "./eval-runner";
import { convertToLlm } from "./messages";
import { SessionManager } from "./session-manager";
import {
	activateSessionStateRestore,
	appendSessionMetadataWithState,
	captureSessionState,
	DECLARED_STATE_CUSTOM_TYPE,
	prepareSessionStateRestore,
} from "./state-manifest";

async function kernels(cwd: string, owner: string) {
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	return {
		async python(code: string, reset = false, stdin?: ReadableStream<Uint8Array>) {
			const result = await executePython(code, {
				cwd,
				sessionId: `python:${owner}`,
				kernelOwnerId: owner,
				timeoutMs: 20_000,
				reset,
				stdin,
			});
			expect(result.exitCode, result.output).toBe(0);
			return result.output;
		},
		async js(code: string, runtime: "bun" | "node" = "bun", reset = false, stdin?: ReadableStream<Uint8Array>) {
			let output = "";
			await executeInVmContext({
				runtime,
				sessionKey: `${runtime}:${owner}`,
				sessionId: `${runtime}:${owner}`,
				ownerId: owner,
				cwd,
				session,
				reset,
				stdin,
				code,
				filename: "manifest-test.js",
				runState: {
					onText: text => {
						output += text;
					},
					onDisplay: () => {},
				},
			});
			return output;
		},
		async close() {
			await Promise.all([disposeKernelSessionsByOwner(owner), disposeVmContextsByOwner(owner)]);
		},
	};
}

test("historical declared Python and JavaScript state restores independently after restart beyond twenty turns", async () => {
	using directory = TempDir.createSync("@state-manifest-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const destination = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const source = await kernels(directory.path(), owner);
	const target = await kernels(directory.path(), destination);
	try {
		await source.python('value = {"answer": 41, "bytes": b"ok"}\ndeclare_state(["value"])');
		await source.js('var value = {answer: 41, bytes: Buffer.from("ok")}; declareState(["value"]);');
		const first = manager.appendMessage({ role: "user", content: "first boundary", timestamp: 0 });
		await captureSessionState(manager, owner);
		for (let turn = 0; turn < 24; turn++) {
			await source.python('value["answer"] += 1');
			await source.js("value.answer += 1;");
			manager.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: turn + 1 });
			await captureSessionState(manager, owner);
		}
		const file = manager.getSessionFile()!;
		await source.close();
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			const prepared = await prepareSessionStateRestore(reopened, destination, first);
			activateSessionStateRestore(prepared, destination, destination);
			expect(await target.python('print(value["answer"] + 1, value["bytes"].decode())')).toContain("42 ok");
			expect(await target.js("console.log(value.answer + 1, value.bytes.toString());")).toContain("42 ok");
			const latest = await prepareSessionStateRestore(
				reopened,
				`unused:${crypto.randomUUID()}`,
				reopened.getLeafId(),
			);
			await target.close();
			activateSessionStateRestore(latest, destination, destination);
			expect(await target.python('print(value["answer"])')).toContain("65");
			expect(await target.js("console.log(value.answer);")).toContain("65");
		} finally {
			await reopened.close();
		}
	} finally {
		await source.close();
		await target.close();
		await manager.close();
	}
}, 60_000);

test("declared alias and resource failures refuse history transitions before changing live computation", async () => {
	using directory = TempDir.createSync("@state-alias-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory();
	const source = await kernels(directory.path(), owner);
	try {
		await source.python('first = []\nsecond = []\ndeclare_state(["first", "second"])');
		await source.js('var first = [], second = []; declareState(["first", "second"]);');
		await source.js(`var selectorTraps = 0, selectorRejected = false;
try { declareState(new Proxy([], { get() { selectorTraps++; return 0; }, ownKeys() { selectorTraps++; return []; } })); } catch { selectorRejected = true; }
if (!selectorRejected || selectorTraps) throw Error("unsafe declaration selector executed code or cleared declarations");`);
		const first = manager.appendMessage({ role: "user", content: "safe", timestamp: 0 });
		await captureSessionState(manager, owner);
		await source.python("second = first");
		await expect(prepareSessionStateRestore(manager, owner, first)).rejects.toThrow("aliases");
		expect(await source.python("print(first is second)")).toContain("True");
		await source.python("second = []");
		await source.js("second = first;");
		await expect(prepareSessionStateRestore(manager, owner, first)).rejects.toThrow("aliases");
		expect(await source.js("console.log(first === second);")).toContain("true");
		await source.js("second = [];");
		await source.python('second = open("resource.txt", "w")');
		await expect(prepareSessionStateRestore(manager, owner, first)).rejects.toThrow("resources");
		expect(await source.python("print(not second.closed)")).toContain("True");
		await source.python("second.close()\nsecond = []");
		await source.js("second = () => 1;");
		await expect(prepareSessionStateRestore(manager, owner, first)).rejects.toThrow("resources");
		expect(await source.js("console.log(typeof second);")).toContain("function");
	} finally {
		await source.close();
		await manager.close();
	}
}, 60_000);

test("corrupt and uncaptured state boundaries reject before source teardown rather than selecting an older snapshot", async () => {
	using directory = TempDir.createSync("@state-corrupt-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory();
	const source = await kernels(directory.path(), owner);
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		const first = manager.appendMessage({ role: "user", content: "safe", timestamp: 0 });
		await captureSessionState(manager, owner);
		const missing = manager.appendMessage({ role: "user", content: "no capture", timestamp: 1 });
		await expect(prepareSessionStateRestore(manager, owner, missing)).rejects.toThrow("exact history boundary");
		const manifest = manager.getCustomEntries(DECLARED_STATE_CUSTOM_TYPE)[0].data as {
			kernels: { snapshot: { version: number } }[];
		};
		manifest.kernels[0].snapshot.version = 999;
		const corruptBoundary = manager.appendMessage({ role: "user", content: "corrupt", timestamp: 2 });
		manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, {
			...manifest,
			version: 1,
			boundaryEntryId: corruptBoundary,
		});
		await expect(prepareSessionStateRestore(manager, owner, corruptBoundary)).rejects.toThrow("version");
		expect(await source.python("print(value + 1)")).toContain("42");
		const prepared = await prepareSessionStateRestore(manager, owner, first);
		expect(prepared.kernels.length).toBe(1);
	} finally {
		await source.close();
		await manager.close();
	}
}, 60_000);

test("a resumed EvalRunner lazily restores only its own durable state and rejects incompatible JavaScript before source teardown", async () => {
	using directory = TempDir.createSync("@state-resume-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const source = await kernels(directory.path(), owner);
	let resumed: EvalRunner | undefined;
	try {
		await source.python('value = 40\ndeclare_state(["value"])');
		await source.js('var value = 40; declareState(["value"]);');
		manager.appendMessage({ role: "user", content: "persist", timestamp: 0 });
		await captureSessionState(manager, owner);
		await source.close();
		const settings = await Settings.loadReadOnly({
			cwd: directory.path(),
			agentDir: directory.path(),
			inMemory: true,
		});
		const restoredOwner = `resumed:${crypto.randomUUID()}`;
		resumed = new EvalRunner(
			{
				agent: new Agent(),
				sessionManager: manager,
				settings,
				extensionRunner: () => undefined,
				isStreaming: () => false,
				appendSessionMessage: message => {
					manager.appendMessage(message);
				},
			},
			{ kernelOwnerId: restoredOwner, parentSessionId: undefined },
		);
		const result = await resumed.executePython("print(value + 2)");
		expect(result.output).toContain("42");
		expect(result.exitCode).toBe(0);
		const boundary = manager.appendMessage({ role: "user", content: "incompatible", timestamp: 1 });
		const data = manager.getCustomEntries(DECLARED_STATE_CUSTOM_TYPE)[0].data as {
			kernels: { language: string; snapshot: { interpreter: { version: string } } }[];
		};
		data.kernels = data.kernels.filter(state => state.language === "bun");
		data.kernels[0].snapshot.interpreter.version = "incompatible";
		manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, { ...data, boundaryEntryId: boundary });
		await expect(prepareSessionStateRestore(manager, restoredOwner, boundary)).rejects.toThrow("incompatible");
		expect((await resumed.executePython("print(value + 3)")).output).toContain("43");
	} finally {
		if (resumed) await resumed.disposeKernels();
		await source.close();
		await manager.close();
	}
}, 60_000);

test("large declared namespaces remain byte-exact through persisted blobs and independent root copies", async () => {
	using directory = TempDir.createSync("@state-large-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const destination = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const source = await kernels(directory.path(), owner);
	const target = await kernels(directory.path(), destination);
	let fork: SessionManager | undefined;
	try {
		await source.python('large = "雪" * 600000\ndeclare_state(["large"])');
		await source.js('var large = "雪".repeat(600000); declareState(["large"]);');
		manager.appendMessage({ role: "user", content: "large state", timestamp: 0 });
		await captureSessionState(manager, owner);
		const originalLeaf = manager.getLeafId();
		fork = await SessionManager.forkFrom(
			manager.getSessionFile()!,
			directory.path(),
			directory.join("forks"),
			undefined,
			{ activeLineageOnly: true },
		);
		await captureSessionState(fork, owner);
		const prepared = await prepareSessionStateRestore(fork, destination, fork.getLeafId());
		activateSessionStateRestore(prepared, destination, destination);
		expect(await target.python("print(len(large), large[-1])")).toContain("600000 雪");
		expect(await target.js("console.log(large.length, large.at(-1));")).toContain("600000 雪");
		await target.python('large = "fork"');
		expect(await source.python("print(len(large))")).toContain("600000");
		expect(manager.getLeafId()).toBe(originalLeaf);
	} finally {
		await source.close();
		await target.close();
		await fork?.close();
		await manager.close();
	}
}, 60_000);

test("model checkpoint rewind drops exploratory context without undoing declared Python computation", async () => {
	using directory = TempDir.createSync("@state-context-rewind-");
	const auth = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	const tools: AgentTool[] = ["checkpoint", "compute", "rewind"].map(name => ({
		name,
		label: name,
		description: name,
		parameters: type({ text: "string" }),
		async execute() {
			if (name === "compute") await session!.executePython("value += 2");
			return {
				content: [{ type: "text", text: name }],
				details:
					name === "checkpoint"
						? { startedAt: "2026-01-01T00:00:00.000Z" }
						: name === "rewind"
							? { report: "retained computation" }
							: undefined,
			};
		},
	}));
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { text: "start" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "compute", name: "compute", arguments: { text: "compute" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "rewind", name: "rewind", arguments: { text: "report" } }],
				stopReason: "toolUse",
			},
			{ content: ["Done"] },
		],
	});
	auth.setRuntimeApiKey(mock.provider, "test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const manager = SessionManager.inMemory(directory.path());
	try {
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"checklist.enabled": false,
			}),
			modelRegistry: new ModelRegistry(auth),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		expect((await session.executePython('value = 40\ndeclare_state(["value"])')).exitCode).toBe(0);
		await session.prompt("Investigate then retain computation");
		await session.waitForIdle();
		expect(session.getLastCompletedRewind()?.report).toBe("retained computation");
		expect((await session.executePython("print(value)")).output).toContain("42");
		expect(
			manager
				.buildSessionContext()
				.messages.some(message => message.role === "toolResult" && message.toolCallId === "compute"),
		).toBe(false);
	} finally {
		await session?.dispose();
		auth.close();
		await manager.close();
	}
}, 60_000);

test("declared Node and Bun heaps restore into their own real interpreters without mixing runtimes", async () => {
	using directory = TempDir.createSync("@state-js-runtimes-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const destination = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory();
	const source = await kernels(directory.path(), owner);
	const target = await kernels(directory.path(), destination);
	try {
		await source.js('var value = 41; declareState(["value"]);');
		await source.js('var value = 73; declareState(["value"]);', "node");
		manager.appendMessage({ role: "user", content: "separate runtimes", timestamp: 0 });
		await captureSessionState(manager, owner);
		const prepared = await prepareSessionStateRestore(manager, destination, manager.getLeafId());
		activateSessionStateRestore(prepared, destination, destination);
		expect(await target.js("console.log(value, typeof Bun);")).toContain("41 object");
		expect(await target.js("console.log(value, typeof Bun);", "node")).toContain("73 undefined");
	} finally {
		await source.close();
		await target.close();
		await manager.close();
	}
}, 60_000);

test("an explicit kernel reset still discards declared bindings rather than silently restoring them", async () => {
	using directory = TempDir.createSync("@state-reset-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory();
	const source = await kernels(directory.path(), owner);
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		await source.js('var value = 41; declareState(["value"]);');
		manager.appendMessage({ role: "user", content: "before explicit reset", timestamp: 0 });
		await captureSessionState(manager, owner);
		expect(await source.python('print("value" in globals())', true)).toContain("False");
		expect(await source.js("console.log(typeof value);", "bun", true)).toContain("undefined");
		await source.python('value = 41\ndeclare_state(["value"])');
		await captureSessionState(manager, owner);
		await source.python("%reset");
		await captureSessionState(manager, owner);
		expect(await source.python('print("value" in globals())')).toContain("False");
	} finally {
		await source.close();
		await manager.close();
	}
}, 60_000);

test.each(["python", "bun"] as const)(
	"%s capture drains a running cell and blocks the next mutation until the immutable manifest commits",
	async language => {
		using directory = TempDir.createSync("@state-capture-gate-");
		const owner = `manifest:${crypto.randomUUID()}`;
		const destination = `manifest:${crypto.randomUUID()}`;
		const manager = SessionManager.inMemory();
		const source = await kernels(directory.path(), owner);
		const target = await kernels(directory.path(), destination);
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const stdin = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					entered.resolve();
					await proceed.promise;
					controller.enqueue(Buffer.from("42"));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		try {
			if (language === "python") await source.python('value = 41\ndeclare_state(["value"])');
			else await source.js('var value = 41; declareState(["value"]);');
			const boundary = manager.appendMessage({ role: "user", content: "cell boundary", timestamp: 0 });
			const running =
				language === "python"
					? source.python("import sys\nvalue = int(sys.stdin.read())", false, stdin)
					: source.js('value = Number(require("node:fs").readFileSync(0, "utf8"));', "bun", false, stdin);
			await entered.promise;
			const capturing = captureSessionState(manager, owner);
			const next = language === "python" ? source.python("value = 99") : source.js("value = 99;");
			proceed.resolve();
			await Promise.all([running, capturing, next]);
			const prepared = await prepareSessionStateRestore(manager, destination, boundary);
			activateSessionStateRestore(prepared, destination, destination);
			if (language === "python") {
				expect(await source.python("print(value)")).toContain("99");
				expect(await target.python("print(value)")).toContain("42");
			} else {
				expect(await source.js("console.log(value);")).toContain("99");
				expect(await target.js("console.log(value);")).toContain("42");
			}
		} finally {
			proceed.resolve();
			await source.close();
			await target.close();
			await manager.close();
		}
	},
	60_000,
);

test("concurrent direct Python submissions commit separate exact boundaries before the next cell mutates state", async () => {
	using directory = TempDir.createSync("@state-direct-boundaries-");
	const owner = `direct:${crypto.randomUUID()}`;
	const destination = `direct:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory(directory.path());
	const settings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path(), inMemory: true });
	const runner = new EvalRunner(
		{
			agent: new Agent(),
			sessionManager: manager,
			settings,
			extensionRunner: () => undefined,
			isStreaming: () => false,
			appendSessionMessage: message => {
				manager.appendMessage(message);
			},
		},
		{ kernelOwnerId: owner, parentSessionId: undefined },
	);
	const target = await kernels(directory.path(), destination);
	try {
		const first = runner.executePython('value = 41\ndeclare_state(["value"])');
		const second = runner.executePython("value += 1");
		expect((await first).exitCode).toBe(0);
		expect((await second).exitCode).toBe(0);
		const firstBoundary = manager.getCustomEntries(DECLARED_STATE_CUSTOM_TYPE)[0].id;
		const prepared = await prepareSessionStateRestore(manager, destination, firstBoundary);
		activateSessionStateRestore(prepared, destination, destination);
		expect(await target.python("print(value)")).toContain("41");
		expect((await runner.executePython("print(value)")).output).toContain("42");
	} finally {
		await runner.disposeKernels();
		await target.close();
		await manager.close();
	}
}, 60_000);

test("a parked parent receives durable child receipts without losing its exact lazy-restorable declared state", async () => {
	using directory = TempDir.createSync("@state-parked-receipt-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const destination = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.create(directory.path(), directory.join("sessions"));
	const source = await kernels(directory.path(), owner);
	const target = await kernels(directory.path(), destination);
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		manager.appendMessage({ role: "user", content: "park", timestamp: 0 });
		await captureSessionState(manager, owner);
		await source.close();
		await appendSessionMetadataWithState(manager, () => {
			manager.appendCustomEntry("orchestrator-worker-lifecycle", {
				action: "turn-settled",
				result: "child completed",
			});
		});
		const file = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			const prepared = await prepareSessionStateRestore(reopened, destination, reopened.getLeafId());
			activateSessionStateRestore(prepared, destination, destination);
			expect(await target.python("print(value + 1)")).toContain("42");
			expect(reopened.getCustomEntries("orchestrator-worker-lifecycle")[0].data).toMatchObject({
				result: "child completed",
			});
		} finally {
			await reopened.close();
		}
	} finally {
		await source.close();
		await target.close();
		await manager.close();
	}
}, 60_000);

test("kernel death before the first declared capture refuses a fresh namespace until an explicit reset", async () => {
	using directory = TempDir.createSync("@state-unknown-loss-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const source = await kernels(directory.path(), owner);
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		await executePython("os._exit(9)", {
			cwd: directory.path(),
			sessionId: `python:${owner}`,
			kernelOwnerId: owner,
			timeoutMs: 20_000,
		}).catch(() => undefined);
		await expect(source.python('print("must not execute")')).rejects.toThrow("older or fresh namespace");
		expect(await source.python('print("value" in globals())', true)).toContain("False");
	} finally {
		await source.close();
	}
}, 60_000);

test("restoration preserves the selected lane environment instead of choosing the last-created kernel", async () => {
	using directory = TempDir.createSync("@state-environment-default-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const destination = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory(directory.path());
	const firstCwd = directory.join("first");
	const lastCwd = directory.join("last");
	await Bun.write(`${firstCwd}/marker`, "first");
	await Bun.write(`${lastCwd}/marker`, "last");
	try {
		for (const [cwd, value] of [
			[firstCwd, 41],
			[lastCwd, 73],
		] as const) {
			const result = await executePython(`value = ${value}\ndeclare_state(["value"])`, {
				cwd,
				sessionId: `python:${owner}`,
				kernelOwnerId: owner,
				timeoutMs: 20_000,
			});
			expect(result.exitCode, result.output).toBe(0);
		}
		setKernelLaneConfiguration(owner, "python", `python:${owner}`, { cwd: firstCwd, target: { kind: "local" } });
		manager.appendMessage({ role: "user", content: "selected first environment", timestamp: 0 });
		await captureSessionState(manager, owner);
		const prepared = await prepareSessionStateRestore(manager, destination, manager.getLeafId());
		activateSessionStateRestore(prepared, destination, destination);
		const selected = getKernelLaneConfiguration(destination, "python", `python:${destination}`);
		const result = await executePython("print(value + 1)", {
			...selected,
			sessionId: `python:${destination}`,
			kernelOwnerId: destination,
			timeoutMs: 20_000,
		});
		expect(result.output).toContain("42");
		expect(result.exitCode).toBe(0);
	} finally {
		await disposeKernelSessionsByOwner(owner);
		await disposeKernelSessionsByOwner(destination);
		await manager.close();
	}
}, 60_000);

test("a failed durable manifest commit cannot make dirty declared state eligible for automatic eviction", async () => {
	using directory = TempDir.createSync("@state-failed-commit-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory(directory.path());
	const source = await kernels(directory.path(), owner);
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		manager.appendMessage({ role: "user", content: "uncommitted", timestamp: 0 });
		const generation = listPythonKernelSessions(owner)[0].generation!;
		const failCommit = spyOn(manager, "appendEntriesAtomically").mockRejectedValueOnce(new Error("disk unavailable"));
		try {
			await expect(captureSessionState(manager, owner)).rejects.toThrow("disk unavailable");
		} finally {
			failCommit.mockRestore();
		}
		expect(isDeclaredStateKernelSafeToRelease(generation)).toBe(false);
		expect(await source.python("print(value + 1)")).toContain("42");
		await captureSessionState(manager, owner);
		expect(isDeclaredStateKernelSafeToRelease(generation)).toBe(true);
	} finally {
		await source.close();
		await manager.close();
	}
}, 60_000);

test("independent explicit live namespaces remain usable but ambiguous declared temporal aliases refuse capture", async () => {
	using directory = TempDir.createSync("@state-namespace-alias-");
	const owner = `manifest:${crypto.randomUUID()}`;
	const manager = SessionManager.inMemory(directory.path());
	const source = await kernels(directory.path(), owner);
	const otherOptions = {
		cwd: directory.path(),
		sessionId: `python:explicit:${crypto.randomUUID()}`,
		kernelOwnerId: owner,
		timeoutMs: 20_000,
	};
	try {
		await source.python('value = 41\ndeclare_state(["value"])');
		expect((await executePython('value = 73\ndeclare_state(["value"])', otherOptions)).exitCode).toBe(0);
		manager.appendMessage({ role: "user", content: "ambiguous namespace", timestamp: 0 });
		await expect(captureSessionState(manager, owner)).rejects.toThrow("namespace aliases");
		expect(await source.python("print(value)")).toContain("41");
		expect((await executePython("print(value)\ndeclare_state([])", otherOptions)).output).toContain("73");
		await captureSessionState(manager, owner);
		const prepared = await prepareSessionStateRestore(manager, `fresh:${crypto.randomUUID()}`, manager.getLeafId());
		expect(prepared.kernels.length).toBe(1);
	} finally {
		await source.close();
		await manager.close();
	}
}, 60_000);
