import { describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { daemonClientForProject } from "../../launch/client";
import { daemonRuntimeDir } from "../../launch/paths";
import {
	ensureChromiumExecutable,
	isSnapChromiumExecutable,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	resolveChromiumUserDataDir,
	resolveSharedBrowserLaunchSpec,
} from "./launch";
import { ensureSharedBrowser } from "./shared-daemon";

test("Puppeteer evaluation tolerates a missing caller stack frame", async () => {
	const { withSourcePuppeteerURLIfNone, getSourcePuppeteerURLIfAvailable } = await import(
		"puppeteer-core/internal/common/util.js"
	);
	const originalLimit = Error.stackTraceLimit;
	const originalPrepare = Error.prepareStackTrace;
	try {
		Error.stackTraceLimit = 0;
		const callback = () => 42;
		expect(withSourcePuppeteerURLIfNone("evaluate", callback)).toBe(callback);
		expect(getSourcePuppeteerURLIfAvailable(callback)?.toString()).toContain("pptr:evaluate;");
		expect(Error.prepareStackTrace).toBe(originalPrepare);
	} finally {
		Error.stackTraceLimit = originalLimit;
		Error.prepareStackTrace = originalPrepare;
	}
});

const SNAP_EXECUTABLE = "/snap/bin/chromium";

function snapCommonDir(): string {
	return path.join(os.homedir(), "snap", "chromium", "common");
}

function isSnapHost(executablePath: string | undefined): boolean {
	return executablePath === SNAP_EXECUTABLE;
}

describe("Chromium launch flags", () => {
	test("allows file URLs for tool-owned browsers", async () => {
		const launch = await resolveSharedBrowserLaunchSpec({
			headless: true,
			userDataDir: path.join(os.tmpdir(), "proto-browser-file-url-profile-test"),
		});
		if (!launch) return;
		expect(launch.args).toContain("--allow-file-access-from-files");
	});
});

describe("Snap Chromium profile paths", () => {
	test("recognizes the supported Snap executable spellings", () => {
		expect(isSnapChromiumExecutable("/snap/bin/chromium")).toBe(true);
		expect(isSnapChromiumExecutable("/snap/bin/chromium-browser")).toBe(true);
		expect(isSnapChromiumExecutable("/snap/chromium/current/usr/lib/chromium/chromium")).toBe(true);
		if (fsSync.existsSync("/usr/bin/chromium-browser")) {
			expect(isSnapChromiumExecutable("/usr/bin/chromium-browser")).toBe(
				fsSync.readFileSync("/usr/bin/chromium-browser", "utf8").includes("/snap/bin/chromium"),
			);
		}
		expect(isSnapChromiumExecutable("/opt/chromium")).toBe(false);
		expect(isSnapChromiumExecutable(undefined)).toBe(false);
	});

	test("keeps non-Snap shared profiles unchanged", () => {
		const requestedProfile = path.join(os.tmpdir(), "proto-browser-profile-test");
		expect(resolveChromiumUserDataDir("/opt/chromium", requestedProfile)).toBe(requestedProfile);
	});

	test("isolates Snap shared profiles deterministically", () => {
		const firstRequested = path.join(
			os.homedir(),
			".proto",
			"run",
			"daemons",
			"0123456789abcdef",
			"proto.browser.headless.profile",
		);
		const secondRequested = path.join(
			os.homedir(),
			".proto",
			"run",
			"daemons",
			"fedcba9876543210",
			"proto.browser.headless.profile",
		);
		const first = resolveChromiumUserDataDir(SNAP_EXECUTABLE, firstRequested);
		const firstAgain = resolveChromiumUserDataDir(SNAP_EXECUTABLE, firstRequested);
		const second = resolveChromiumUserDataDir(SNAP_EXECUTABLE, secondRequested);

		expect(first).toBe(firstAgain);
		expect(first).not.toBe(second);
		expect(first.startsWith(`${snapCommonDir()}${path.sep}`)).toBe(true);
		expect(first).not.toBe(firstRequested);
	});
});

describe("Snap Chromium shared profile", () => {
	test("keeps the shared profile inside the Snap common directory", async () => {
		const executablePath = await ensureChromiumExecutable();
		if (!isSnapHost(executablePath)) return;

		const requestedProfile = path.join(
			os.homedir(),
			".proto",
			"run",
			"daemons",
			"0123456789abcdef",
			"proto.browser.headless.profile",
		);
		const launch = await resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: requestedProfile });
		const profileArg = launch?.args.find(arg => arg.startsWith("--user-data-dir="));
		expect(profileArg).toBeDefined();
		const actualProfile = profileArg?.slice("--user-data-dir=".length);
		expect(actualProfile?.startsWith(`${snapCommonDir()}${path.sep}`)).toBe(true);
		expect(actualProfile).not.toBe(requestedProfile);
		expect(launch?.userDataDir).toBe(actualProfile);
	});
});

