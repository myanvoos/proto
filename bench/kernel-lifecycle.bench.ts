import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../packages/coding-agent/src/config/settings";
import { disposeVmContextsByOwner, executeInVmContext } from "../packages/coding-agent/src/eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../packages/coding-agent/src/eval/py/executor";
import { PythonKernel } from "../packages/coding-agent/src/eval/py/kernel";
import { disposePyToolBridge } from "../packages/coding-agent/src/eval/py/tool-bridge";
import { disposeAllBashSessions, executeBash } from "../packages/coding-agent/src/exec/bash-executor";
import type { ToolSession } from "../packages/coding-agent/src/tools";
import { BashTool } from "../packages/coding-agent/src/tools/bash";

// Run: bun bench/kernel-lifecycle.bench.ts [--output-only]
// Requires Bun, a local Python interpreter, built native bindings, and Linux
// /proc for process/fd metrics. Samples are diagnostics, not timing assertions;
// RSS includes allocator high-water marks, not only retained live objects.
if (process.platform !== "linux") throw new Error("Kernel lifecycle resource benchmark requires Linux /proc");

async function measureOutput(): Promise<void> {
	const kernel = await PythonKernel.start({ cwd: process.cwd() });
	try {
		for (const mb of [1, 5, 10]) {
			Bun.gc(true);
			const before = process.memoryUsage();
			let characters = 0;
			const start = performance.now();
			const result = await kernel.execute(`print('X' * (${mb} * 1024 * 1024))`, {
				onChunk: chunk => {
					characters += chunk.length;
				},
			});
			assert.equal(result.status, "ok");
			assert.equal(characters, mb * 1024 * 1024 + 1);
			const after = process.memoryUsage();
			console.log(
				JSON.stringify({
					kind: "python-output",
					mb,
					ms: Math.round(performance.now() - start),
					rssDelta: after.rss - before.rss,
					heapDelta: after.heapUsed - before.heapUsed,
				}),
			);
		}
	} finally {
		assert.equal((await kernel.shutdown()).confirmed, true);
	}
}

