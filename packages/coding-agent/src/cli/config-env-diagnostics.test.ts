import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Every defect here is about what a real `proto` run tells the user: which stream a diagnostic goes
// to, which exit code it carries, and whether a bad environment is reported before anything is
// written. So each case spawns the CLI against an isolated HOME and profile.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-cli-diagnostics-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });

// A models.yml a user could plausibly hand-edit wrong: `models` must be a list.
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  broken:",
		"    baseUrl: http://127.0.0.1:1/v1",
		"    apiKey: test-key",
		"    api: openai-completions",
		'    models: "not-a-list"',
		"",
	].join("\n"),
);

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, ...args],
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
			...env,
		},
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await child.exited;
	return { exitCode, stdout: await stdout, stderr: await stderr };
}

test("a models.yml validation warning never contaminates stdout, in text or JSON mode", async () => {
	const text = await runCli(["models", "list"]);
	expect(text.stderr).toContain("models.yml validation failed");
	expect(text.stderr).toContain("must be an array");
	expect(text.stdout).not.toContain("Warning");

	const json = await runCli(["models", "list", "--json"]);
	expect(json.stderr).toContain("models.yml validation failed");
	// The whole point: stdout stays parseable when the config is broken.
	expect(() => JSON.parse(json.stdout)).not.toThrow();
	expect(JSON.parse(json.stdout)).toEqual({ models: [] });

	// Same diagnostic on both surfaces, not a second phrasing for JSON callers.
	expect(json.stderr).toBe(text.stderr);
});

test("a negative number is a value, not an option cluster", async () => {
	const set = await runCli(["config", "set", "setupVersion", "-42"]);
	expect(set.exitCode).toBe(0);
	expect(set.stdout).toContain("setupVersion = -42");

	const get = await runCli(["config", "get", "setupVersion"]);
	expect(get.stdout.trim()).toBe("-42");

	// The explicit escape hatch keeps working and agrees with the bare form.
	const viaDashDash = await runCli(["config", "set", "setupVersion", "--", "-7"]);
	expect(viaDashDash.exitCode).toBe(0);
	expect((await runCli(["config", "get", "setupVersion"])).stdout.trim()).toBe("-7");
});

test("an unknown option names the token the user typed and suggests a command that reproduces it", async () => {
	const result = await runCli(["config", "set", "setupVersion", "--42"]);
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain(`Unknown option '--42'`);
	// Following the suggestion literally must pass the same token, not a mangled one.
	expect(result.stderr).toContain(`proto config set setupVersion -- "--42"`);
	expect(result.stderr).not.toContain(`Unknown option '4'`);
});

test("usage reports an empty result the same way in text and JSON mode", async () => {
	const text = await runCli(["usage"]);
	const json = await runCli(["usage", "--json"]);
	expect(text.exitCode).toBe(1);
	expect(json.exitCode).toBe(text.exitCode);
	const payload = JSON.parse(json.stdout) as { error?: string; reports: unknown[] };
	expect(payload.reports).toEqual([]);
	expect(payload.error).toBeDefined();
	expect(text.stderr).toContain(payload.error ?? "\u0000");

	const historyText = await runCli(["usage", "--history"]);
	const historyJson = await runCli(["usage", "--history", "--json"]);
	expect(historyText.exitCode).toBe(1);
	expect(historyJson.exitCode).toBe(1);
	const historyPayload = JSON.parse(historyJson.stdout) as { error?: string; entries: unknown[] };
	expect(historyPayload.entries).toEqual([]);
	expect(historyText.stderr).toContain(historyPayload.error ?? "\u0000");
});

test("PI_CODING_AGENT_DIR pointing at a file is rejected with what the path actually is", async () => {
	const file = path.join(root, "notadir.txt");
	await fs.writeFile(file, "x");
	const result = await runCli(["config", "path"], { PI_CODING_AGENT_DIR: file });
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("must point to a directory");
	expect(result.stderr).toContain(file);
	expect(result.stderr).not.toContain("exists: true");
	expect(result.stderr).not.toContain("at <anonymous>");
});

test("a relative PI_CODING_AGENT_DIR is rejected instead of silently following the working directory", async () => {
	const result = await runCli(["config", "path"], { PI_CODING_AGENT_DIR: "relagent" });
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("must be an absolute path");
	expect(result.stderr).toContain(path.join(cwd, "relagent"));
	expect(await fs.exists(path.join(cwd, "relagent"))).toBe(false);
});

test("a tilde in PI_CODING_AGENT_DIR resolves to the home directory, not a directory named ~", async () => {
	const result = await runCli(["config", "path"], { PI_CODING_AGENT_DIR: "~/tilde-agent" });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.trim()).toBe(path.join(home, "tilde-agent"));
	expect(await fs.exists(path.join(cwd, "~"))).toBe(false);
});

test("an empty PI_CODING_AGENT_DIR says which directory is used instead", async () => {
	const result = await runCli(["config", "path"], { PI_CODING_AGENT_DIR: "" });
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toContain("PI_CODING_AGENT_DIR is set but empty");
	const used = result.stdout.trim();
	expect(used).toBe(path.join(home, ".proto", "agent"));
	expect(result.stderr).toContain(used);
});

test("a usable PI_CODING_AGENT_DIR stays silent", async () => {
	const result = await runCli(["config", "path"], { PI_CODING_AGENT_DIR: path.join(root, "fresh-agent") });
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout.trim()).toBe(path.join(root, "fresh-agent"));
});
