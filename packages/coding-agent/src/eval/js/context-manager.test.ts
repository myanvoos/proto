import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";

afterEach(() => vi.restoreAllMocks());

test("reports uncertain completion without replaying a cell after the JS worker dies", async () => {
	using tempDir = TempDir.createSync("@js-worker-crash-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const effectsPath = path.join(cwd, "effects.txt");
	const crashCode = [
		`const effectsPath = ${JSON.stringify(effectsPath)};`,
		'const previous = await Bun.file(effectsPath).text().catch(() => "");',
		'await Bun.write(effectsPath, previous + "once\\n");',
		"process.exit(17);",
	].join("\n");

	try {
		await expect(
			executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				ownerId,
				cwd,
				session: toolSession,
				code: crashCode,
				filename: "crashing-cell.js",
				runState: {},
			}),
		).rejects.toThrow("completion is uncertain");
		expect(await Bun.file(effectsPath).text()).toBe("once\n");

		await executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: `await Bun.write(${JSON.stringify(effectsPath)}, (await Bun.file(${JSON.stringify(effectsPath)}).text()) + "next\\n");`,
			filename: "next-cell.js",
			runState: {},
		});
		expect(await Bun.file(effectsPath).text()).toBe("once\nnext\n");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 30_000);

test("JS stale-write guard rejects clobbering a file changed after the cell read it", async () => {
	using tempDir = TempDir.createSync("@js-stale-write-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const target = path.join(cwd, "shared.txt");
	const bunTarget = path.join(cwd, "shared-bun.txt");
	await Bun.write(target, "OLD1");
	await Bun.write(bunTarget, "OLD2");

	const run = (code: string, runState: { onText?: (chunk: string) => void } = {}) =>
		executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code,
			filename: `cell-${crypto.randomUUID()}.js`,
			runState,
		});

	try {
		await run(`fs.readFileSync(${JSON.stringify(target)}, "utf8")`);
		await Bun.write(target, "EVIL");
		await expect(run(`fs.writeFileSync(${JSON.stringify(target)}, "MINE")`)).rejects.toThrow(
			/StaleWriteError|changed on disk/,
		);
		expect(await Bun.file(target).text()).toBe("EVIL");

		await run(`await Bun.file(${JSON.stringify(bunTarget)}).text()`);
		await Bun.write(bunTarget, "EVIL2");
		await expect(run(`await Bun.write(${JSON.stringify(bunTarget)}, "MINE2")`)).rejects.toThrow(
			/StaleWriteError|changed on disk/,
		);
		expect(await Bun.file(bunTarget).text()).toBe("EVIL2");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 15_000);

test("same-metadata external edits still trigger the JS stale-write guard", async () => {
	using tempDir = TempDir.createSync("@js-stale-hash-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const target = path.join(cwd, "same-metadata.txt");
	const fixedTime = new Date(1_700_000_000_000);
	await Bun.write(target, "OLD1");
	fs.utimesSync(target, fixedTime, fixedTime);
	const run = (code: string) =>
		executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code,
			filename: `cell-${crypto.randomUUID()}.js`,
			runState: {},
		});

	try {
		await run(`fs.readFileSync(${JSON.stringify(target)}, "utf8")`);
		await Bun.write(target, "EVIL");
		fs.utimesSync(target, fixedTime, fixedTime);
		await expect(run(`fs.writeFileSync(${JSON.stringify(target)}, "MINE")`)).rejects.toThrow(
			/StaleWriteError|changed on disk/,
		);
		expect(await Bun.file(target).text()).toBe("EVIL");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 15_000);

test("background JavaScript file writes stay attributed to their originating cell", async () => {
	using tempDir = TempDir.createSync("@js-background-files-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const backgroundPath = path.join(cwd, "background.txt");
	const foregroundPath = path.join(cwd, "foreground.txt");
	const firstPaths: string[] = [];
	const secondPaths: string[] = [];
	const run = (code: string, paths: string[]) =>
		executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code,
			filename: `cell-${crypto.randomUUID()}.js`,
			runState: {
				onDisplay: output => {
					if (output.type === "status" && output.event.op === "write" && typeof output.event.path === "string") {
						paths.push(output.event.path);
					}
				},
			},
		});

	try {
		await run(
			`globalThis.backgroundGate = Promise.withResolvers();\nvoid (async () => { await backgroundGate.promise; fs.writeFileSync(${JSON.stringify(backgroundPath)}, "background"); })();`,
			firstPaths,
		);
		await run(
			`backgroundGate.resolve();\nawait new Promise(resolve => setImmediate(resolve));\nfs.writeFileSync(${JSON.stringify(foregroundPath)}, "foreground");`,
			secondPaths,
		);
		expect(firstPaths).toContain(backgroundPath);
		expect(secondPaths).toContain(foregroundPath);
		expect(secondPaths).not.toContain(backgroundPath);
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 15_000);

test("Bun.file writer mutations are guarded and reported", async () => {
	using tempDir = TempDir.createSync("@js-bun-writer-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const target = path.join(cwd, "writer.txt");
	const events: string[] = [];
	const run = (code: string) =>
		executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code,
			filename: `cell-${crypto.randomUUID()}.js`,
			runState: {
				onDisplay: output => {
					if (output.type === "status" && output.event.op === "write" && typeof output.event.path === "string") {
						events.push(output.event.path);
					}
				},
			},
		});

	try {
		await Bun.write(target, "OLD1");
		await run(`await Bun.file(${JSON.stringify(target)}).text()`);
		await Bun.write(target, "EVIL");
		await expect(
			run(`const writer = Bun.file(${JSON.stringify(target)}).writer(); writer.write("MINE"); writer.end();`),
		).rejects.toThrow(/StaleWriteError|changed on disk/);
		expect(await Bun.file(target).text()).toBe("EVIL");

		await run(`await Bun.file(${JSON.stringify(target)}).text()`);
		await run(`const writer = Bun.file(${JSON.stringify(target)}).writer(); writer.write("SAFE"); writer.end();`);
		expect(events).toContain(target);
		expect(await Bun.file(target).text()).toBe("SAFE");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 15_000);

test("background JavaScript output remains visible after its run result settles", async () => {
	using tempDir = TempDir.createSync("@js-background-output-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const output: string[] = [];
	const seen = Promise.withResolvers<void>();

	try {
		await executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: 'setTimeout(() => console.log("LATE_JS_OUTPUT"), 50);',
			filename: "background-output.js",
			runState: {
				onText: chunk => {
					output.push(chunk);
					if (chunk.includes("LATE_JS_OUTPUT")) seen.resolve();
				},
			},
		});
		// This deliberately exercises a real background timer in the isolated
		// runtime; awaiting its emitted signal avoids a guessed test-side delay.
		await seen.promise;
		expect(output.join("")).toContain("LATE_JS_OUTPUT");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 15_000);

test("fails closed when neither isolated JS worker can be created", async () => {
	using tempDir = TempDir.createSync("@js-worker-isolation-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const hostMarker = `__proto_host_eval_${crypto.randomUUID().replaceAll("-", "")}`;

	vi.spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("forced subprocess spawn failure");
	});
	const workerGlobal = globalThis as unknown as {
		Worker: (scriptURL: string | URL, options?: WorkerOptions) => Worker;
	};
	vi.spyOn(workerGlobal, "Worker").mockImplementation(() => {
		throw new Error("forced Worker construction failure");
	});

	try {
		await expect(
			executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				ownerId,
				cwd,
				session: toolSession,
				code: `globalThis[${JSON.stringify(hostMarker)}] = true;`,
				filename: "must-stay-isolated.js",
				runState: {},
			}),
		).rejects.toThrow(/isolated|worker/i);
		expect(Reflect.has(globalThis, hostMarker)).toBe(false);
	} finally {
		delete (globalThis as Record<string, unknown>)[hostMarker];
		await disposeVmContextsByOwner(ownerId);
	}
});

test("interrupts an active JS cell and starts a clean worker for the next cell", async () => {
	using tempDir = TempDir.createSync("@js-worker-cancel-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const controller = new AbortController();
	const ready = Promise.withResolvers<void>();
	const nextCellPath = path.join(cwd, "next-cell.txt");

	try {
		const active = executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: 'console.log("ready"); const { promise } = Promise.withResolvers(); await promise;',
			filename: "cancelled-cell.js",
			runState: {
				signal: controller.signal,
				onText: chunk => {
					if (chunk.includes("ready")) ready.resolve();
				},
			},
		});
		await ready.promise;
		controller.abort(new Error("cancel active JS cell"));
		await expect(active).rejects.toThrow("cancel active JS cell");

		await expect(
			executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				ownerId,
				cwd,
				session: toolSession,
				code: `await Bun.write(${JSON.stringify(nextCellPath)}, "healthy");`,
				filename: "healthy-cell.js",
				runState: {},
			}),
		).resolves.toEqual({ value: undefined });
		expect(await Bun.file(nextCellPath).text()).toBe("healthy");
	} finally {
		controller.abort();
		await disposeVmContextsByOwner(ownerId);
	}
}, 10_000);