async function measureLifecycle(): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "proto-kernel-scale-"));
	await fs.mkdir(path.join(cwd, "artifacts"));
	const owner = `scale-${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, inMemory: true });
	let artifactCounter = 0;
	const session: ToolSession = {
		allocateOutputArtifact: async () => ({
			path: path.join(cwd, "artifacts", `${++artifactCounter}.txt`),
			id: String(artifactCounter),
		}),
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
	};
	const options = { sessionKey: owner, sessionId: owner, ownerId: owner, cwd, session, filename: "scale.js" };
	const metrics: Record<string, unknown> = {
		kind: "kernel-lifecycle",
		bunVersion: Bun.version,
		platform: `${process.platform}-${process.arch}`,
	};
	const py = await PythonKernel.start({ cwd });
	async function python(code: string) {
		let output = "";
		const result = await py.execute(code, {
			onChunk: text => {
				output += text;
			},
			timeoutMs: 10000,
		});
		assert.equal(result.status, "ok", JSON.stringify(result));
		return output.trim();
	}
	async function js(code: string) {
		let output = "";
		await executeInVmContext({
			...options,
			code,
			runState: {
				onText: text => {
					output += text;
				},
			},
		});
		return output.trim();
	}
	const pyMetrics =
		"import os, threading, json, gc, resource\ngc.collect()\nprint(json.dumps({'pid': os.getpid(), 'fds': len(os.listdir('/proc/self/fd')), 'threads': threading.active_count(), 'maxrss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}))";
	const jsMetrics =
		"Bun.gc(true); console.log(JSON.stringify({pid:process.pid,rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed}));";
	const pids: number[] = [];
	try {
		await python("counter=0");
		await js("var counter=0;");
		const pythonPid = Number(await python("print(__import__('os').getpid())"));
		const jsPid = Number(await js("console.log(process.pid)"));
		pids.push(pythonPid, jsPid);
		metrics.pythonBefore = JSON.parse(await python(pyMetrics));
		metrics.jsBefore = JSON.parse(await js(jsMetrics));
		const hostBefore = { rss: process.memoryUsage().rss, fds: (await fs.readdir("/proc/self/fd")).length };
		for (const [name, run] of [
			["python", () => python("counter += 1")],
			["js", () => js("counter += 1;")],
		] as const) {
			const start = performance.now();
			for (let i = 0; i < 500; i++) await run();
			metrics[`${name}500SequentialMs`] = Math.round(performance.now() - start);
			const concurrent = performance.now();
			await Promise.all(Array.from({ length: 100 }, run));
			metrics[`${name}100ConcurrentMs`] = Math.round(performance.now() - concurrent);
		}
		assert.equal(await python("print(counter)"), "600");
		assert.equal(await js("console.log(counter)"), "600");
		metrics.pythonAfter = JSON.parse(await python(pyMetrics));
		metrics.jsAfter = JSON.parse(await js(jsMetrics));
		const scaleStart = performance.now();
		for (let batch = 0; batch < 54; batch++) {
			await Promise.all(Array.from({ length: 100 }, () => python("counter += 1")));
			await Promise.all(Array.from({ length: 100 }, () => js("counter += 1;")));
		}
		assert.equal(await python("print(counter)"), "6000");
		assert.equal(await js("console.log(counter)"), "6000");
		metrics.extended5400EachMs = Math.round(performance.now() - scaleStart);
		metrics.python6000 = JSON.parse(await python(pyMetrics));
		metrics.js6000 = JSON.parse(await js(jsMetrics));

		const shellStart = performance.now();
		for (let i = 0; i < 250; i++) {
			const result = await executeBash("printf shell-ok", { cwd, sessionKey: owner });
			assert.equal(result.exitCode, 0);
			assert.equal(result.output, "shell-ok");
		}
		metrics.shell250SequentialMs = Math.round(performance.now() - shellStart);
		const concurrentStart = performance.now();
		const results = await Promise.all(
			Array.from({ length: 64 }, (_, i) => executeBash(`printf ${i}`, { cwd, sessionKey: owner })),
		);
		results.forEach((r, i) => {
			assert.equal(r.exitCode, 0);
			assert.equal(r.output, String(i));
		});
		metrics.shell64ConcurrentMs = Math.round(performance.now() - concurrentStart);
		const timed = await executeBash("sleep 10", { cwd, timeout: 50 });
		assert.equal(timed.timedOut, true);
		metrics.shellTimeout = timed.execution;
		const bash = new BashTool(session);
		const text = (r: { content: Array<{ type: string; text?: string }> }) =>
			r.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
		for (const [id, command, expected] of [
			["python", "python -c 'route_counter=41; print(route_counter)'", "41"],
			["node", "node -e 'var route_counter=40; console.log(route_counter)'", "40"],
			["bun", "bun -e 'console.log(route_counter+2)'", "42"],
		] as const) {
			const result = await bash.execute(id, { command });
			assert.ok(text(result).includes(expected), text(result));
			assert.ok(!result.isError);
			metrics[`${id}Route`] = true;
		}
		const largeStart = performance.now();
		const large = await bash.execute("large", { command: "python -c 'print(\"X\" * (5 * 1024 * 1024))'" });
		assert.ok(!large.isError);
		const artifacts = await fs.readdir(path.join(cwd, "artifacts"));
		let largest = 0;
		for (const file of artifacts) {
			const st = await fs.stat(path.join(cwd, "artifacts", file));
			largest = Math.max(largest, st.size);
		}
		assert.ok(largest >= 5 * 1024 * 1024);
		metrics.largeOutput = {
			elapsedMs: Math.round(performance.now() - largeStart),
			sourceBytes: 5 * 1024 * 1024,
			returnedCharacters: text(large).length,
			largestArtifactBytes: largest,
			details: large.details,
		};
		Bun.gc(true);
		metrics.host = {
			before: hostBefore,
			after: { rss: process.memoryUsage().rss, fds: (await fs.readdir("/proc/self/fd")).length },
		};
	} finally {
		const start = performance.now();
		metrics.pythonShutdown = await py.shutdown();
		await Promise.all([
			disposeVmContextsByOwner(owner),
			disposeKernelSessionsByOwner(owner),
			disposeAllBashSessions(),
		]);
		await disposePyToolBridge();
		metrics.disposalMs = Math.round(performance.now() - start);
		for (const pid of pids)
			assert.equal(await Bun.file(`/proc/${pid}/status`).exists(), false, `leaked worker ${pid}`);
		Bun.gc(true);
		metrics.hostAfterDisposal = { rss: process.memoryUsage().rss, fds: (await fs.readdir("/proc/self/fd")).length };
		console.log(JSON.stringify(metrics, null, 2));
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

await measureOutput();
if (!Bun.argv.includes("--output-only")) await measureLifecycle();
