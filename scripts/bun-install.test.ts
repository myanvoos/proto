import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

interface ActionStep {
	id?: string;
	name: string;
	run?: string;
}
const action = Bun.YAML.parse(
	await Bun.file(path.join(import.meta.dir, "../.github/actions/bun-install/action.yml")).text(),
) as { runs: { steps: ActionStep[] } };
const detect = action.runs.steps.find(step => step.id === "env")?.run;
const install = action.runs.steps.find(step => step.name.startsWith("Install pinned bun"))?.run;
if (!detect || !install) throw new Error("Bun action is missing its runtime steps");

async function runStep(script: string, cwd: string, env: Record<string, string>): Promise<void> {
	const proc = Bun.spawn(["bash", "-e", "-c", script], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, error] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
		new Response(proc.stdout).text(),
	]);
	expect(code, error).toBe(0);
}

test("Bun action replaces a preloaded older runtime but reuses the repository pin", async () => {
	using dir = TempDir.createSync("@proto-bun-install-");
	await Bun.write(dir.join("package.json"), JSON.stringify({ packageManager: "bun@1.4.4" }));
	const bun = dir.join("bin/bun");
	await Bun.write(bun, '#!/bin/sh\necho "$TEST_BUN_VERSION"\n');
	await fs.chmod(bun, 0o755);
	for (const [have, expected] of [
		["1.4.0", "true"],
		["1.4.4", "false"],
		["1.5.0", "true"],
	]) {
		const output = dir.join(`output-${have}`);
		await runStep(detect, dir.path(), {
			PATH: `${dir.join("bin")}${path.delimiter}${process.env.PATH}`,
			GITHUB_OUTPUT: output,
			TEST_BUN_VERSION: have,
			BAZEL_REMOTE_USER: "",
		});
		const result = await Bun.file(output).text();
		expect(result).toContain(`setup_bun=${expected}`);
		expect(result).toContain("bun_install=bun-v1.4.4");
	}
});

test("Bun action persists a writable fallback runtime without moving the dependency store", async () => {
	using dir = TempDir.createSync("@proto-bun-install-");
	const home = dir.join("home");
	await fs.mkdir(path.join(home, ".bun/bin"), { recursive: true });
	await fs.chmod(path.join(home, ".bun/bin"), 0o555);
	const curl = dir.join("bin/curl");
	await Bun.write(curl, "#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n'\n");
	await fs.chmod(curl, 0o755);
	try {
		await runStep(install, dir.path(), {
			HOME: home,
			RUNNER_TEMP: dir.path(),
			PATH: `${dir.join("bin")}${path.delimiter}${process.env.PATH}`,
			GITHUB_ENV: dir.join("env"),
			GITHUB_PATH: dir.join("path"),
			BUN_INSTALL_TAG: "bun-v1.4.4",
			BUN_INSTALL_CACHE_DIR: dir.join("mounted-store"),
		});
		expect(await Bun.file(dir.join("env")).text()).toContain(`BUN_INSTALL=${dir.join("bun")}`);
		expect(await Bun.file(dir.join("env")).text()).toContain(`BUN_INSTALL_CACHE_DIR=${dir.join("mounted-store")}`);
		expect((await Bun.file(dir.join("path")).text()).trim()).toBe(dir.join("bun/bin"));
	} finally {
		await fs.chmod(path.join(home, ".bun/bin"), 0o755);
	}
});
