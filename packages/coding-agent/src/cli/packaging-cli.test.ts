import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../cli.ts");

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** An isolated HOME and profile so a run can never touch the developer's own plugins or agents. */
async function makeSandbox(): Promise<{ home: string; work: string; env: Record<string, string> }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "proto-packaging-cli-"));
	const work = path.join(home, "work");
	await fs.mkdir(work);
	await fs.mkdir(path.join(home, "profile"));
	return {
		home,
		work,
		env: {
			...(process.env as Record<string, string>),
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_STATE_HOME: path.join(home, "state"),
			PI_CODING_AGENT_DIR: path.join(home, "profile"),
			TERM: "dumb",
			NO_COLOR: "1",
		},
	};
}

async function runCli(sandbox: { work: string; env: Record<string, string> }, args: string[]): Promise<RunResult> {
	const child = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: sandbox.work,
		env: sandbox.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout: Bun.stripANSI(stdout), stderr: Bun.stripANSI(stderr) };
}

async function writePlugin(dir: string, pkg: Record<string, unknown>, entry?: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
	if (entry !== undefined) await Bun.write(path.join(dir, "index.ts"), entry);
	return dir;
}

const VALID_EXTENSION = "export default function activate() {\n\treturn { name: 'w7-good' };\n}\n";

test("unpack refuses the whole batch when a target file cannot be written", async () => {
	const sandbox = await makeSandbox();
	const target = path.join(sandbox.home, "agents-out");
	await fs.mkdir(target);
	// A read-only agent file used to be discovered mid-loop, after earlier agents had already
	// been overwritten, and the run died with a raw EACCES and an empty stdout.
	const blocked = path.join(target, "scout.md");
	await Bun.write(blocked, "PRESERVED\n");
	await fs.chmod(blocked, 0o444);

	const result = await runCli(sandbox, ["agents", "unpack", "--dir", target, "--force"]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("Nothing was written");
	expect(result.stderr).toContain(blocked);
	expect(result.stderr).toContain("EACCES");
	expect(await Bun.file(blocked).text()).toBe("PRESERVED\n");
	// No other agent was written: the batch stopped before the first byte landed.
	expect(await fs.readdir(target)).toEqual(["scout.md"]);

	await fs.chmod(blocked, 0o644);
	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 60_000);

test("an empty --dir is refused instead of silently writing into the user profile", async () => {
	const sandbox = await makeSandbox();

	const result = await runCli(sandbox, ["agents", "unpack", "--dir", ""]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("--dir requires a directory path");
	expect(await fs.exists(path.join(sandbox.home, "profile", "agents"))).toBe(false);

	// The same invocation with a real directory still unpacks.
	const ok = await runCli(sandbox, ["agents", "unpack", "--dir", "unpacked"]);
	expect(ok.exitCode).toBe(0);
	expect((await fs.readdir(path.join(sandbox.work, "unpacked"))).length).toBeGreaterThan(0);

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 60_000);

test("uninstalling a plugin that is not installed fails like enable and disable do", async () => {
	const sandbox = await makeSandbox();

	const uninstall = await runCli(sandbox, ["plugin", "uninstall", "not-installed"]);
	const enable = await runCli(sandbox, ["plugin", "enable", "not-installed"]);

	expect(uninstall.exitCode).toBe(1);
	expect(uninstall.stdout).not.toContain("Uninstalled");
	expect(uninstall.stderr).toContain("not-installed");
	expect(uninstall.stderr).toContain("is not installed");
	expect(enable.exitCode).toBe(1);

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 60_000);

test("installing a local plugin runs the validation doctor reports, before linking", async () => {
	const sandbox = await makeSandbox();
	const missing = await writePlugin(path.join(sandbox.home, "missing"), {
		name: "w7-missing",
		version: "1.0.0",
		proto: { extensions: ["./does-not-exist.ts"] },
	});
	const throws = await writePlugin(
		path.join(sandbox.home, "throws"),
		{ name: "w7-throws", version: "1.0.0", proto: { extensions: ["./index.ts"] } },
		'throw new Error("boom at import");\n',
	);
	const unparsable = await writePlugin(
		path.join(sandbox.home, "syntax"),
		{ name: "w7-syntax", version: "1.0.0", proto: { extensions: ["./index.ts"] } },
		"export default {\n",
	);

	for (const [source, expected] of [
		[missing, "not found on disk"],
		[throws, "boom at import"],
		[unparsable, "Unexpected token"],
	] as const) {
		const result = await runCli(sandbox, ["plugin", "install", source]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).not.toContain("Linked");
		expect(result.stderr).toContain("Failed to install");
		expect(result.stderr).toContain(expected);
	}

	// Nothing broken was linked, so the roster stays empty.
	const list = await runCli(sandbox, ["plugin", "list"]);
	expect(list.stdout).toContain("No plugins installed");

	// --force is the escape hatch, and it still says what is wrong.
	const forced = await runCli(sandbox, ["plugin", "install", missing, "--force"]);
	expect(forced.exitCode).toBe(0);
	expect(forced.stdout).toContain("Linked w7-missing");
	expect(forced.stderr).toContain("not found on disk");

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 120_000);

test("a package without a proto manifest links with the warning doctor would raise", async () => {
	const sandbox = await makeSandbox();
	const plugin = await writePlugin(
		path.join(sandbox.home, "noproto"),
		{ name: "w7-noproto", version: "1.0.0" },
		VALID_EXTENSION,
	);

	const result = await runCli(sandbox, ["plugin", "install", plugin]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("Linked w7-noproto");
	expect(result.stderr).toContain("No proto/pi manifest");

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 60_000);

test("plugin config lists values that were set, and honours the documented --set form", async () => {
	const sandbox = await makeSandbox();
	const plugin = await writePlugin(
		path.join(sandbox.home, "good"),
		{ name: "w7-good", version: "1.0.0", proto: { extensions: ["./index.ts"] } },
		VALID_EXTENSION,
	);
	expect((await runCli(sandbox, ["plugin", "install", plugin])).exitCode).toBe(0);

	expect((await runCli(sandbox, ["plugin", "config", "set", "w7-good", "foo", "bar"])).exitCode).toBe(0);
	const listed = await runCli(sandbox, ["plugin", "config", "list", "w7-good"]);
	expect(listed.stdout).toContain("foo: bar");
	expect(listed.stdout).not.toContain("No settings defined");

	const flagForm = await runCli(sandbox, ["plugin", "config", "w7-good", "--set", "alpha=42"]);
	expect(flagForm.exitCode).toBe(0);
	expect((await runCli(sandbox, ["plugin", "config", "get", "w7-good", "alpha"])).stdout.trim()).toBe("42");

	const malformed = await runCli(sandbox, ["plugin", "config", "w7-good", "--set", "noequalssign"]);
	expect(malformed.exitCode).toBe(1);
	expect(malformed.stderr).toContain("--set expects <key>=<value>");
	expect(malformed.stderr).not.toContain("Plugin name required");

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 120_000);

test("misuse of plugin subcommands reports through the standard usage formatter", async () => {
	const sandbox = await makeSandbox();
	const plugin = await writePlugin(
		path.join(sandbox.home, "good"),
		{ name: "w7-good", version: "1.0.0", proto: { extensions: ["./index.ts"] } },
		VALID_EXTENSION,
	);

	for (const args of [
		["plugin", "config"],
		["plugin", "features"],
		["plugin", "install"],
	]) {
		const result = await runCli(sandbox, args);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("USAGE");
		expect(result.stderr).toContain("proto plugin --help");
		expect(result.stderr).not.toMatch(/^Usage: /m);
	}

	// --scope cannot apply to a local path, so the install is refused rather than silently
	// linking at user scope after a warning.
	const scoped = await runCli(sandbox, ["plugin", "install", plugin, "--scope", "project"]);
	expect(scoped.exitCode).toBe(1);
	expect(scoped.stderr).toContain("--scope is only supported for marketplace installs");
	expect(scoped.stdout).not.toContain("Linked");
	expect((await runCli(sandbox, ["plugin", "list"])).stdout).toContain("No plugins installed");

	await fs.rm(sandbox.home, { recursive: true, force: true });
}, 120_000);