test("reset rejects the active and queued JS cells before starting a fresh worker", async () => {
	using tempDir = TempDir.createSync("@js-worker-reset-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const ready = Promise.withResolvers<void>();
	const queuedPath = path.join(cwd, "queued.txt");
	const resetPath = path.join(cwd, "reset.txt");

	try {
		const active = executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: 'console.log("ready"); const { promise } = Promise.withResolvers(); await promise;',
			filename: "active-before-reset.js",
			runState: {
				onText: chunk => {
					if (chunk.includes("ready")) ready.resolve();
				},
			},
		});
		await ready.promise;
		const queued = executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			code: `await Bun.write(${JSON.stringify(queuedPath)}, "must not run");`,
			filename: "queued-before-reset.js",
			runState: {},
		});
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;

		const reset = executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			ownerId,
			cwd,
			session: toolSession,
			reset: true,
			code: `await Bun.write(${JSON.stringify(resetPath)}, "fresh");`,
			filename: "reset-cell.js",
			runState: {},
		});
		const interrupted = await Promise.allSettled([active, queued]);
		expect(interrupted.map(result => result.status)).toEqual(["rejected", "rejected"]);
		for (const result of interrupted) {
			if (result.status === "rejected") expect(String(result.reason)).toContain("JS context reset");
		}
		await expect(reset).resolves.toEqual({ value: undefined });
		expect(await Bun.file(queuedPath).exists()).toBe(false);
		expect(await Bun.file(resetPath).text()).toBe("fresh");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 10_000);

