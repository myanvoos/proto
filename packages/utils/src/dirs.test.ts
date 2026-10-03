import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	APP_NAME,
	directoryIsEnterable,
	directoryIsMissing,
	getLogPath,
	getProjectDir,
	getWorktreesDir,
	pathIsWithin,
	relativePathWithinRoot,
	setProjectDir,
	setWorktreesDir,
} from "./dirs";

const tempDirs: string[] = [];

async function makeTree(...children: string[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-utils-dirs-"));
	tempDirs.push(root);
	await Promise.all(children.map(child => fs.mkdir(path.join(root, child), { recursive: true })));
	return root;
}

afterAll(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("pathIsWithin", () => {
	test("accepts children whose name begins with dots but does not traverse upward", async () => {
		const root = await makeTree("..foo", "...bar", "normal", "..foo/nested");

		// Regression: a leading `..` in the relative path only escapes the root when it
		// is a whole path segment. `..foo` is an ordinary child directory.
		expect(pathIsWithin(root, path.join(root, "..foo"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "...bar"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "..foo", "nested"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "normal"))).toBe(true);
		expect(pathIsWithin(root, root)).toBe(true);
	});

	test("rejects paths that traverse above the root", async () => {
		const root = await makeTree("child");
		const parent = path.dirname(root);

		expect(pathIsWithin(root, parent)).toBe(false);
		expect(pathIsWithin(path.join(root, "child"), root)).toBe(false);
	});
});

describe("relativePathWithinRoot", () => {
	test("returns the relative path for dot-prefixed children instead of null", async () => {
		const root = await makeTree("..foo/nested");

		expect(relativePathWithinRoot(root, path.join(root, "..foo", "nested"))).toBe(path.join("..foo", "nested"));
		expect(relativePathWithinRoot(root, path.dirname(root))).toBeNull();
	});
});

describe("worktree base expansion", () => {
	test("expands both accepted tilde forms to a real home-relative path", () => {
		// Regression: `~\\wt` used to be concatenated verbatim, leaving the backslash as
		// a literal filename character on POSIX (`/home/u\\wt`).
		for (const input of ["~/wt", "~\\wt"]) {
			setWorktreesDir(input);
			expect(getWorktreesDir()).toBe(path.join(os.homedir(), "wt"));
		}
		setWorktreesDir("~");
		expect(getWorktreesDir()).toBe(os.homedir());
		setWorktreesDir(undefined);
	});
});

describe("project directory adoption", () => {
	test("a directory whose own search permission is denied exists but is not enterable", async () => {
		if (process.getuid?.() === 0) return; // root bypasses permission bits
		const root = await makeTree("denied");
		const denied = path.join(root, "denied");
		await fs.chmod(denied, 0o600);
		try {
			expect(await directoryIsMissing(denied)).toBe(false);
			expect(await directoryIsEnterable(denied)).toBe(false);
			expect(await directoryIsEnterable(root)).toBe(true);
			expect(await directoryIsMissing(path.join(root, "absent"))).toBe(true);
		} finally {
			await fs.chmod(denied, 0o700);
		}
	});

	test("a failed chdir keeps the previous project directory", () => {
		const before = getProjectDir();
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});
		try {
			expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
			expect(getProjectDir()).toBe(before);
		} finally {
			chdir.mockRestore();
		}
	});
});

describe("dated log path", () => {
	test("names the file with the local day, matching the rotating sink", () => {
		const date = new Date(2026, 4, 31, 0, 30);
		expect(path.basename(getLogPath(date, 123))).toBe("proto.2026-05-31.123.log");
	});
});

describe("global daemon runtime root", () => {
	test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"follows an initialized $XDG_STATE_HOME and is shared across profiles and custom agent dirs",
		async () => {
			const root = await makeTree();
			const xdgState = path.join(root, "state");
			await fs.mkdir(path.join(xdgState, APP_NAME), { recursive: true });
			const dirsModule = path.join(import.meta.dir, "dirs.ts");
			const script = [
				`import { getGlobalDaemonRuntimeDir, setAgentDir, setProfile } from ${JSON.stringify(dirsModule)};`,
				`const seen = [getGlobalDaemonRuntimeDir("relay")];`,
				`setProfile("profile-a");`,
				`seen.push(getGlobalDaemonRuntimeDir("relay"));`,
				`setProfile(undefined);`,
				`setAgentDir(${JSON.stringify(path.join(root, "custom-agent"))});`,
				`seen.push(getGlobalDaemonRuntimeDir("relay"));`,
				`process.stdout.write(JSON.stringify(seen));`,
			].join("\n");
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: root,
				XDG_STATE_HOME: xdgState,
				PI_CONFIG_DIR: ".proto-dirs-test",
			};
			delete env.PI_CODING_AGENT_DIR;
			delete env.PROTO_PROFILE;
			delete env.PI_PROFILE;
			const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			const shared = path.join(xdgState, APP_NAME, "run", "daemons", "global", "relay");
			expect(JSON.parse(stdout)).toEqual([shared, shared, shared]);
		},
	);
});
