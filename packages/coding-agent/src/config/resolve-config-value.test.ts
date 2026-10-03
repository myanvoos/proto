import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createConfigHeaderResolver,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	runShellCommand,
} from "./resolve-config-value";

const resolverUrl = pathToFileURL(path.join(import.meta.dir, "resolve-config-value.ts")).href;

const TEMP_ENV_KEYS: string[] = [];

function setEnv(key: string, value: string): void {
	TEMP_ENV_KEYS.push(key);
	process.env[key] = value;
}

function delayedValueCommand(value: string): string {
	if (process.platform !== "win32") return `!sleep 0.15; printf %s ${JSON.stringify(value)}`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
		`setTimeout(() => process.stdout.write(${JSON.stringify(value)}), 150)`,
	)}`;
}

afterEach(() => {
	for (const key of TEMP_ENV_KEYS.splice(0)) delete process.env[key];
	invalidateAllCommandConfigs();
});

describe("request-time config header resolution", () => {
	it("rejects on abort while a header source is still pending instead of returning partial headers", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Record<string, string>>();
		const resolver = createConfigHeaderResolver([
			async () => {
				started.resolve();
				return release.promise;
			},
		]);
		if (!resolver) throw new Error("Expected a header resolver");
		const controller = new AbortController();
		const pending = resolver(controller.signal);
		try {
			await started.promise;
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			release.resolve({ Authorization: "too late" });
		}
	});

	it("layers nested resolvers with later sources winning and authHeader applied last", async () => {
		setEnv("PROTO_TEST_LIVE_KEY", "sekret");
		const inner = createConfigHeaderResolver([{ "X-Tenant": "old", "X-Keep": "k", Authorization: "wrong" }]);
		const outer = createConfigHeaderResolver([inner, { "X-Tenant": "new" }], {
			authHeader: true,
			apiKeyConfig: "PROTO_TEST_LIVE_KEY",
		});

		expect(await outer?.()).toEqual({ "X-Tenant": "new", "X-Keep": "k", Authorization: "Bearer sekret" });
	});

	it("re-reads environment-backed values on every request", async () => {
		setEnv("PROTO_TEST_LIVE_DYN", "v1");
		const resolver = createConfigHeaderResolver([{ "X-Dyn": "PROTO_TEST_LIVE_DYN" }]);

		expect((await resolver?.())?.["X-Dyn"]).toBe("v1");
		setEnv("PROTO_TEST_LIVE_DYN", "v2");
		expect((await resolver?.())?.["X-Dyn"]).toBe("v2");
	});

	it("runs command-backed headers without blocking the event loop and caches until invalidated", async () => {
		const command = delayedValueCommand("token");
		const resolver = createConfigHeaderResolver([{ Authorization: command }]);
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 20);

		const pending = resolver?.();
		// Real time is intentional: fake timers cannot observe a synchronous child-process API blocking the loop.
		await Bun.sleep(50);
		expect(timerFired).toBe(true);
		expect(await pending).toEqual({ Authorization: "token" });
		clearTimeout(timer);

		// Cached: a second request does not wait on the command again.
		const cachedStart = performance.now();
		expect(await resolver?.()).toEqual({ Authorization: "token" });
		expect(performance.now() - cachedStart).toBeLessThan(100);

		// Invalidated (auth retry): the next request re-runs the command.
		invalidateCommandConfig(command);
		const rerunStart = performance.now();
		expect(await resolver?.()).toEqual({ Authorization: "token" });
		expect(performance.now() - rerunStart).toBeGreaterThanOrEqual(100);
	});

	it("resolves a deeply composed parent-child chain once per layer", async () => {
		const depth = 64;
		let baseReads = 0;
		const base = async (): Promise<Record<string, string>> => {
			baseReads++;
			return { "X-Base": "b" };
		};
		let resolver = createConfigHeaderResolver([base]);
		for (let i = 0; i < depth; i++) {
			resolver = createConfigHeaderResolver([resolver, { [`X-L${i}`]: String(i) }]);
		}

		const headers = await resolver?.();
		expect(Object.keys(headers ?? {})).toHaveLength(depth + 1);
		expect(headers?.["X-Base"]).toBe("b");
		expect(headers?.[`X-L${depth - 1}`]).toBe(String(depth - 1));
		expect(baseReads).toBe(1);
	});
});

async function runResolverProbe(script: string, options: { env?: Record<string, string>; fd3?: number } = {}) {
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", script],
		cwd: import.meta.dir,
		env: options.env ?? Bun.env,
		stdio: options.fd3 === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", options.fd3],
		timeout: 15_000,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(exitCode, stdout).toBe(0);
	return stdout.trim().split("\n");
}

async function expectProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	let child = Process.fromPid(pid);
	// Signal delivery and reaping are asynchronous OS events with no completion hook to await.
	while (Date.now() < deadline && child?.status() === "running") {
		await Bun.sleep(25);
		child = Process.fromPid(pid);
	}
	try {
		expect(child?.status(), `descendant ${pid} survived the timeout`).not.toBe("running");
	} finally {
		child?.killTree(9);
	}
}

describe("!command process isolation", () => {
	it("does not hand descriptors the launcher passed proto to the command", async () => {
		await using dir = await TempDir.create("@proto-config-fd-");
		const canaryPath = path.join(dir.path(), "canary.txt");
		await Bun.write(canaryPath, "CANARY-THAT-MUST-NOT-RESOLVE");
		const spyPath = path.join(dir.path(), "fd3-spy.sh");
		await Bun.write(spyPath, "#!/bin/sh\ncat <&3\n");
		await fs.promises.chmod(spyPath, 0o755);
		const canary = await fs.promises.open(canaryPath, "r");
		try {
			const lines = await runResolverProbe(
				`import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};