test("an already-cancelled JS cell cannot reset or mutate the live kernel", async () => {
	using tempDir = TempDir.createSync("@js-worker-preabort-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = { sessionKey: sessionId, sessionId, ownerId, cwd, session, filename: "preabort.js" };
	try {
		await executeInVmContext({ ...options, code: "var preserved = 42;", runState: {} });
		await expect(
			executeInVmContext({
				...options,
				reset: true,
				code: "preserved = 0;",
				runState: { signal: AbortSignal.abort(new Error("cancel before dispatch")) },
			}),
		).rejects.toThrow("cancel before dispatch");
		let output = "";
		await executeInVmContext({
			...options,
			code: "console.log(preserved)",
			runState: {
				onText: text => {
					output += text;
				},
			},
		});
		expect(output.trim()).toBe("42");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 10_000);

test("a failed JS output consumer rejects its cell without breaking later cells", async () => {
	using tempDir = TempDir.createSync("@js-worker-output-error-");
	const cwd = tempDir.path();
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const sessionId = `test-session:${crypto.randomUUID()}`;
	const ownerId = `test-owner:${crypto.randomUUID()}`;
	const options = { sessionKey: sessionId, sessionId, ownerId, cwd, session, filename: "output-error.js" };
	try {
		await expect(
			executeInVmContext({
				...options,
				code: "var consumerProbe = 42; console.log('first'); console.log('second');",
				runState: {
					onText: () => {
						throw new Error("output storage unavailable");
					},
				},
			}),
		).rejects.toThrow("output storage unavailable");
		let output = "";
		await executeInVmContext({
			...options,
			code: "console.log(consumerProbe)",
			runState: {
				onText: text => {
					output += text;
				},
			},
		});
		expect(output.trim()).toBe("42");
	} finally {
		await disposeVmContextsByOwner(ownerId);
	}
}, 10_000);
