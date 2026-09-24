import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposeRunnerCache, RUNNER_CACHE_MAX_ENTRIES, stageRunnerScript } from "./runner-cache";

const cleanupPaths = new Set<string>();

afterEach(async () => {
	await disposeRunnerCache();
	await Promise.all([...cleanupPaths].map(target => fs.promises.rm(target, { recursive: true, force: true })));
	cleanupPaths.clear();
});

test("stages a runner in a private directory without following a predictable symlink", async () => {
	const dirName = `proto-runner-symlink-${crypto.randomUUID()}`;
	const script = "print('secure runner')\n";
	const attackerDir = path.join(os.tmpdir(), dirName);
	const victimDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-runner-victim-"));
	cleanupPaths.add(attackerDir);
	cleanupPaths.add(victimDir);
	const victim = path.join(victimDir, "victim.py");
	await Bun.write(victim, "sentinel\n");
	await fs.promises.mkdir(attackerDir, { mode: 0o777 });
	const predictableTarget = path.join(attackerDir, `runner-${Bun.hash(script).toString(36)}.py`);
	await fs.promises.symlink(victim, predictableTarget);

	const staged = await stageRunnerScript(dirName, "py", script);
	cleanupPaths.add(path.dirname(staged));

	expect(await Bun.file(victim).text()).toBe("sentinel\n");
	expect(staged).not.toBe(predictableTarget);
	const [directoryStat, stagedStat] = await Promise.all([
		fs.promises.lstat(path.dirname(staged)),
		fs.promises.lstat(staged),
	]);
	expect(directoryStat.isDirectory()).toBe(true);
	expect(directoryStat.mode & 0o777).toBe(0o700);
	expect(stagedStat.isFile()).toBe(true);
	expect(stagedStat.isSymbolicLink()).toBe(false);
	expect(stagedStat.mode & 0o777).toBe(0o600);
	expect(await Bun.file(staged).text()).toBe(script);
});

test("reuses a verified staged runner for identical content", async () => {
	const dirName = `proto-runner-cache-${crypto.randomUUID()}`;
	const script = "console.log('cached')\n";
	const first = await stageRunnerScript(dirName, "js", script);
	cleanupPaths.add(path.dirname(first));
	const second = await stageRunnerScript(dirName, "js", script);

	expect(second).toBe(first);
	expect(await Bun.file(second).text()).toBe(script);
});

test("disposes all successful staging entries instead of leaving private temp directories behind", async () => {
	const dirName = `proto-runner-dispose-${crypto.randomUUID()}`;
	const first = await stageRunnerScript(dirName, "py", "print('first')\n");
	const second = await stageRunnerScript(`${dirName}-second`, "py", "print('second')\n");
	const firstDir = path.dirname(first);
	const secondDir = path.dirname(second);

	await disposeRunnerCache();

	expect(await fs.promises.lstat(firstDir).catch(() => null)).toBeNull();
	expect(await fs.promises.lstat(secondDir).catch(() => null)).toBeNull();
});

test("evicts the oldest staged runner when the bounded cache reaches its limit", async () => {
	const dirName = `proto-runner-eviction-${crypto.randomUUID()}`;
	const staged: string[] = [];
	for (let index = 0; index <= RUNNER_CACHE_MAX_ENTRIES; index += 1) {
		staged.push(await stageRunnerScript(dirName, "py", `print(${index})\n`));
	}

	expect(await fs.promises.lstat(path.dirname(staged[0]!)).catch(() => null)).toBeNull();
	expect(await Bun.file(staged.at(-1)!).exists()).toBe(true);
});

test("removes staged runners from the process exit hook", async () => {
	const modulePath = path.resolve(import.meta.dir, "runner-cache.ts");
	const source = [
		`import { stageRunnerScript } from ${JSON.stringify(modulePath)};`,
		`const target = await stageRunnerScript("proto-runner-exit-${crypto.randomUUID()}", "py", "print('exit')\\n");`,
		"process.stdout.write(JSON.stringify(target));",
		"process.exit(0);",
	].join("\n");
	const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	expect(exitCode, stderr).toBe(0);
	const target = JSON.parse(stdout) as string;
	expect(await fs.promises.lstat(path.dirname(target)).catch(() => null)).toBeNull();
});
