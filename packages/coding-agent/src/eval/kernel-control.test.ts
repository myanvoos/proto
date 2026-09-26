import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { KernelTool } from "../tools/kernel";
import type { ExecutorBackendResult } from "./backend";
import { bunBackend, nodeBackend } from "./js";
import { disposeVmContextsByOwner } from "./js/context-manager";
import { NODE_REMOTE_TARGET_UNSUPPORTED } from "./js/node-runtime";
import { kernelAdmission } from "./kernel-admission";
import {
	handleKernelControl,
	kernelLaneSessionId,
	parseKernelControlArgs,
	resolveKernelLaneConfiguration,
} from "./kernel-control";
import { KERNEL_LANGUAGES, type KernelLanguage, MAX_KERNEL_KEEPALIVE_MS } from "./kernel-environment";
import pythonBackend from "./py";
import { disposeKernelSessionsByOwner } from "./py/executor";
import { checkPythonKernelAvailability } from "./py/kernel";

const backends = { python: pythonBackend, node: nodeBackend, bun: bunBackend };
const nodeInterpreter = Bun.which("node") ?? Bun.which("nodejs");

const owners = new Set<string>();
afterEach(async () => {
	await Promise.all(
		[...owners].flatMap(owner => [disposeKernelSessionsByOwner(owner), disposeVmContextsByOwner(owner)]),
	);
	owners.clear();
});

async function createSession(cwd: string): Promise<ToolSession> {
	const owner = `kernel-controls:${crypto.randomUUID()}`;
	owners.add(owner);
	return {
		cwd,
		hasUI: false,
		settings: await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true }),
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function execute(
	session: ToolSession,
	language: KernelLanguage,
	lane: string,
	code: string,
	onChunk?: (chunk: string) => void,
): Promise<ExecutorBackendResult> {
	const config = resolveKernelLaneConfiguration(session, language, lane);
	return backends[language].execute(code, {
		cwd: config?.cwd ?? session.cwd,
		runCwd: config?.cwd,
		interpreter: config?.interpreter,
		target: config?.target,
		sessionId: kernelLaneSessionId(session, lane),
		kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
		sessionFile: undefined,
		session,
		reset: false,
		onChunk: onChunk ?? (() => {}),
	});
}

