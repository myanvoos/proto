#!/usr/bin/env bun
/**
 * Shutdown latency harness (end-to-end, real process under tmux):
 * - exit-cmd: type /exit at the prompt, measure until process exit
 * - sigterm: SIGTERM the cli pid, measure until process exit
 * Uses an isolated HOME seeded with settings.json {"setupVersion":1} so the
 * setup wizard never runs and user state is never touched.
 * Usage: bun bench/perf-gate/shutdown-latency.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envInt, mean, median, PKG_ROOT, writeResults } from "./lib";

const RUNS = envInt("RUNS", 5);
const READY_TIMEOUT_MS = 45_000;

async function $cmd(cmd: string[], opts?: { quiet?: boolean }): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	const errText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const code = await proc.exited;
	if (code !== 0 && !opts?.quiet) console.error(`  [cmd failed: ${cmd.join(" ")}] ${errText.trim().slice(0, 300)}`);
	return { code, out };
}

async function makeTempHome(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pg-home-"));
	const agentDir = path.join(dir, "agent");
	await fs.promises.mkdir(agentDir, { recursive: true });
	// Copy the real provider config so no setup wizard runs; everything else
	// (sessions, history, logs) is created fresh inside the isolated dir.
	try {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			await Bun.file(path.join(os.homedir(), ".proto", "agent", "config.yml")).text(),
		);
	} catch {
		// No user config: seed minimal one so the wizard is skipped.
		await Bun.write(path.join(agentDir, "config.yml"), "theme: dark\n");
	}
	await Bun.write(path.join(agentDir, "settings.json"), JSON.stringify({ setupVersion: 1 }));
	return dir;
}

async function launch(session: string, home: string): Promise<void> {
	const agentDir = `${home}/agent`;
	await $cmd(["tmux", "kill-session", "-t", session], { quiet: true });
	// Two-level shell: the inner `sh -c` execs bun (pid captured), the outer
	// shell survives to signal the waiter channel once the pane's process exits.
	const paneCmd =
		`cd ${PKG_ROOT} && HOME=${home} PI_CODING_AGENT_DIR=${agentDir} PI_STRICT_EDIT_MODE=1 ` +
		`sh -c 'echo $$ > ${home}/pid; exec bun src/cli.ts'; tmux wait-for -S ${session}`;
	const { code } = await $cmd(["tmux", "new-session", "-d", "-x", "120", "-y", "40", "-s", session, paneCmd]);
	if (code !== 0) throw new Error(`tmux new-session failed for ${session}`);
}

const READY_MARKER = "ask anything \u00b7 / for commands";

async function waitReady(session: string): Promise<boolean> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const { code, out } = await $cmd(["tmux", "capture-pane", "-p", "-t", session], { quiet: true });
		if (code === 0 && out.includes(READY_MARKER)) {
			await Bun.sleep(1500); // settle: let input handling fully initialize
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

async function paneAlive(session: string): Promise<boolean> {
	const { code } = await $cmd(["tmux", "has-session", "-t", session], { quiet: true });
	return code === 0;
}

async function timedShutdown(session: string, variant: "exit-cmd" | "sigterm", home: string): Promise<number> {
	const waiter = Bun.spawn(["tmux", "wait-for", session], { stdout: "ignore", stderr: "ignore" });
	const waiterExitTime = waiter.exited.then(() => Bun.nanoseconds());
	await Bun.sleep(30);
	const t0 = Bun.nanoseconds();
	if (variant === "exit-cmd") {
		await $cmd(["tmux", "send-keys", "-t", session, "/exit", "Enter"]);
	} else {
		const pid = Number((await fs.promises.readFile(path.join(home, "pid"), "utf8")).trim());
		process.kill(pid, "SIGTERM");
	}
	// Keys can be dropped if they land while the TUI is still initializing.
	// Retry the trigger; elapsed is measured from the ACCEPTED trigger (the
	// one after which the pane dies), not from dropped attempts.
	let attemptT0 = t0;
	for (let attempt = 0; attempt < 6; attempt++) {
		if (attempt > 0 && !(await paneAlive(session))) break;
		attemptT0 = Bun.nanoseconds();
		if (variant === "exit-cmd") {
			await $cmd(["tmux", "send-keys", "-t", session, "/exit", "Enter"]);
		} else {
			const pid = Number((await fs.promises.readFile(path.join(home, "pid"), "utf8")).trim());
			process.kill(pid, "SIGTERM");
		}
		const deadline = Date.now() + 8_000;
		let died = false;
		while (Date.now() < deadline) {
			if (!(await paneAlive(session))) {
				died = true;
				break;
			}
			// Poll only to decide whether a dropped trigger should be retried;
			// the event-driven waiter below supplies the measured endpoint.
			await Bun.sleep(10);
		}
		if (died) {
			const timeout = Bun.sleep(60_000).then(() => undefined);
			const outcome = await Promise.race([waiterExitTime, timeout]);
			if (outcome === undefined) {
				waiter.kill();
				throw new Error(`waiter for ${session} timed out after SIG`);
			}
			return (Number(outcome) - Number(attemptT0)) / 1e6;
		}
	}
	waiter.kill();
	throw new Error(`session ${session} still alive after 6 shutdown attempts`);
}

async function cleanup(session: string, home: string): Promise<void> {
	await $cmd(["tmux", "kill-session", "-t", session], { quiet: true });
	await fs.promises.rm(home, { recursive: true, force: true });
}

async function runVariant(
	variant: "exit-cmd" | "sigterm",
): Promise<{ runs: number[]; median: number; mean: number; failures: number }> {
	const runs: number[] = [];
	let failures = 0;
	for (let i = 0; i < RUNS; i++) {
		const session = `pg_${variant}_${Date.now()}_${i}`;
		const home = await makeTempHome();
		try {
			await launch(session, home);
			const ready = await waitReady(session);
			if (!ready) throw new Error(`session ${session} never became ready`);
			runs.push(await timedShutdown(session, variant, home));
			process.stdout.write(`  ${variant} run ${i + 1}/${RUNS}: ${runs[runs.length - 1]!.toFixed(0)}ms\n`);
		} catch (err) {
			failures++;
			console.error(`  ${variant} run ${i + 1}/${RUNS} FAILED: ${err instanceof Error ? err.message : err}`);
		} finally {
			await cleanup(session, home);
		}
	}
	return { runs, median: median(runs), mean: mean(runs), failures };
}

const exitRes = await runVariant("exit-cmd");
const termRes = await runVariant("sigterm");
const result = {
	ts: new Date().toISOString(),
	runs: RUNS,
	"exit-cmd": exitRes,
	sigterm: termRes,
};
const file = writeResults("shutdown.json", result);
console.log(
	`shutdown: /exit median ${exitRes.median.toFixed(0)}ms (failures ${exitRes.failures})  SIGTERM median ${termRes.median.toFixed(0)}ms (failures ${termRes.failures})  -> ${file}`,
);
if (exitRes.failures > 0 || termRes.failures > 0) process.exit(1);
process.exit(0);
