import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const tempDirs: string[] = [];
const envModulePath = path.join(import.meta.dir, "env.ts");

async function makeEnvDir(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-utils-env-"));
	tempDirs.push(dir);
	await Promise.all(Object.entries(files).map(([name, contents]) => Bun.write(path.join(dir, name), contents)));
	return dir;
}

async function runProbe(
	script: string,
	env: Record<string, string | undefined>,
	options: { cwd?: string; noEnvFile?: boolean } = {},
): Promise<unknown> {
	const args = [process.execPath];
	if (options.noEnvFile) args.push("--no-env-file");
	args.push("--no-install", "--eval", script);
	const proc = Bun.spawn(args, {
		cwd: options.cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as unknown;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

describe("filterChildShellEnv", () => {
	test("uses an explicit environment's mode instead of the proto launch mode", async () => {
		const cwd = await makeEnvDir({
			".env": "",
			".env.development.local": "DOTENV_PROVENANCE_MARKER=mode-local-value\n",
		});
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(",
			'  { DOTENV_PROVENANCE_MARKER: "mode-local-value", UNCHANGED: "parent-value" },',
			`  ${JSON.stringify(cwd)},`,
			");",
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");

		const child = await runProbe(
			script,
			{ NODE_ENV: "test", DOTENV_PROVENANCE_MARKER: undefined },
			{ noEnvFile: true },
		);

		expect(child).toEqual({ UNCHANGED: "parent-value" });
	});

	test("does not forward session bridge capabilities into child shells", async () => {
		const cwd = await makeEnvDir({ ".env": "" });
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv({",
			'  PI_KERNEL_BRIDGE_ADDR: "127.0.0.1:1234",',
			'  PI_KERNEL_BRIDGE_TOKEN: "secret",',
			'  PI_KERNEL_FLEET_ROOT: "/previous/session/fleet",',
			'  PI_SESSION_FILE: "/previous/session.jsonl",',
			'  PI_ARTIFACTS_DIR: "/previous/session",',
			'  PI_TOOL_BRIDGE_URL: "http://127.0.0.1:5678",',
			'  PI_TOOL_BRIDGE_TOKEN: "tool-secret",',
			'  PI_TOOL_BRIDGE_SESSION: "previous",',
			'  PI_EVAL_LOCAL_ROOTS: "{}",',
			'  PI_DEBUG_STARTUP: "1",',
			'  UNCHANGED: "parent-value",',
			`}, ${JSON.stringify(cwd)});`,
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");

		const child = await runProbe(script, {}, { noEnvFile: true });

		expect(child).toEqual({ PI_DEBUG_STARTUP: "1", UNCHANGED: "parent-value" });
	});

	test("keeps launch provenance when filtering the live process environment", async () => {
		const cwd = await makeEnvDir({
			".env": "NODE_ENV=production\n",
			".env.development.local": "DOTENV_PROVENANCE_MARKER=mode-local-value\n",
		});
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(process.env, process.cwd());",
			"process.stdout.write(JSON.stringify({",
			"  processValue: process.env.DOTENV_PROVENANCE_MARKER ?? null,",
			"  childValue: child.DOTENV_PROVENANCE_MARKER ?? null,",
			"  nodeEnv: process.env.NODE_ENV ?? null,",
			"}));",
		].join("\n");

		const observed = await runProbe(script, { NODE_ENV: undefined, DOTENV_PROVENANCE_MARKER: undefined }, { cwd });

		expect(observed).toEqual({
			processValue: "mode-local-value",
			childValue: null,
			nodeEnv: "production",
		});
	});
});
