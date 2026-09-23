import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Concurrent print-mode runs on one session used to exit 0 each, print a reply and
// silently drop all but one turn, so every case here spawns real CLI processes
// against a local SSE provider. No real provider is contacted.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");
const REPLY = "W7-OK";

const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => {
		const frames = [
			{ choices: [{ delta: { role: "assistant", content: REPLY } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		];
		const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	},
});

const slowProvider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async () => {
		await Bun.sleep(60_000);
		return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-w7-ownership-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  okp:",
		`    baseUrl: http://127.0.0.1:${provider.port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		"      - id: mok",
		'        name: "mok"',
		"        contextWindow: 16384",
		"        maxTokens: 1024",
		"  slowp:",
		`    baseUrl: http://127.0.0.1:${slowProvider.port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		"      - id: mslow",
		'        name: "mslow"',
		"        contextWindow: 16384",
		"        maxTokens: 1024",
		"",
	].join("\n"),
);

afterAll(async () => {
	provider.stop(true);
	slowProvider.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], timeoutMs = 60_000): Promise<RunResult> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, "--cwd", cwd, "--model", "okp/mok", "--no-extensions", ...args],
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			PI_CODING_AGENT_DIR: agentDir,
			TERM: "dumb",
			NO_COLOR: "1",
		},
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => -1)]);
	if (exitCode === -1) {
		child.kill("SIGKILL");
		await child.exited;
		throw new Error(`proto ${args.join(" ")} did not exit within ${timeoutMs}ms`);
	}
	return { exitCode, stdout: await stdout, stderr: await stderr };
}

async function sessionFiles(): Promise<string[]> {
	const sessionsRoot = path.join(agentDir, "sessions");
	const projects = await fs.readdir(sessionsRoot);
	const files: string[] = [];
	for (const project of projects) {
		const dir = path.join(sessionsRoot, project);
		for (const entry of await fs.readdir(dir)) {
			if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
		}
	}
	return files;
}

async function allSessionText(): Promise<string> {
	const files = await sessionFiles();
	const contents = await Promise.all(files.map(file => Bun.file(file).text()));
	return contents.join("\n");
}

const seeded = await runCli(["-p", "seed"]);
expect(seeded.exitCode).toBe(0);
expect(seeded.stdout).toContain(REPLY);
const seededFile = (await sessionFiles())[0];
if (!seededFile) throw new Error("seed run did not create a session file");

test("concurrent print resumes of one session never lose a turn", async () => {
	const runs = await Promise.all([0, 1, 2].map(i => runCli(["-r", seededFile, "-p", `CONCUR${i}`])));

	const winners = runs.filter(run => run.exitCode === 0);
	const refused = runs.filter(run => run.exitCode !== 0);
	expect(winners).toHaveLength(1);
	expect(refused).toHaveLength(2);

	const text = await Bun.file(seededFile).text();
	const persisted = [0, 1, 2].filter(i => text.includes(`CONCUR${i}`));
	expect(persisted).toHaveLength(1);

	for (const run of refused) {
		// A refused run must say so and must not look like it answered.
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("currently using this session");
		expect(run.stderr).toContain("--fork");
		expect(run.stdout).not.toContain(REPLY);
	}
	expect(winners[0]?.stdout).toContain(REPLY);
}, 120_000);

test("the session is resumable again once the owning run exits", async () => {
	const after = await runCli(["-r", seededFile, "-p", "AFTERWARDS"]);

	expect(after.exitCode).toBe(0);
	expect(after.stdout).toContain(REPLY);
	expect(await Bun.file(seededFile).text()).toContain("AFTERWARDS");
}, 60_000);

test("sequential print resumes persist every turn", async () => {
	for (const label of ["SEQ0", "SEQ1", "SEQ2"]) {
		const run = await runCli(["-r", seededFile, "-p", label]);
		expect(run.exitCode).toBe(0);
	}

	const text = await Bun.file(seededFile).text();
	for (const label of ["SEQ0", "SEQ1", "SEQ2"]) expect(text).toContain(label);
}, 120_000);

test("concurrent --continue runs keep every turn instead of overwriting one session", async () => {
	const runs = await Promise.all([0, 1, 2].map(i => runCli(["--continue", "-p", `CONT${i}`])));

	for (const run of runs) expect(run.exitCode).toBe(0);

	const text = await allSessionText();
	for (const i of [0, 1, 2]) expect(text).toContain(`CONT${i}`);
	// The turns must fan out into separate sessions rather than overwrite one file.
	const files = await sessionFiles();
	const contents = await Promise.all(files.map(file => Bun.file(file).text()));
	const filesWithContTurns = contents.filter(content => /CONT[012]/.test(content));
	expect(filesWithContTurns.length).toBeGreaterThan(1);
}, 120_000);

test("a killed owner does not keep the session locked", async () => {
	const holder = Bun.spawn({
		cmd: [
			process.execPath,
			cliEntry,
			"--cwd",
			cwd,
			"--model",
			"slowp/mslow",
			"--no-extensions",
			"-r",
			seededFile,
			"-p",
			"HOLDER",
		],
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			PI_CODING_AGENT_DIR: agentDir,
			TERM: "dumb",
			NO_COLOR: "1",
		},
	});
	try {
		// Wait until the holder actually owns the session: the claim publishes the
		// marker, so its pid appearing there is the handshake.
		let owned = false;
		for (let attempt = 0; attempt < 100 && !owned; attempt++) {
			const marker = Bun.file(`${seededFile}.live`);
			owned = (await marker.exists()) && (await marker.text()).includes(`"pid":${holder.pid}`);
			if (!owned) await Bun.sleep(100);
		}
		expect(owned).toBe(true);

		const probe = await runCli(["-r", seededFile, "-p", "PROBE"]);
		expect(probe.exitCode).toBe(1);
		expect(probe.stderr).toContain("currently using this session");
		expect(probe.stderr).toContain(`pid ${holder.pid}`);
		expect(await Bun.file(seededFile).text()).not.toContain("PROBE");
	} finally {
		holder.kill("SIGKILL");
		await holder.exited;
	}

	const after = await runCli(["-r", seededFile, "-p", "AFTERKILL"]);
	expect(after.exitCode).toBe(0);
	expect(await Bun.file(seededFile).text()).toContain("AFTERKILL");
}, 180_000);