console.log(String(await resolveConfigValue("!echo control-ok")));
console.log(String(await resolveConfigValue(${JSON.stringify(`!${spyPath}`)})));`,
				{ fd3: canary.fd },
			);
			expect(lines).toEqual(["control-ok", "undefined"]);
		} finally {
			await canary.close();
		}
	});

	it("resolves commands when PATH has no shell", async () => {
		await using dir = await TempDir.create("@proto-config-no-sh-");
		const lines = await runResolverProbe(
			`import { runShellCommand } from ${JSON.stringify(resolverUrl)};
console.log(String(await runShellCommand("echo pathless-ok", 5_000)));`,
			{ env: { ...Bun.env, PATH: dir.path() } },
		);
		expect(lines).toEqual(["pathless-ok"]);
	});

	it("kills backgrounded, reparented, and SIGTERM-ignoring descendants when the command times out", async () => {
		await using dir = await TempDir.create("@proto-config-treekill-");
		const workers = [
			{ name: "backgrounded", launch: (script: string) => `"${script}" &`, body: "sleep 30" },
			{ name: "reparented", launch: (script: string) => `sh -c '"${script}" &' &`, body: "sleep 30" },
			{ name: "term-ignoring", launch: (script: string) => `"${script}" &`, body: "trap '' TERM\nexec sleep 30" },
		];
		let command = "";
		const pidFiles: string[] = [];
		for (const worker of workers) {
			const script = path.join(dir.path(), `${worker.name}.sh`);
			const pidFile = path.join(dir.path(), `${worker.name}.pid`);
			await Bun.write(script, `#!/bin/sh\necho $$ > "${pidFile}"\n${worker.body}\n`);
			await fs.promises.chmod(script, 0o755);
			command += `${worker.launch(script)} until [ -s "${pidFile}" ]; do sleep 0.01; done; `;
			pidFiles.push(pidFile);
		}
		expect(await runShellCommand(`${command}sleep 10`, 3_000, dir.path())).toBeUndefined();
		for (const pidFile of pidFiles) {
			await expectProcessGone(Number.parseInt((await Bun.file(pidFile).text()).trim(), 10));
		}
	});
});