describe("Snap Chromium launch", () => {
	test("launches with an ephemeral common-directory profile and cleans it up", async () => {
		const executablePath = await ensureChromiumExecutable();
		if (!isSnapHost(executablePath)) return;

		const launched = await launchHeadlessBrowser({ headless: true });
		const userDataDir = launched.userDataDir;
		expect(userDataDir?.startsWith(`${snapCommonDir()}${path.sep}`)).toBe(true);
		try {
			const page = await launched.browser.newPage();
			await page.goto("data:text/html,<title>proto-snap-smoke</title>");
			expect(await page.title()).toBe("proto-snap-smoke");
			await page.close();
		} finally {
			await launched.browser.close();
			if (userDataDir) {
				await removeUserDataDir(userDataDir);
				await expect(fs.stat(userDataDir)).rejects.toThrow();
			}
		}
	}, 60_000);

	test("preserves an explicit caller-owned user-data-dir", async () => {
		const executablePath = await ensureChromiumExecutable();
		if (!isSnapHost(executablePath)) return;

		const explicitUserDataDir = await fs.mkdtemp(path.join(snapCommonDir(), "proto-explicit-profile-"));
		const launched = await launchHeadlessBrowser({
			headless: true,
			args: [`--user-data-dir=${explicitUserDataDir}`],
		});
		try {
			expect(launched.userDataDir).toBeUndefined();
			const page = await launched.browser.newPage();
			await page.goto("data:text/html,<title>proto-explicit-snap-smoke</title>");
			expect(await page.title()).toBe("proto-explicit-snap-smoke");
			await page.close();
		} finally {
			await launched.browser.close();
			expect((await fs.stat(explicitUserDataDir)).isDirectory()).toBe(true);
			await removeUserDataDir(explicitUserDataDir);
			await expect(fs.stat(explicitUserDataDir)).rejects.toThrow();
		}
	}, 60_000);

	test("starts the shared browser daemon with a unique owned project profile", async () => {
		const executablePath = await ensureChromiumExecutable();
		if (!isSnapHost(executablePath)) return;

		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-snap-shared-smoke-"));
		const client = await daemonClientForProject(projectDir);
		const requestedProfile = path.join(daemonRuntimeDir(client.projectDir), "proto.browser.headless.profile");
		const userDataDir = resolveChromiumUserDataDir(executablePath, requestedProfile);
		try {
			const shared = await ensureSharedBrowser({ projectDir, headless: true });
			expect(shared).not.toBeNull();
			expect(userDataDir.startsWith(`${snapCommonDir()}${path.sep}`)).toBe(true);
			if (!shared) throw new Error("shared browser did not become ready");

			const puppeteer = await loadPuppeteer();
			const browser = await puppeteer.connect({
				browserWSEndpoint: shared.wsEndpoint,
				defaultViewport: null,
			});
			try {
				const page = await browser.newPage();
				await page.goto("data:text/html,<title>proto-shared-snap-smoke</title>");
				expect(await page.title()).toBe("proto-shared-snap-smoke");
				await page.close();
			} finally {
				browser.disconnect();
			}
		} finally {
			await client.request({ op: "stop", name: "proto.browser.headless", timeoutMs: 5_000 }).catch(() => undefined);
			client.close();
			await removeUserDataDir(userDataDir);
			await fs.rm(path.dirname(userDataDir), { recursive: true, force: true });
			await fs.rm(daemonRuntimeDir(client.projectDir), { recursive: true, force: true });
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	}, 90_000);
});

test("loading Puppeteer never moves the process out of the project directory", async () => {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "proto-puppeteer-cwd-"));
	try {
		await Bun.write(path.join(project, "marker"), "");
		const script = [
			'import * as fs from "node:fs";',
			`import { loadPuppeteer } from ${JSON.stringify(path.join(import.meta.dir, "launch.ts"))};`,
			"let moved = false;",
			'const probe = setInterval(() => { if (!fs.existsSync("marker")) moved = true; }, 0);',
			"await loadPuppeteer();",
			"clearInterval(probe);",
			"process.stdout.write(JSON.stringify({ moved, cwd: process.cwd() }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: project,
			env: { ...process.env, PI_CODING_AGENT_DIR: path.join(project, "agent") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ moved: false, cwd: fsSync.realpathSync(project) });
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});
