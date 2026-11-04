import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { isEnoent, setAgentDir } from "@oh-my-pi/pi-utils";
import { Terminal } from "@oh-my-pi/pi-utils/vterm";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { workerEnvFromParent } from "../../src/subprocess/worker-client";

interface Stage {
	phase: string;
	hasUI: boolean;
	mode: string;
	depth: number;
	sessionId: string;
	nodeId: string;
	rootId: string;
	rootUnchanged: boolean;
	sourceTreeUnchanged: boolean;
	worker?: { id: string; parentNodeId?: string; rootId?: string };
}

interface Report {
	selected: { id: string; sessionId: string; label: string };
	rootSessionId: string;
	rootNodeId: string;
	stages: Stage[];
	compactions: Array<{ sessionId: string; summary: string; fromExtension: boolean; entryId: string }>;
	providerRequests: Array<{ sessionId?: string; model: string; level: number }>;
}

const configuredRoot = process.env.PROTO_DEEP_FOCUSED_ROOT;
assert(configuredRoot, "PROTO_DEEP_FOCUSED_ROOT must be supplied before starting the isolated driver");
const root: string = configuredRoot;
const project = path.join(root, "project");
setAgentDir(path.join(root, "agent"));

async function shutdownBroker(): Promise<void> {
	const client = await createDaemonBrokerClient(project);
	const endpoint = daemonBrokerEndpoint(project, client.runtimeDir);
	try {
		await fs.access(endpoint);
	} catch (error) {
		client.close();
		if (isEnoent(error)) return;
		throw error;
	}
	const controller = new AbortController();
	// Broker teardown runs in another process on the platform clock.
	const timer = setTimeout(() => controller.abort(new Error("Isolated broker did not finish shutting down")), 15_000);
	const events = fs.watch(client.runtimeDir, { signal: controller.signal })[Symbol.asyncIterator]();
	let nextEvent = events.next();
	try {
		await client.request({ op: "shutdown" });
		while (true) {
			const event = await nextEvent;
			if (event.done) return;
			nextEvent = events.next();
			if (event.value.filename !== path.basename(endpoint)) continue;
			try {
				await fs.access(endpoint);
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
		await nextEvent.catch(() => undefined);
		client.close();
	}
}

if (process.argv.includes("--cleanup")) {
	await shutdownBroker();
} else {
	await fs.mkdir(project, { recursive: true });
	const configPath = path.join(root, "deep-config.json");
	await Bun.write(
		configPath,
		JSON.stringify({
			compaction: { enabled: false, keepRecentTokens: 1 },
			branchSummary: { enabled: false },
			orchestrator: { agentIdleTtlMs: 300_000 },
			disabledProviders: ["ollama", "lm-studio", "llama.cpp"],
		}),
	);
	const pty = new PtySession();
	const terminal = new Terminal({ cols: 140, rows: 45, scrollback: 5000 });
	const screens: Array<{ step: string; screen: string }> = [];
	const screenText = (): string => {
		const buffer = terminal.buffer.active;
		return Array.from(
			{ length: terminal.rows },
			(_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "",
		).join("\n");
	};
	let output = "";
	let ended = false;
	let streamError: Error | undefined;
	const listeners = new Set<() => void>();
	const steps: string[] = [];
	const capturePath = path.join(root, "capture.ansi");
	const proofPath = path.join(root, "driver-proof.json");
	const compiledExecutable = process.env.PROTO_COMPILED_PYTHON_TEST_BIN;
	let extensionPath = path.resolve(import.meta.dir, "deep-focused-extension.ts");
	if (compiledExecutable) {
		// Installed CLIs expose their SDK/AI modules, not this workspace's utility package.
		// Ship the fixture like a standalone extension: bundle its utility dependency.
		const bundled = await Bun.build({
			entrypoints: [extensionPath],
			target: "bun",
			external: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-ai"],
		});
		if (!bundled.success) throw new AggregateError(bundled.logs, "Failed to bundle the terminal fixture");
		extensionPath = path.join(root, "deep-focused-extension.js");
		await Bun.write(extensionPath, bundled.outputs[0]);
	}
	const run = pty.startArgv(
		{
			application: compiledExecutable ?? process.execPath,
			args: [
				...(compiledExecutable ? [] : [path.resolve(import.meta.dir, "../../src/cli.ts")]),
				"--trusted-extension",
				extensionPath,
				"--provider",
				"p1-deep",
				"--model",
				"root",
				"--no-title",
				"--no-skills",
				"--no-rules",
				"--no-context-files",
				"--config",
				configPath,
			],
			cwd: project,
			env: workerEnvFromParent({ TERM: "xterm-256color", FORCE_COLOR: "1" }),
			cols: 140,
			rows: 45,
			timeoutMs: 180_000,
		},
		(error, chunk) => {
			if (error) streamError = error;
			output += chunk;
			terminal.write(chunk);
			for (const listener of listeners) listener();
		},
	);
	void run.then(
		() => {
			ended = true;
			for (const listener of listeners) listener();
		},
		error => {
			streamError = error instanceof Error ? error : new Error(String(error));
			ended = true;
			for (const listener of listeners) listener();
		},
	);

	async function waitFor(
		pattern: string | RegExp | ((visible: string) => boolean),
		startAt = 0,
		screen = false,
	): Promise<string> {
		const pending = Promise.withResolvers<string>();
		const listener = () => {
			const visible = screen ? screenText() : Bun.stripANSI(output.slice(startAt));
			const matches =
				typeof pattern === "function"
					? pattern(visible)
					: typeof pattern === "string"
						? visible.includes(pattern)
						: pattern.test(visible);
			if (matches) pending.resolve(visible);
			else if (/Extension "[^"\r\n]+" error:/.test(visible)) pending.reject(new Error(visible));
			else if (streamError) pending.reject(streamError);
			else if (ended) pending.reject(new Error(`TUI exited before ${String(pattern)}`));
		};
		listeners.add(listener);
		listener();
		// Native PTY output arrives on the child platform clock; this is a failure deadline, not a sleep.
		const timer = setTimeout(
			() => pending.reject(new Error(`TUI missing ${String(pattern)} after ${steps.join(" → ")}`)),
			30_000,
		);
		try {
			return await pending.promise;
		} finally {
			clearTimeout(timer);
			listeners.delete(listener);
		}
	}

	async function command(text: string, pattern: string | RegExp): Promise<string> {
		const startAt = output.length;
		pty.write(`\x1b[200~${text}\x1b[201~`);
		await waitFor(visible => visible.replace(/[\s┆]/g, "").includes(text.slice(-40).replace(/\s/g, "")), 0, true);
		pty.write("\r");
		const visible = await waitFor(pattern, startAt);
		steps.push(text);
		screens.push({ step: text, screen: screenText() });
		return visible;
	}

	async function report(): Promise<Report> {
		return (await Bun.file(path.join(root, "report.json")).json()) as Report;
	}

	async function proof(phase: string, depth: number, text = `/deep-proof ${phase}`): Promise<Stage> {
		const controller = new AbortController();
		const events = fs.watch(root, { signal: controller.signal })[Symbol.asyncIterator]();
		let nextEvent = events.next();
		// The watched extension runs in a real PTY child; fake timers cannot advance its filesystem events.
		const timer = setTimeout(() => controller.abort(new Error(`Missing persisted ${phase} proof`)), 30_000);
		let stage: Stage | undefined;
		const outputStart = output.length;
		try {
			pty.write(`\x1b[200~${text}\x1b[201~`);
			await waitFor(visible => visible.replace(/[\s┆]/g, "").includes(text.slice(-40).replace(/\s/g, "")), 0, true);
			pty.write("\r");
			stage = (await report()).stages.find(candidate => candidate.phase === phase);
			while (!stage) {
				const event = await nextEvent;
				nextEvent = events.next();
				if (event.done) throw new Error(`Report watcher ended before ${phase}`);
				if (event.value.filename !== "report.json") continue;
				stage = (await report()).stages.find(candidate => candidate.phase === phase);
			}
		} finally {
			clearTimeout(timer);
			controller.abort();
			await nextEvent.catch(() => undefined);
		}
		await waitFor(`DEEP_PROOF_${phase}_DEPTH_${depth}`, outputStart);
		await waitFor(`DEEP_PROOF_${phase}_DEPTH_${depth}`, 0, true);
		steps.push(text);
		screens.push({ step: text, screen: screenText() });
		assert(stage, `Missing persisted ${phase} proof`);
		assert.equal(stage.hasUI, true);
		assert.equal(stage.mode, "tui");
		assert.equal(stage.depth, depth);
		assert.equal(stage.rootUnchanged, true);
		assert.equal(stage.sourceTreeUnchanged, true);
		return stage;
	}

	let failure: unknown;
	try {
		await waitFor("DEEP_FIXTURE_READY");
		const freshFirst = await command(
			"$import os; transient_value = 41; print('PY' + 'FRESH1', os.getpid())",
			/PYFRESH1 \d+/,
		);
		const firstPid = freshFirst.match(/PYFRESH1 (\d+)/)?.[1];
		assert(firstPid, "First user Python process did not report its PID");
		const freshSecond = await command(
			"$import os; print('PY' + 'FRESH2', os.getpid(), 'transient_value' in globals(), 'tool' in globals())",
			/PYFRESH2 \d+ False False/,
		);
		assert.notEqual(freshSecond.match(/PYFRESH2 (\d+)/)?.[1], firstPid);
		await command(
			`$import proto_harness as harness; harness.store["root_answer"] = 42; harness.kernel("analysis").run("warm_value = 41"); print('PY' + 'SEEDED')`,
			"PYSEEDED",
		);
		await command(
			`$import proto_harness as harness; print('PY' + 'ROOTSTORE', harness.store["root_answer"]); print(harness.kernel("analysis").run("print('PY' + 'NAMED', warm_value + 1)")["output"])`,
			"PYNAMED 42",
		);
		await command("/deep-setup", "DEEP_SETUP_READY");
		const setup = await report();
		assert.notEqual(setup.selected.sessionId, setup.rootSessionId);
		await command("/tree", "Session Tree");
		const searchStart = output.length;
		pty.write("Deep3");
		await waitFor("Search: Deep3", searchStart, true);
		pty.write("\x1b[F");
		await waitFor(/›[^\r\n]*Deep3/, 0, true);
		screens.push({ step: "select visible Deep3 row", screen: screenText() });
		const focusStart = output.length;
		pty.write("\r");
		await waitFor(`Viewing agent ${setup.selected.id}`, focusStart);
		steps.push("focus Deep3 through root tree");
		await proof("focused", 3);
		await command("/deep-dialog", "DEEP_MANUAL_DIALOG");
		await waitFor("DEEP_MANUAL_DIALOG", 0, true);
		pty.write("\r");
		await waitFor("DEEP_PROOF_dialog_DEPTH_3", 0, true);
		screens.push({ step: "confirm manual child dialog", screen: screenText() });

		const info = await command("/session info", setup.selected.sessionId);
		assert(!info.includes(setup.rootSessionId), "Focused session info leaked the root identity");
		const contextStart = output.length;
		await command("/context", "Context Usage");
		const contextFull = await waitFor("P1 focused child", contextStart, true);
		assert(!contextFull.includes("P1 root only"), "Focused context displayed the root model");
		await command("/compact", /compacted.*ctrl\+o/);
		pty.write("\x0f");
		await waitFor("DEPTH3_COMPACT_SUMMARY", 0, true);
		screens.push({ step: "expand selected compaction", screen: screenText() });
		const compactReport = await report();
		assert(
			compactReport.compactions.some(
				entry =>
					entry.sessionId === setup.selected.sessionId &&
					entry.summary === "DEPTH3_COMPACT_SUMMARY" &&
					entry.fromExtension &&
					entry.entryId,
			),
		);
		await proof("compact", 3);
		const treeStart = output.length;
		await command("/tree", "Session Tree");
		await waitFor(/DEEP_LEVEL_3|DEPTH3_COMPACT_SUMMARY/, treeStart, true);
		pty.write("\x1b");
		await waitFor(/^(?![\s\S]*Session Tree)[\s\S]*›\s+ask anything/, 0, true);
		await proof("tree", 3);
		await command(
			`$import proto_harness as harness; print('PY' + 'CHILDISOLATED', "root_answer" in harness.store); print('PY' + 'OUTPUT', harness.output(${JSON.stringify(setup.selected.id)}).strip() == "DEEP_RESULT_3"); harness.store["child_answer"] = 42; harness.kernel("analysis").run("shared = []; graph = [shared, shared]; shared.append(graph); closure = lambda: 42"); print('PY' + 'CHILDREADY')`,
			"PYCHILDREADY",
		);
		assert(Bun.stripANSI(output).includes("PYCHILDISOLATED False"), "Child inherited the root's Python store");
		assert(
			Bun.stripANSI(output).includes("PYOUTPUT True"),
			"Fresh Python could not read its published worker output",
		);
		await proof("beforefork", 3);
		await command("/fork", /[Ff]orked/);
		const fork = await proof("fork", 0);
		assert.notEqual(fork.sessionId, setup.selected.sessionId);
		assert.notEqual(fork.sessionId, setup.rootSessionId);
		assert.equal(fork.rootId, fork.nodeId);
		await command(
			`$import proto_harness as harness; print('PY' + 'FORKSTORE', harness.store["child_answer"]); print(harness.kernel("analysis").run("print('PY' + 'FORKGRAPH', graph[0] is graph[1], graph[0][0] is graph, closure())")["output"])`,
			"PYFORKGRAPH True True 42",
		);
		assert(Bun.stripANSI(output).includes("PYFORKSTORE 42"), "Independent root lost the child's Python store");
		const independent = await proof("independent", 0, "/deep-independent");
		const finalReport = await report();
		assert(independent?.worker, "Independent fork did not create a real worker");
		assert.equal(independent.depth, 0);
		assert.equal(independent.sessionId, fork.sessionId);
		assert.equal(independent.worker.parentNodeId, fork.nodeId);
		assert.equal(independent.worker.rootId, fork.nodeId);
		assert.equal(independent.rootUnchanged, true);
		assert.equal(independent.sourceTreeUnchanged, true);
		await Bun.write(
			proofPath,
			JSON.stringify({ success: true, steps, screens, report: finalReport, capturePath }, null, 2),
		);
		pty.write("\x04");
		const exit = await run;
		assert.equal(exit.exitCode, 0, "Real TUI did not shut down cleanly");
		await Bun.write(Bun.stdout, `${JSON.stringify({ success: true, proofPath, capturePath })}\n`);
	} catch (error) {
		failure = error;
		await Bun.write(
			proofPath,
			JSON.stringify(
				{ success: false, steps, screens, error: String(error), capturePath, screen: screenText() },
				null,
				2,
			),
		);
	} finally {
		await Bun.write(capturePath, output);
		if (!ended) {
			try {
				pty.kill();
			} catch {}
		}
		await run.catch(() => undefined);
		terminal.dispose();
		try {
			await shutdownBroker();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure)
		throw new Error(`Deep focused TUI proof failed; capture: ${capturePath}; proof: ${proofPath}`, {
			cause: failure,
		});
}
