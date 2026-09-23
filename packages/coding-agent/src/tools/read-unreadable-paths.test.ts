import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Two honesty defects: an unreadable directory was reported as "(empty directory)" with rc=0, and a
// read of a FIFO never returned. Every case drives the real CLI; the system-prompt case drives a
// real session against a local fake provider and inspects what the model was actually told.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");
const RUN_TIMEOUT_MS = 20_000;

const requestBodies: string[] = [];
/** When set, the fake provider opens the turn with a read tool call for this path. */
let readToolCallPath: string | undefined;
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async request => {
		const body = await request.text();
		requestBodies.push(body);
		const answered = body.includes('"role":"tool"');
		const frames =
			readToolCallPath && !answered
				? [
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_read_1",
												type: "function",
												function: { name: "read", arguments: JSON.stringify({ path: readToolCallPath }) },
											},
										],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					]
				: [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
		return new Response(`${frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-w9-fs-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const work = path.join(root, "work");
const lockedDir = path.join(work, "locked");
const emptyDir = path.join(work, "empty");
const execOnlyDir = path.join(root, "exec-only");
const fifoPath = path.join(work, "pipe.fifo");
const socketPath = path.join(work, "listener.sock");

beforeAll(async () => {
	for (const dir of [home, agentDir, work, lockedDir, emptyDir, execOnlyDir]) await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(lockedDir, "important.txt"), "IMPORTANT\n");
	await fs.writeFile(path.join(execOnlyDir, "secret.txt"), "SECRET\n");
	await fs.writeFile(path.join(work, "plain.txt"), "PLAIN\n");
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		[
			"includeWorkspaceTree: true",
			"retry:",
			"  maxRetries: 0",
			"  baseDelayMs: 10",
			"  maxDelayMs: 20",
			"  modelFallback: false",
			"",
		].join("\n"),
	);
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  w9fake:",
			`    baseUrl: http://127.0.0.1:${provider.port}/v1`,
			"    apiKey: test-key",
			"    api: openai-completions",
			"    models:",
			"      - id: w9-model",
			'        name: "w9"',
			"        contextWindow: 16384",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);
	expect((await Bun.$`mkfifo ${fifoPath}`.nothrow()).exitCode).toBe(0);
	const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });
	listener.stop(true);
	await Bun.$`python3 -c ${"import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])"} ${socketPath}`.nothrow();
	// Least permissive last: the fixtures above must be written while the directories still allow it.
	await fs.chmod(lockedDir, 0o000);
	await fs.chmod(execOnlyDir, 0o111);
});

afterAll(async () => {
	provider.stop(true);
	await fs.chmod(lockedDir, 0o755).catch(() => {});
	await fs.chmod(execOnlyDir, 0o755).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

async function runCli(args: string[], cwd = work): Promise<RunResult> {
	const started = Date.now();
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, ...args],
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...(process.env as Record<string, string>),
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
	const exitCode = await Promise.race([child.exited, Bun.sleep(RUN_TIMEOUT_MS).then(() => "timeout" as const)]);
	if (exitCode === "timeout") {
		child.kill("SIGKILL");
		await child.exited;
		throw new Error(`proto ${args.join(" ")} did not return within ${RUN_TIMEOUT_MS}ms`);
	}
	return { exitCode, stdout: await stdout, stderr: await stderr, elapsedMs: Date.now() - started };
}

test("an unreadable directory is reported as unreadable, not as empty", async () => {
	const locked = await runCli(["read", "locked"]);
	expect(locked.exitCode).toBe(1);
	expect(locked.stderr).toContain("Cannot read directory");
	expect(locked.stderr).toContain("EACCES");
	expect(locked.stdout).not.toContain("(empty directory)");
}, 60_000);

test("a genuinely empty directory is still reported as empty", async () => {
	const empty = await runCli(["read", "empty"]);
	expect(empty.exitCode).toBe(0);
	expect(empty.stdout).toContain("(empty directory)");

	const populated = await runCli(["read", "."]);
	expect(populated.exitCode).toBe(0);
	expect(populated.stdout).toContain("plain.txt");
}, 60_000);

test("reading a FIFO fails fast instead of hanging forever", async () => {
	const fifo = await runCli(["read", "pipe.fifo"]);
	expect(fifo.exitCode).toBe(1);
	expect(fifo.stderr).toContain("named pipe (FIFO)");
	expect(fifo.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS);

	const socket = await runCli(["read", "listener.sock"]);
	expect(socket.exitCode).toBe(1);
	expect(socket.stderr).toContain("socket");
}, 60_000);

test("a session that reads a FIFO finishes its turn with a tool error", async () => {
	requestBodies.length = 0;
	readToolCallPath = fifoPath;
	try {
		const session = await runCli([
			"-p",
			"read the pipe",
			"--model",
			"w9fake/w9-model",
			"--tools",
			"read",
			"--no-session",
			"--no-extensions",
		]);
		expect(session.exitCode).toBe(0);
		const toolResults = requestBodies.filter(body => body.includes('"role":"tool"'));
		expect(toolResults.length).toBeGreaterThan(0);
		expect(toolResults.some(body => body.includes("named pipe (FIFO)"))).toBe(true);
	} finally {
		readToolCallPath = undefined;
	}
}, 120_000);

test("character devices and regular files keep their existing behaviour", async () => {
	const devNull = await runCli(["read", "/dev/null"]);
	expect(devNull.exitCode).toBe(0);

	const devZero = await runCli(["read", "/dev/zero"]);
	expect(devZero.exitCode).toBe(0);
	expect(devZero.stdout).toContain("binary file");

	const plain = await runCli(["read", "plain.txt"]);
	expect(plain.exitCode).toBe(0);
	expect(plain.stdout).toContain("PLAIN");
}, 60_000);

test("a workspace scan that fails tells the model so instead of showing an empty project", async () => {
	requestBodies.length = 0;
	const session = await runCli(
		["-p", "hello", "--model", "w9fake/w9-model", "--no-session", "--no-extensions"],
		execOnlyDir,
	);
	expect(session.exitCode).toBe(0);
	const systemPrompts = requestBodies.filter(body => body.includes("workspace-tree"));
	expect(systemPrompts.length).toBeGreaterThan(0);
	expect(systemPrompts.some(body => body.includes("listing unavailable"))).toBe(true);

	requestBodies.length = 0;
	const control = await runCli(["-p", "hello", "--model", "w9fake/w9-model", "--no-session", "--no-extensions"]);
	expect(control.exitCode).toBe(0);
	const controlPrompts = requestBodies.filter(body => body.includes("workspace-tree"));
	expect(controlPrompts.length).toBeGreaterThan(0);
	expect(controlPrompts.some(body => body.includes("listing unavailable"))).toBe(false);
	expect(controlPrompts.some(body => body.includes("plain.txt"))).toBe(true);
}, 120_000);