async function within<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
	const gate = Promise.withResolvers<T>();
	// Bound real hung subprocess recovery, not a guessed sleep; fake time cannot advance OS process termination.
	const timer = setTimeout(
		() => gate.reject(new Error("Lifecycle operation did not complete outside the executing kernel")),
		timeoutMs,
	);
	try {
		return await Promise.race([promise, gate.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("kernel argument validation", () => {
	test("rejects invalid fields, operation combinations, targets, and unbounded leases", () => {
		for (const args of [
			{},
			{ op: "missing" },
			{ op: "start" },
			{ op: "list", extra: 1 },
			{ op: "start", language: "js" },
			{ op: "start", language: "javascript" },
			{ op: "start", language: "python", lane: "" },
			{ op: "start", language: "python", lane: "x".repeat(129) },
			{ op: "start", language: "python", interpreter: " " },
			{ op: "inspect", language: "python", cwd: "/tmp" },
			{ op: "keepalive", language: "python" },
			{ op: "reset", language: "python", force: true },
			{ op: "start", language: "python", target: { kind: "local", typo: true } },
			...[-1, 0, 0.5, Infinity, MAX_KERNEL_KEEPALIVE_MS + 1].map(ttlMs => ({
				op: "keepalive",
				language: "python",
				ttlMs,
			})),
		])
			expect(() => parseKernelControlArgs(args)).toThrow();
		expect(parseKernelControlArgs({ op: "list" })).toEqual({ op: "list" });
	});
});

for (const language of KERNEL_LANGUAGES) {
	describe(`${language} named kernel control`, () => {
		test("starts real kernels, isolates lanes, replaces state and preserves configured cwd without changing settings", async () => {
			using temp = TempDir.createSync("@kernel-control-");
			const session = await createSession(temp.path());
			const cwd = path.join(temp.path(), "environment");
			await fs.mkdir(cwd);
			const interpreterSetting = session.settings.get("python.interpreter");
			const tool = new KernelTool(session);
			expect(tool.loadMode).toBe("discoverable");
			const first = await tool.execute("start", { op: "start", language, lane: "alpha", cwd });
			expect(first.details?.kernel).toMatchObject({
				language,
				lane: "alpha",
				state: "idle",
				environment: { cwd, target: { kind: "local" } },
			});
			expect(first.details?.kernel?.generation).toBeString();
			expect(first.details?.kernel?.interpreter).toBeString();
			const generation = first.details?.kernel?.generation;
			const seed =
				language === "python"
					? "import os; marker = 41; print(os.getcwd())"
					: "var marker = 41; console.log(process.cwd())";
			expect((await execute(session, language, "alpha", seed)).output).toContain(cwd);
			expect(
				(await execute(session, language, "beta", language === "python" ? "marker = 99" : "var marker = 99"))
					.exitCode,
			).toBe(0);
			expect(
				(await execute(session, language, "alpha", language === "python" ? "print(marker)" : "console.log(marker)"))
					.output,
			).toContain("41");
			const list = await tool.execute("list", { op: "list", language });
			expect(list.details?.kernels?.map(item => item.lane)).toEqual(["alpha", "beta"]);
			await expect(
				handleKernelControl(session, { op: "start", language, lane: "alpha", cwd: temp.path() }),
			).rejects.toThrow("use reset");
			const reset = await handleKernelControl(session, { op: "reset", language, lane: "alpha" });
			expect(reset.kernel?.generation).not.toBe(generation);
			expect(reset.kernel?.environment.cwd).toBe(cwd);
			const empty = await execute(
				session,
				language,
				"alpha",
				language === "python" ? 'print("marker" in globals())' : "console.log(typeof marker)",
			);
			expect(empty.output).toContain(language === "python" ? "False" : "undefined");
			expect(
				(await execute(session, language, "beta", language === "python" ? "print(marker)" : "console.log(marker)"))
					.output,
			).toContain("99");
			expect(session.settings.get("python.interpreter")).toBe(interpreterSetting);
			await handleKernelControl(session, { op: "close", language, lane: "alpha" });
			expect(resolveKernelLaneConfiguration(session, language, "alpha")).toBeUndefined();
			for (const op of ["inspect", "reset", "close", "keepalive"] as const) {
				await expect(
					handleKernelControl(session, {
						op,
						language,
						lane: "alpha",
						...(op === "keepalive" ? { ttlMs: 1 } : {}),
					}),
				).rejects.toThrow("Unknown");
			}
		}, 30_000);

		test("selects a lane-local interpreter and reports the running generation", async () => {
			using temp = TempDir.createSync("@kernel-interpreter-");
			const session = await createSession(temp.path());
			const previousInterpreter = session.settings.get("python.interpreter");
			const interpreter =
				language === "python"
					? (await checkPythonKernelAvailability(session.cwd)).pythonPath!
					: language === "node"
						? nodeInterpreter!
						: process.execPath;
			const first = await handleKernelControl(session, { op: "start", language, interpreter });
			const code =
				language === "python"
					? "import json; print(json.dumps(kernel_state()))"
					: "console.log(JSON.stringify(kernelState()))";
			const result = await execute(session, language, "main", code);
			expect(result.exitCode).toBe(0);
			const state = JSON.parse(result.output.trim());
			expect(state.generation).toBe(first.kernel?.generation);
			expect(state.interpreter).toBe(first.kernel?.interpreter);
			expect(session.settings.get("python.interpreter")).toBe(previousInterpreter);
		}, 30_000);

		test("resetting a shared lane preserves the other owner's live namespace", async () => {
			using temp = TempDir.createSync("@kernel-shared-control-");
			const first = await createSession(temp.path());
			const second = await createSession(temp.path());
			second.getEvalSessionId = first.getEvalSessionId;
			await execute(first, language, "main", language === "python" ? "shared = 73" : "var shared = 73");
			expect(
				(await execute(second, language, "main", language === "python" ? "print(shared)" : "console.log(shared)"))
					.output,
			).toContain("73");
			await handleKernelControl(second, { op: "reset", language });
			expect(
				(
					await execute(
						second,
						language,
						"main",
						language === "python" ? 'print("shared" in globals())' : "console.log(typeof shared)",
					)
				).output,
			).toContain(language === "python" ? "False" : "undefined");
			expect(
				(await execute(first, language, "main", language === "python" ? "print(shared)" : "console.log(shared)"))
					.output,
			).toContain("73");
			await handleKernelControl(second, { op: "close", language });
			expect(
				(await execute(first, language, "main", language === "python" ? "print(shared)" : "console.log(shared)"))
					.output,
			).toContain("73");
		}, 30_000);

		test("bounds keepalive, reclaims admission on close, and clears configuration on disposal", async () => {
			using temp = TempDir.createSync("@kernel-admission-control-");
			const session = await createSession(temp.path());
			const owner = session.getEvalKernelOwnerId!()!;
			const reservations = Array.from({ length: 15 }, () => kernelAdmission.reserve(owner));
			try {
				await handleKernelControl(session, { op: "start", language, lane: "one", ttlMs: MAX_KERNEL_KEEPALIVE_MS });
				const before = Date.now();
				const keepalive = await handleKernelControl(session, {
					op: "keepalive",
					language,
					lane: "one",
					ttlMs: MAX_KERNEL_KEEPALIVE_MS,
				});
				expect(keepalive.kernel?.keepAliveUntil).toBeGreaterThanOrEqual(before + MAX_KERNEL_KEEPALIVE_MS);
				expect(keepalive.kernel?.keepAliveUntil).toBeLessThanOrEqual(Date.now() + MAX_KERNEL_KEEPALIVE_MS);
				await expect(handleKernelControl(session, { op: "start", language, lane: "two" })).rejects.toThrow(
					"Interpreter limit",
				);
				await handleKernelControl(session, { op: "close", language, lane: "one" });
				expect((await handleKernelControl(session, { op: "start", language, lane: "two" })).kernel?.state).toBe(
					"idle",
				);
				if (language === "python") await disposeKernelSessionsByOwner(owner);
				else await disposeVmContextsByOwner(owner);
				expect(resolveKernelLaneConfiguration(session, language, "two")).toBeUndefined();
				expect((await handleKernelControl(session, { op: "list", language })).kernels).toEqual([]);
			} finally {
				for (const release of reservations) release();
			}
		}, 30_000);

		test("lists and rejects nonforced close while hung code runs, then forcibly closes and resets without queueing", async () => {
			using temp = TempDir.createSync("@kernel-busy-control-");
			const session = await createSession(temp.path());
			await handleKernelControl(session, { op: "start", language });
			for (const op of ["close", "reset"] as const) {
				const ready = Promise.withResolvers<void>();
				const code =
					language === "python"
						? 'print("RUNNING", flush=True)\nwhile True: pass'
						: 'console.log("RUNNING"); await Promise.withResolvers().promise;';
				const pending = execute(session, language, "main", code, text => {
					if (text.includes("RUNNING")) ready.resolve();
				});
				try {
					await within(ready.promise);
					expect((await within(handleKernelControl(session, { op: "list" }))).kernels?.[0].state).toBe("busy");
					await expect(within(handleKernelControl(session, { op: "close", language }))).rejects.toThrow("busy");
					await within(handleKernelControl(session, { op, language, ...(op === "close" ? { force: true } : {}) }));
					await within(pending);
				} finally {
					await handleKernelControl(session, { op: "close", language, force: true }).catch(() => undefined);
					await pending.catch(() => undefined);
				}
				if (op === "close") await handleKernelControl(session, { op: "start", language });
			}
		}, 40_000);
	});
}

for (const language of ["node", "bun"] as const)
	test(`force-close interrupts tracked ${language} startup and returns its admission slot`, async () => {
		using temp = TempDir.createSync("@kernel-startup-close-");
		const session = await createSession(temp.path());
		const interpreter = path.join(temp.path(), "unresponsive-interpreter");
		// A real executable that never completes the worker handshake exercises process teardown.
		await Bun.write(interpreter, "#!/bin/sh\nwhile :; do :; done\n");
		await fs.chmod(interpreter, 0o700);
		const tracked = Promise.withResolvers<void>();
		session.trackEvalExecution = execution => {
			tracked.resolve();
			return execution;
		};
		const startup = handleKernelControl(session, { op: "start", language, interpreter }).then(
			() => "unexpected success",
			error => String(error),
		);
		await tracked.promise;
		expect((await handleKernelControl(session, { op: "list" })).kernels?.[0].state).toBe("starting");
		await within(handleKernelControl(session, { op: "close", language, force: true }));
		expect(await startup).toContain("closed during startup");
		expect((await handleKernelControl(session, { op: "list" })).kernels).toEqual([]);
		expect(resolveKernelLaneConfiguration(session, language)).toBeUndefined();
		expect((await handleKernelControl(session, { op: "start", language })).kernel?.state).toBe("idle");
	}, 20_000);

test("session disposal guard prevents kernel startup", async () => {
	using temp = TempDir.createSync("@kernel-disposed-start-");
	const session = await createSession(temp.path());
	session.assertEvalExecutionAllowed = () => {
		throw new Error("Session is disposing");
	};
	await expect(handleKernelControl(session, { op: "start", language: "python" })).rejects.toThrow("disposing");
	expect((await handleKernelControl(session, { op: "list" })).kernels).toEqual([]);
});

test("disabled backends cannot start or reset but remain inspectable and closable", async () => {
	using temp = TempDir.createSync("@kernel-policy-");
	const session = await createSession(temp.path());
	await handleKernelControl(session, { op: "start", language: "bun" });
	session.settings.set("eval.js", false);
	for (const language of ["node", "bun"] as const)
		await expect(handleKernelControl(session, { op: "start", language, lane: "disabled" })).rejects.toThrow(
			"disabled",
		);
	await expect(handleKernelControl(session, { op: "reset", language: "bun" })).rejects.toThrow("disabled");
	expect((await handleKernelControl(session, { op: "inspect", language: "bun" })).kernel?.state).toBe("idle");
	await handleKernelControl(session, { op: "close", language: "bun" });
});

test("node and bun kernels on one lane are listed, reset, and closed independently on their real runtimes", async () => {
	using temp = TempDir.createSync("@kernel-runtimes-");
	const session = await createSession(temp.path());
	const node = (await handleKernelControl(session, { op: "start", language: "node", lane: "shared" })).kernel!;
	const bun = (await handleKernelControl(session, { op: "start", language: "bun", lane: "shared" })).kernel!;
	expect(node.interpreter).toBe(nodeInterpreter!);
	expect(bun.interpreter).toBe(process.execPath);
	const runtimeProbe =
		'var marker = typeof Bun === "undefined" ? "node" : "bun"; console.log(JSON.stringify({ marker, interpreter: kernelState().interpreter, bun: process.versions.bun ?? null }))';
	const probes = await Promise.all(
		(["node", "bun"] as const).map(async language =>
			JSON.parse((await execute(session, language, "shared", runtimeProbe)).output.trim()),
		),
	);
	expect(probes).toEqual([
		{ marker: "node", interpreter: node.interpreter, bun: null },
		{ marker: "bun", interpreter: bun.interpreter, bun: Bun.version },
	]);
	const listed = (await handleKernelControl(session, { op: "list", lane: "shared" })).kernels!;
	expect(listed.map(item => [item.language, item.generation])).toEqual([
		["bun", bun.generation],
		["node", node.generation],
	]);
	const reset = await handleKernelControl(session, { op: "reset", language: "node", lane: "shared" });
	expect(reset.kernel?.generation).not.toBe(node.generation);
	expect(
		(await handleKernelControl(session, { op: "inspect", language: "bun", lane: "shared" })).kernel?.generation,
	).toBe(bun.generation);
	expect((await execute(session, "node", "shared", "console.log(typeof marker)")).output).toContain("undefined");
	expect((await execute(session, "bun", "shared", "console.log(marker)")).output).toContain("bun");
	await handleKernelControl(session, { op: "close", language: "bun", lane: "shared" });
	expect((await handleKernelControl(session, { op: "list" })).kernels?.map(item => item.language)).toEqual(["node"]);
	await expect(handleKernelControl(session, { op: "inspect", language: "bun", lane: "shared" })).rejects.toThrow(
		"Unknown bun kernel lane",
	);
}, 30_000);

test("node kernels reject remote targets before connecting or retaining the lane configuration", async () => {
	using temp = TempDir.createSync("@kernel-node-remote-");
	const session = await createSession(temp.path());
	const tracked: Promise<unknown>[] = [];
	session.trackEvalExecution = execution => {
		tracked.push(execution);
		return execution;
	};
	await expect(
		handleKernelControl(session, {
			op: "start",
			language: "node",
			target: { kind: "ssh", host: "proto-test-unreachable.invalid", cwd: "/work" },
		}),
	).rejects.toThrow(NODE_REMOTE_TARGET_UNSUPPORTED);
	expect(tracked).toEqual([]);
	expect(resolveKernelLaneConfiguration(session, "node")).toBeUndefined();
	expect((await handleKernelControl(session, { op: "list" })).kernels).toEqual([]);
});
