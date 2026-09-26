import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../async";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { handleKernelControl } from "../eval/kernel-control";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { runEvalRuntime } from "../eval/runtime-bridge";
import { disposeBashSessions, executeBash } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

async function fixture(run: (bash: BashTool, cwd: string, owner: string, session: ToolSession) => Promise<void>) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-runtime-"));
	const owner = `kernel-runtime-${crypto.randomUUID()}`;
	const session = {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => {
			const id = crypto.randomUUID();
			return { id, path: path.join(cwd, "artifacts", id) };
		},
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession;
	try {
		await run(new BashTool(session), cwd, owner, session);
	} finally {
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

afterEach(() => vi.restoreAllMocks());

function text(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

for (const lang of ["python", "node"] as const) {
	test(`${lang} cells see shell overrides and preserve stderr redirection`, async () => {
		await fixture(async (bash, cwd) => {
			const source =
				lang === "python"
					? 'import os,sys; print(os.environ["RUNTIME_ENV"]); print("diagnostic", file=sys.stderr)'
					: 'console.log(process.env.RUNTIME_ENV); process.stderr.write("diagnostic\\n")';
			const flag = lang === "python" ? "-c" : "-e";
			const result = await bash.execute("env", {
				command: `${lang} ${flag} '${source}' 2> stderr-capture.txt`,
				env: { RUNTIME_ENV: "tool-value" },
			});
			expect(text(result)).toContain("tool-value");
			expect(text(result)).not.toContain("diagnostic");
			expect(await Bun.file(path.join(cwd, "stderr-capture.txt")).text()).toContain("diagnostic");
			const inline = await bash.execute("inline", {
				command: `RUNTIME_ENV=inline-value ${lang} ${flag} '${source}' 2> stderr-capture.txt`,
			});
			expect(text(inline)).toContain("inline-value");
		});
	}, 30_000);

	test(`${lang} piped input retains prior cell state`, async () => {
		await fixture(async bash => {
			const flag = lang === "python" ? "-c" : "-e";
			await bash.execute("seed", {
				command: `${lang} ${flag} '${lang === "python" ? "runtime_marker = 41" : "globalThis.runtime_marker = 41"}'`,
			});
			const source =
				lang === "python"
					? "import sys; print(runtime_marker + int(sys.stdin.read()))"
					: 'let input = ""; for await (const chunk of process.stdin) input += chunk; console.log(runtime_marker + Number(input))';
			const result = await bash.execute("input", { command: `printf 1 | ${lang} ${flag} '${source}'` });
			expect(text(result)).toContain("42");
			expect(result.isError).not.toBe(true);
		});
	}, 30_000);
}

test("overlapping shell calls queue without losing exported state", async () => {
	await fixture(async (_bash, cwd, owner) => {
		await executeBash("export RUNTIME_STATE=kept", { cwd, sessionKey: owner });
		const busy = executeBash("sleep 0.1; export RUNTIME_STATE=updated", { cwd, sessionKey: owner });
		const next = executeBash('printf "%s" "$RUNTIME_STATE"', { cwd, sessionKey: owner });
		await busy;
		expect((await next).output).toBe("updated");
	});
});

test("named lanes isolate shell and kernel state", async () => {
	await fixture(async bash => {
		await bash.execute("seed", { lane: "one", command: "export LANE_MARKER=one; python -c 'lane_marker = 42'" });
		const other = await bash.execute("other", {
			lane: "two",
			command: `printf 'shell=%s\\n' "$LANE_MARKER"; python -c 'print("kernel", "lane_marker" in globals())'`,
		});
		expect(text(other)).toContain("kernel False");
		expect(text(other)).not.toContain("shell=one");
		const original = await bash.execute("original", {
			lane: "one",
			command: `printf 'shell=%s\\n' "$LANE_MARKER"; python -c 'print(lane_marker)'`,
		});
		expect(text(original)).toContain("shell=one");
		expect(text(original)).toContain("42");
	});
}, 30_000);

test("explicit main shares default shell and kernel state", async () => {
	await fixture(async bash => {
		await bash.execute("default", { command: "export MAIN_MARKER=shared; python -c 'main_marker = 73'" });
		const result = await bash.execute("main", {
			lane: "main",
			command: `printf '%s\n' "$MAIN_MARKER"; python -c 'print(main_marker)'`,
		});
		expect(text(result)).toContain("shared\n73");
	});
});

test("stage records retain an earlier failed pipeline member and split diagnostic streams", async () => {
	await fixture(async (bash, cwd) => {
		const command = `set +o pipefail; sh -c 'printf payload; printf diagnostic >&2; exit 7' | cat`;
		const result = await bash.execute("pipeline", { command });
		expect(result.isError).not.toBe(true);
		const producer = result.details?.execution?.stages?.find(stage => stage.route === "external");
		expect(producer?.exitCode).toBe(7);
		expect(producer?.stdout).toMatchObject({ text: "payload", bytes: 7, complete: true, truncated: false });
		expect(producer?.stderr).toMatchObject({ text: "diagnostic", bytes: 10, complete: true, truncated: false });
		expect(producer?.sourceSpan && command.slice(...producer.sourceSpan)).toContain("exit 7");
		expect(await Bun.file(path.join(cwd, "artifacts", producer!.stderr!.artifactId!)).text()).toBe("diagnostic");
		expect(result.details?.execution?.stages?.at(-1)?.exitCode).toBe(0);
		const query = await bash.execute("query", {
			command: `python -c 'print(executions("pipeline")["records"][0]["result"]["details"]["execution"]["stages"][1]["exitCode"])'`,
		});
		expect(text(query)).toMatch(/^7\n/);
		const history = await bash.execute("history", {
			command: `python -c 'print(executions("query")["records"][0]["resultOmitted"])'`,
		});
		expect(text(history)).toContain("executions query");
	});
}, 30_000);

test("native stage signal is distinct from an explicit signal-shaped exit code", async () => {
	await fixture(async bash => {
		const result = await bash.execute("signals", {
			command: `set +o pipefail; sh -c 'kill -TERM $$' | cat; sh -c 'exit 143' | cat`,
		});
		const stages = result.details?.execution?.stages?.filter(stage => stage.route === "external") ?? [];
		expect(stages.map(stage => stage.exitCode)).toEqual([143, 143]);
		expect(stages[0]?.signal).toBe(15);
		expect(stages[1]?.signal ?? undefined).toBeUndefined();
	});
});

test("tracing bounds retained stages without dropping command output", async () => {
	await fixture(async bash => {
		const result = await bash.execute("bounded", { command: "for ((i=0; i<140; i++)); do printf x; done" });
		expect(text(result)).toContain("x".repeat(140));
		expect(result.details?.execution?.stages).toHaveLength(128);
		expect(result.details?.execution?.stages?.at(-1)?.omittedAfter).toBeGreaterThan(0);
	});
});

test("stage output previews preserve UTF-8 while reporting omitted bytes", async () => {
	await fixture(async bash => {
		const result = await bash.execute("large", { command: `python -c 'print("😀" * 10000)'` });
		const stage = result.details?.execution?.stages?.[0];
		expect(stage?.stdout?.bytes).toBe(40001);
		expect(stage?.stdout?.truncated).toBe(true);
		expect(stage?.stdout?.text).toBe("😀".repeat(4096));
	});
});

test("exiting a lane's shell reports the lost state once on that lane's next call", async () => {
	await fixture(async bash => {
		await bash.execute("seed", { lane: "exit", command: "export EXIT_MARKER=kept; greet() { :; }" });
		const exited = await bash.execute("exit", { lane: "exit", command: "exit 7" });
		expect(exited.details?.execution?.exitCode).toBe(7);
		expect(text(exited)).not.toContain("state lost");

		const next = await bash.execute("next", {
			lane: "exit",
			command: '[ -z "$EXIT_MARKER" ] && echo marker-unset; type greet >/dev/null 2>&1 || echo no-function',
		});
		expect(text(next)).toContain("<shell> state lost: lane exit shell exited with code 7");
		expect(text(next)).toContain("marker-unset");
		expect(text(next)).toContain("no-function");

		const after = await bash.execute("after", { lane: "exit", command: "export EXIT_MARKER=again" });
		expect(text(after)).not.toContain("state lost");
	});
});

test("same-lane shell and kernel calls run in issue order when an earlier call prepares slower", async () => {
	await fixture(async (bash, cwd, _owner, session) => {
		const slowCwd = path.join(cwd, "slow");
		await fs.mkdir(slowCwd);
		const order = path.join(cwd, "order.txt");
		const doneAt = path.join(cwd, "shell-a-done");
		// Each lane's first call finishes preparing (cwd validation) only after
		// both later calls have prepared.
		const laterPrepared = Promise.withResolvers<void>();
		let laterStats = 0;
		const stat = nodeFs.promises.stat;
		spyOn(nodeFs.promises, "stat").mockImplementation((async (
			target: nodeFs.PathLike,
			options?: nodeFs.StatOptions,
		) => {
			if (target === slowCwd) await laterPrepared.promise;
			else if (target === cwd && ++laterStats === 2) laterPrepared.resolve();
			return stat(target, options);
		}) as typeof nodeFs.promises.stat);
		await Promise.all([
			bash.execute("shell-a", {
				lane: "fifo",
				cwd: slowCwd,
				command: `printf 'shell-a ' >> ${order}; date +%s%N > ${doneAt}`,
			}),
			bash.execute("shell-b", { lane: "fifo", command: `printf 'shell-b ' >> ${order}` }),
			bash.execute("py-a", {
				lane: "fifo-py",
				cwd: slowCwd,
				command: `python -c 'open("${order}", "a").write("py-a ")'`,
			}),
			bash.execute("py-b", { lane: "fifo-py", command: `python -c 'open("${order}", "a").write("py-b ")'` }),
		]);
		const written = (await Bun.file(order).text()).trim().split(" ");
		expect(written.filter(entry => entry.startsWith("shell"))).toEqual(["shell-a", "shell-b"]);
		expect(written.filter(entry => entry.startsWith("py"))).toEqual(["py-a", "py-b"]);

		const history = await runEvalRuntime({ op: "executions", limit: 4 }, { session });
		if (!("records" in history)) throw new Error("Expected execution history");
		const shellB = history.records.find(record => record.id === "shell-b")!;
		// A queued call reports when it actually started, not when it was issued.
		const shellADone = Number(BigInt((await Bun.file(doneAt).text()).trim()) / 1_000_000n);
		expect(shellB.queuedAt).toBeLessThan(shellADone);
		expect(shellB.startedAt).toBeGreaterThanOrEqual(shellADone);
	});
}, 30_000);

test("a background kernel cell force-closed mid-run fails with the close as its error and keeps its output", async () => {
	await fixture(async (_bash, _cwd, _owner, session) => {
		const manager = new AsyncJobManager({});
		const managedSession = {
			...session,
			asyncJobManager: manager,
			settings: {
				get: (key: string) => (key === "async.enabled" ? true : undefined),
				getShellConfig: () => ({ env: {} }),
			},
		} as unknown as ToolSession;
		try {
			const running = Promise.withResolvers<void>();
			const started = await manager.withJobObserver(
				observation => {
					if (observation.kind === "progress" && observation.text.includes("long cell start")) running.resolve();
				},
				() =>
					new BashTool(managedSession).execute("hung-cell", {
						async: true,
						lane: "kx",
						command: `python -c 'print("long cell start", flush=True)\nimport threading\nthreading.Event().wait()'`,
					}),
			);
			await running.promise;
			await handleKernelControl(managedSession, { op: "close", language: "python", lane: "kx", force: true });
			await manager.waitForAll();
			const job = manager.getJob(started.details!.async!.jobId)!;
			expect(job.status).toBe("failed");
			expect(job.errorText).toBe("kernel py:kx was force-closed; cell cancelled");
			expect(job.resultText).toContain("long cell start");
			expect(job.resultText).toContain("Command exited with code 130");
		} finally {
			await manager.dispose();
		}
	});
}, 30_000);

test("a cancelled lane waiter never executes or resets the active shell", async () => {
	await fixture(async (_bash, cwd, owner) => {
		const busy = executeBash("sleep 0.05; export QUEUE_MARKER=kept", { cwd, sessionKey: owner });
		const cancel = new AbortController();
		const waiting = executeBash("export QUEUE_MARKER=lost", { cwd, sessionKey: owner, signal: cancel.signal });
		cancel.abort();
		expect((await waiting).cancelled).toBe(true);
		await busy;
		expect((await executeBash('printf %s "$QUEUE_MARKER"', { cwd, sessionKey: owner })).output).toBe("kept");
	});
});

test("a shell deadline retains completed stages before an interrupted command", async () => {
	await fixture(async bash => {
		const result = await bash.execute("deadline", { command: "printf completed; sleep 10", timeout: 1 });
		expect(result.details?.timedOut).toBe(true);
		expect(result.details?.execution?.stages?.[0]).toMatchObject({ exitCode: 0, stdout: { text: "completed" } });
		expect(result.details?.execution?.stages?.[1]?.state).not.toBe("running");
	});
}, 10_000);

test("managed jobs isolate default state but honor explicit lanes and retain failed stages", async () => {
	await fixture(async (bash, _cwd, _owner, session) => {
		const manager = new AsyncJobManager({});
		const managedSession = {
			...session,
			asyncJobManager: manager,
			settings: {
				get: (key: string) => (key === "async.enabled" ? true : undefined),
				getShellConfig: () => ({ env: {} }),
			},
		} as unknown as ToolSession;
		const managed = new BashTool(managedSession);
		try {
			await bash.execute("seed-main", { command: "export BG_MARKER=main; python -c 'background_marker = 39'" });
			await bash.execute("seed-lane", {
				lane: "work",
				command: "export BG_MARKER=work; python -c 'background_marker = 41'",
			});
			const isolated = await managed.execute("background-default", {
				async: true,
				command: `printf 'shell=%s\n' "$BG_MARKER"; python -c 'print("known", "background_marker" in globals())'`,
			});
			const shared = await managed.execute("background-work", {
				async: true,
				lane: "work",
				command: `printf 'shell=%s\n' "$BG_MARKER"; python -c 'print(background_marker + 1)'; false`,
			});
			await manager.waitForAll();
			const isolatedJob = manager.getJob(isolated.details!.async!.jobId)!;
			const sharedJob = manager.getJob(shared.details!.async!.jobId)!;
			expect(isolatedJob.resultText).toContain("known False");
			expect(isolatedJob.resultText).not.toContain("shell=main");
			expect(sharedJob.status).toBe("failed");
			const history = await runEvalRuntime({ op: "executions", id: sharedJob.id }, { session: managedSession });
			if (!("records" in history)) throw new Error("Expected execution history");
			expect(history.records[0]?.result?.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("shell=work\n42") }),
				]),
			);
			expect(history.records[0]?.result?.details).toMatchObject({
				execution: { exitCode: 1, stages: expect.arrayContaining([expect.objectContaining({ exitCode: 1 })]) },
			});
		} finally {
			await manager.dispose();
		}
	});
}, 30_000);

for (const lang of ["python", "node"] as const) {
	test(`${lang} inline cells consume redirected file input without losing state`, async () => {
		await fixture(async bash => {
			const flag = lang === "python" ? "-c" : "-e";
			await bash.execute("redirect-seed", {
				command: `${lang} ${flag} '${lang === "python" ? "redirect_marker = 98" : "globalThis.redirect_marker = 98"}'`,
			});
			const source =
				lang === "python"
					? "import sys; print(redirect_marker + int(sys.stdin.read()))"
					: 'let body = ""; for await (const chunk of process.stdin) body += chunk; console.log(redirect_marker + Number(body))';
			const result = await bash.execute("redirect-input", {
				command: `printf 11 > program-input.txt; ${lang} ${flag} '${source}' < program-input.txt`,
			});
			expect(result.isError).not.toBe(true);
			expect(text(result)).toMatch(/^109\n/);
		});
	});
}
