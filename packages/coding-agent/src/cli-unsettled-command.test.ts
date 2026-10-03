import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// The CLI entry is a floating `runCli()` call, so a one-shot command whose await never settles and holds no live
// handle lets the event loop drain; that must exit 1 with a diagnostic instead of 0. A preload stalls
// `Settings.init` to reach that state.

const cliEntry = path.join(import.meta.dir, "cli.ts");
const settingsUrl = new URL("./config/settings.ts", import.meta.url).href;
const DIAGNOSTIC = "`proto config` ended before completing";

async function runConfigSet(tempDir: TempDir, stallSettingsInit: boolean, preloadExtra = "") {
	const home = tempDir.join("home");
	fs.mkdirSync(home);
	const preloadArgs: string[] = [];
	if (stallSettingsInit) {
		const preloadPath = tempDir.join("stall-settings-init.ts");
		await Bun.write(
			preloadPath,
			`import { Settings } from ${JSON.stringify(settingsUrl)};\nSettings.init = () => Promise.withResolvers<never>().promise;\n${preloadExtra}`,
		);
		preloadArgs.push("--preload", preloadPath);
	}
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_PROFILE;
	delete env.PI_CONFIG_DIR;
	const proc = Bun.spawn([process.execPath, ...preloadArgs, cliEntry, "config", "set", "startup.quiet", "true"], {
		cwd: tempDir.path(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("one-shot CLI command settlement", () => {
	it("exits 1 naming the command when its work never settles", async () => {
		using tempDir = TempDir.createSync("@proto-cli-unsettled-");
		const run = await runConfigSet(tempDir, true);

		expect(run.exitCode, run.stderr).toBe(1);
		expect(run.stderr).toContain(DIAGNOSTIC);
		expect(run.stderr).not.toContain("startup.quiet");
		expect(run.stdout).toBe("");
	}, 30_000);

	it("keeps an explicit non-zero exit code without a second diagnostic", async () => {
		using tempDir = TempDir.createSync("@proto-cli-unsettled-exit-");
		const run = await runConfigSet(tempDir, true, `process.on("beforeExit", () => process.exit(3));\n`);

		expect(run.exitCode, run.stderr).toBe(3);
		expect(run.stderr).not.toContain("ended before completing");
	}, 30_000);

	it("keeps a completed command's exit 0", async () => {
		using tempDir = TempDir.createSync("@proto-cli-settled-");
		const run = await runConfigSet(tempDir, false);

		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stdout).toContain("Set startup.quiet = true");
		expect(run.stderr).not.toContain("ended before completing");
	}, 30_000);
});
