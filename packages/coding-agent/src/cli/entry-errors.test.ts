import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";

const CLI = path.resolve(import.meta.dir, "../cli.ts");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proto-cli-entry-"));
const work = path.join(tmp, "work");
await fs.mkdir(work);
await fs.mkdir(path.join(tmp, "profile"));

function cliEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: tmp,
		XDG_CONFIG_HOME: path.join(tmp, "config"),
		XDG_CACHE_HOME: path.join(tmp, "cache"),
		XDG_DATA_HOME: path.join(tmp, "data"),
		XDG_STATE_HOME: path.join(tmp, "state"),
		PI_CODING_AGENT_DIR: path.join(tmp, "profile"),
		TERM: "dumb",
		NO_COLOR: "1",
		...overrides,
	};
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(
	args: string[],
	options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
	const child = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: work,
		env: options.env ?? cliEnv(),
		stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Bun's default handler prints numbered source lines and `at` frames; neither may reach a user. */
function looksLikeSourceDump(text: string): boolean {
	return /^\s*\d+ \|/m.test(text) || /\n\s+at /.test(text);
}

test("launching the interface without a terminal reports why instead of exiting silently", async () => {
	const result = await runCli(["hello", "world"], { stdin: "" });

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("requires an interactive TTY");
	expect(result.stderr).toContain("stdin and stdout are not terminals");
	expect(result.stderr).toContain('-p "your prompt"');
	expect(Bun.stripANSI(result.stdout).trim()).toBe("");
}, 60_000);

test("a terminal stdin with redirected stdout is refused instead of hanging forever", async () => {
	const outFile = path.join(tmp, "tty-stdout.log");
	const errFile = path.join(tmp, "tty-stderr.log");
	const pty = new PtySession();
	let ptyOutput = "";
	await pty.startArgv(
		{
			application: "/bin/sh",
			args: ["-c", `${process.execPath} ${CLI} hello > ${outFile} 2> ${errFile}; echo EXIT=$?`],
			cwd: work,
			env: cliEnv({ TERM: "xterm-256color" }),
			cols: 80,
			rows: 24,
		},
		(_error, chunk) => {
			ptyOutput += chunk;
		},
	);

	expect(Bun.stripANSI(ptyOutput)).toContain("EXIT=1");
	const stderr = await fs.readFile(errFile, "utf8");
	expect(stderr).toContain("requires an interactive TTY");
	expect(stderr).toContain("stdout is not a terminal");
	expect(await fs.readFile(outFile, "utf8")).toBe("");
}, 120_000);

test("runtime failures print the message, not a source dump", async () => {
	// Bad input is the user's to fix: usage style, no stack-trace advertisement.
	const overlay = await runCli(["--config", path.join(tmp, "missing-overlay.yml"), "-p", "x"]);

	expect(overlay.exitCode).toBe(1);
	expect(overlay.stderr.split("\n")[0]).toStartWith("error: Config overlay not found:");
	expect(looksLikeSourceDump(overlay.stderr)).toBe(false);
	expect(overlay.stderr).toContain("USAGE");
	expect(overlay.stderr).not.toContain("PI_DEBUG_ERRORS=1");

	const missingSession = await runCli(["render", "deadbeef"]);
	expect(missingSession.exitCode).toBe(1);
	expect(missingSession.stderr.split("\n")[0]).toBe('error: Session "deadbeef" not found.');
	expect(looksLikeSourceDump(missingSession.stderr)).toBe(false);
	expect(missingSession.stderr).not.toContain("PI_DEBUG_ERRORS=1");

	// An internal failure is the one place the stack hint belongs.
	const corruptSession = path.join(work, "corrupt-session.jsonl");
	await fs.writeFile(corruptSession, 'not a session\n{"broken":\n');
	const internal = await runCli(["render", corruptSession]);
	expect(internal.exitCode).toBe(1);
	expect(internal.stderr.split("\n")[0]).toStartWith("error: Cannot resume session");
	expect(looksLikeSourceDump(internal.stderr)).toBe(false);
	expect(internal.stderr).toContain("PI_DEBUG_ERRORS=1");

	const debugged = await runCli(["render", corruptSession], { env: cliEnv({ PI_DEBUG_ERRORS: "1" }) });
	expect(debugged.exitCode).toBe(1);
	expect(debugged.stderr).toContain("error: Cannot resume session");
	expect(debugged.stderr).toContain(" at ");
}, 60_000);

test("invalid flag values name the flag and list what is accepted", async () => {
	const mode = await runCli(["-p", "x", "--mode", "bogus"]);
	expect(mode.exitCode).toBe(1);
	expect(mode.stderr).toContain('Invalid --mode value: "bogus"');
	expect(mode.stderr).toContain("text, json, rpc, acp, rpc-ui");

	const thinking = await runCli(["--thinking", "bogus", "-p", "x"]);
	expect(thinking.exitCode).toBe(1);
	expect(thinking.stderr).toContain('Invalid --thinking value: "bogus"');

	const cwd = await runCli(["--cwd", path.join(tmp, "definitely-missing"), "-p", "x"]);
	expect(cwd.exitCode).toBe(1);
	expect(cwd.stderr).toContain("Invalid --cwd value");
	expect(cwd.stderr).toContain("No such directory.");
	expect(looksLikeSourceDump(cwd.stderr)).toBe(false);

	const port = await runCli(["browser-relay", "serve", "--port", "99999"]);
	expect(port.exitCode).toBe(1);
	expect(port.stderr).toContain("Invalid --port value: 99999");
	expect(looksLikeSourceDump(port.stderr)).toBe(false);
}, 120_000);

test("a leading --config overlay reaches subcommands instead of being dropped", async () => {
	const overlay = path.join(tmp, "overlay.yml");
	await fs.writeFile(overlay, "theme:\n  dark: overlay-theme\n");

	const [plain, overlaid, equals, missing] = await Promise.all([
		runCli(["config", "get", "theme.dark"]),
		runCli(["--config", overlay, "config", "get", "theme.dark"]),
		runCli([`--config=${overlay}`, "config", "get", "theme.dark"]),
		runCli(["--config", path.join(tmp, "absent.yml"), "config", "get", "theme.dark"]),
	]);

	expect(plain.stdout.trim()).toBe("proto");
	expect(overlaid.exitCode).toBe(0);
	expect(overlaid.stdout.trim()).toBe("overlay-theme");
	expect(equals.stdout.trim()).toBe("overlay-theme");
	expect(missing.exitCode).toBe(1);
	expect(missing.stderr).toContain("Config overlay not found:");

	// The command declares the flag too, so the trailing form works and reports what it stored.
	const trailing = await runCli(["config", "get", "theme.dark", "--config", overlay]);
	expect(trailing.stdout.trim()).toBe("overlay-theme");

	const stored = await runCli(["config", "set", "theme.dark", "stored-theme", "--config", overlay]);
	expect(stored.exitCode).toBe(0);
	expect(stored.stdout).toContain("Set theme.dark = stored-theme");
	expect(stored.stderr).toContain("--config overlays are read-only");
	expect((await runCli(["config", "get", "theme.dark"])).stdout.trim()).toBe("stored-theme");
	expect((await runCli(["config", "get", "theme.dark", "--config", overlay])).stdout.trim()).toBe("overlay-theme");
}, 120_000);

test("usage errors exit 1 whether they come from the launcher or a subcommand", async () => {
	const [launch, subcommand] = await Promise.all([
		runCli(["--max-time", "banana", "-p", "x"]),
		runCli(["config", "--zzz-unknown"]),
	]);

	expect(launch.exitCode).toBe(1);
	expect(launch.stderr).toContain("Invalid --max-time value");
	expect(subcommand.exitCode).toBe(1);
	expect(subcommand.stderr).toContain("Unknown option");
}, 60_000);

test("a mistyped or reserved command word is reported instead of becoming a prompt", async () => {
	const [reserved, typo] = await Promise.all([runCli(["mcp"]), runCli(["modles"])]);

	expect(reserved.exitCode).toBe(1);
	expect(reserved.stderr).toContain("`proto mcp` is not a top-level command");
	expect(reserved.stderr).toContain("proto launch mcp");

	expect(typo.exitCode).toBe(1);
	expect(typo.stderr).toContain("Did you mean `proto models`?");
	expect(typo.stderr).toContain("proto launch modles");
}, 60_000);

test("a reader that closes the pipe early is not an unhandled rejection", async () => {
	const child = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${CLI} __complete models gpt | head -2`], {
		cwd: work,
		env: cliEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	expect(exitCode).toBe(0);
	expect(stdout.trimEnd().split("\n")).toHaveLength(2);
	expect(stderr).not.toContain("Unhandled Rejection");
	expect(stderr).not.toContain("EPIPE");
}, 60_000);

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});
