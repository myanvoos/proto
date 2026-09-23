import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchHelp } from "../commands/launch-help";
import { OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS, VALUELESS_FLAGS } from "./flag-tables";

// Every case drives the real CLI; model traffic goes to a local fault-injection server so a run
// that must reach the provider fails immediately instead of retrying against the network.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const errorServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () =>
		new Response(JSON.stringify({ error: { message: "Invalid API key provided", code: "invalid_api_key" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		}),
});

const okServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => {
		const frames = [
			{ choices: [{ delta: { content: "W7 ANSWER" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		];
		const body = frames
			.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
			.join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-w7-flags-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const work = path.join(root, "work");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(work, { recursive: true });

function portOf(server: { port?: number | null }): number {
	const port = server.port;
	if (typeof port !== "number") throw new Error("fault-injection server did not bind a port");
	return port;
}

function providerBlock(name: string, port: number): string {
	return [
		`  ${name}:`,
		`    baseUrl: http://127.0.0.1:${port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		`      - id: ${name}-model`,
		`        name: "${name}"`,
		"        contextWindow: 16384",
		"        maxTokens: 1024",
	].join("\n");
}

await fs.writeFile(
	path.join(agentDir, "config.yml"),
	["retry:", "  maxRetries: 0", "  baseDelayMs: 10", "  maxDelayMs: 20", "  modelFallback: false", ""].join("\n"),
);
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	`providers:\n${[providerBlock("w7fault", portOf(errorServer)), providerBlock("w7ok", portOf(okServer))].join("\n")}\n`,
);

afterAll(async () => {
	errorServer.stop(true);
	okServer.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutBytes: Uint8Array;
}

async function runCli(
	args: string[],
	options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, ...args],
		cwd: options.cwd ?? work,
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
			...options.env,
		},
	});
	const stdoutBytes = new Response(child.stdout).bytes();
	const stderr = new Response(child.stderr).text();
	const timeoutMs = options.timeoutMs ?? 60_000;
	const exitCode = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => -1)]);
	if (exitCode === -1) {
		child.kill("SIGKILL");
		await child.exited;
		throw new Error(`proto ${args.join(" ")} did not exit within ${timeoutMs}ms`);
	}
	const bytes = await stdoutBytes;
	return { exitCode, stdout: new TextDecoder().decode(bytes), stdoutBytes: bytes, stderr: await stderr };
}

test("model completion offers configured models, not just the bundled catalog", async () => {
	const configured = await runCli(["__complete", "models", "--", "w7ok-model"]);
	expect(configured.exitCode).toBe(0);
	expect(configured.stdout).toContain("w7ok/w7ok-model");

	// The bundled catalog still completes; the registry is a superset, not a replacement.
	const bundled = await runCli(["__complete", "models", "--", "claude"]);
	expect(bundled.stdout.length).toBeGreaterThan(0);
}, 60_000);

test("--tools validates against every built-in tool, not the already filtered session", async () => {
	const unknown = await runCli([
		"--tools",
		"read,nosuchtool",
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stderr).toContain("Unknown tool in --tools: nosuchtool");
	for (const name of ["bash", "browser", "checkpoint", "manage_skill", "web_search", "fleet", "inspect_media"]) {
		expect(unknown.stderr).toContain(name);
	}

	// `checkpoint` is documented as built-in and was rejected; it must reach the provider call now.
	const accepted = await runCli([
		"--tools",
		"checkpoint",
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(accepted.stderr).not.toContain("Unknown tool");
	expect(accepted.stderr).toContain("Invalid API key");

	const empty = await runCli(["--tools", "", "-p", "hi", "--model", "w7fault/w7fault-model", "--no-session"]);
	expect(empty.exitCode).toBe(1);
	expect(empty.stderr).toContain("--tools requires at least one tool name");
}, 120_000);

test("the launch parser and launch help describe the same flags", () => {
	const documented = new Set<string>();
	for (const [name, flag] of Object.entries(launchHelp.flags as Record<string, { char?: string }>)) {
		documented.add(`--${name}`);
		if (flag.char) documented.add(`-${flag.char}`);
	}
	// `--help`/`--version` are reported by the root usage, not the launch flag table.
	const globals = new Set(["--help", "-h", "--version", "-v"]);
	const parsed = [...STRING_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...VALUELESS_FLAGS].filter(
		flag => !globals.has(flag),
	);

	expect(parsed.filter(flag => !documented.has(flag))).toEqual([]);
	for (const flag of ["--fork", "--session", "--trusted-extension", "--prompt-cache-key", "--provider-session-id"]) {
		expect(parsed).toContain(flag);
	}
});

test("flags that no parse branch implements are rejected, not advertised", async () => {
	for (const flag of ["--yolo", "--auto-approve"]) {
		const result = await runCli([flag, "-p", "hi", "--model", "w7fault/w7fault-model", "--no-session"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`error: unknown flag: ${flag}`);
		expect(result.stderr).not.toContain("Error: unknown flag");
	}

	const help = await runCli(["--help"]);
	expect(help.exitCode).toBe(0);
	expect(help.stdout).not.toContain("--yolo");
	for (const flag of ["--fork", "--session", "--trusted-extension", "--plugin-dir", "--prompt-cache-key"]) {
		expect(help.stdout).toContain(flag);
	}
}, 60_000);

test("extension load failures name the file and the reason without internal plumbing", async () => {
	const missing = path.join(work, "no-such-extension.ts");

	const launched = await runCli([
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--no-session",
		"--no-extensions",
		"-e",
		missing,
	]);
	expect(launched.stderr).toContain(`Failed to load extension ${missing}:`);
	expect(launched.stderr).not.toContain("?mtime=");
	expect(launched.stderr).not.toContain("host-module-compat");
	expect(launched.stderr).not.toContain("…");
	// One prefix, not one per wrapping layer.
	expect(launched.stderr.match(/Failed to load extension/g)?.length).toBe(1);

	const models = await runCli(["models", "-e", missing]);
	expect(models.exitCode).toBe(1);
	expect(models.stderr).toContain(`Failed to load extension ${missing}:`);
	expect(models.stderr).not.toContain("?mtime=");
	expect(models.stderr).not.toContain("host-module-compat");
}, 120_000);

test("model flags that match nothing say so instead of falling back in silence", async () => {
	const smol = await runCli([
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--smol",
		"definitely-not-a-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(smol.stderr).toContain('--smol model "definitely-not-a-model" not found');

	const slow = await runCli([
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--slow",
		"definitely-not-a-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(slow.stderr).toContain('--slow model "definitely-not-a-model" not found');

	const models = await runCli([
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--models",
		"definitely-not-a-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(models.stderr).toContain('--models pattern "definitely-not-a-model" matched no available model');

	// A real model must not warn.
	const fine = await runCli([
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--smol",
		"w7ok/w7ok-model",
		"--no-session",
		"--no-extensions",
	]);
	expect(fine.stderr).not.toContain("not found; the smol role");
}, 180_000);

test("render honours NO_COLOR and keeps shell-integration markers out of a pipe", async () => {
	const rendered = path.join(root, "render-work");
	await fs.mkdir(rendered, { recursive: true });
	const seeded = await runCli(["-p", "remember tangerine", "--model", "w7ok/w7ok-model", "--no-title"], {
		cwd: rendered,
	});
	expect(seeded.exitCode).toBe(0);

	const plain = await runCli(["render", "-w", "60"], { cwd: rendered, env: { NO_COLOR: "1" } });
	expect(plain.exitCode).toBe(0);
	expect(plain.stdout).toContain("remember tangerine");
	expect(plain.stdoutBytes).not.toContain(0x1b);

	const colored = await runCli(["render", "-w", "60"], {
		cwd: rendered,
		env: { FORCE_COLOR: "3", NO_COLOR: "" },
	});
	expect(colored.exitCode).toBe(0);
	expect(colored.stdout).toContain("\u001b[");
	// OSC 133 prompt markers only mean something to a live terminal.
	expect(colored.stdout).not.toContain("\u001b]133;");
}, 180_000);

test("extra arguments are reported instead of silently dropped", async () => {
	const find = await runCli(["models", "find", "a", "b", "c"]);
	expect(find.exitCode).toBe(1);
	expect(find.stderr).toContain('error: Unexpected arguments: "b", "c"');

	const completions = await runCli(["completions", "bash", "zsh"]);
	expect(completions.exitCode).toBe(1);
	expect(completions.stderr).toContain('error: Unexpected argument: "zsh"');
	expect(completions.stdout).toBe("");

	const badShell = await runCli(["completions", "nu"]);
	expect(badShell.exitCode).toBe(1);
	expect(badShell.stderr).toContain("Expected shell to be one of: bash, zsh, fish");

	const addDirFile = await runCli([
		"--add-dir",
		path.join(agentDir, "models.yml"),
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--no-session",
	]);
	expect(addDirFile.exitCode).toBe(1);
	expect(addDirFile.stderr).toContain("Invalid --add-dir value");
	expect(addDirFile.stderr).toContain("Not a directory.");

	const addDirMissing = await runCli([
		"--add-dir",
		path.join(root, "nope"),
		"-p",
		"hi",
		"--model",
		"w7fault/w7fault-model",
		"--no-session",
	]);
	expect(addDirMissing.exitCode).toBe(1);
	expect(addDirMissing.stderr).toContain("No such directory.");
}, 180_000);
