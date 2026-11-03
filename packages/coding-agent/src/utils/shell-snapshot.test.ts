import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOrCreateSnapshot } from "./shell-snapshot";

async function createHome(root: string, name: string): Promise<string> {
	const home = path.join(root, name);
	await fs.mkdir(home, { recursive: true });
	await Bun.write(path.join(home, ".bashrc"), 'probe_marker() { printf "%s\\n" "$SESSION_MARKER"; }\n');
	return home;
}

test("snapshot caching isolates HOME, PATH, and function-referenced environment", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-snapshot-env-"));
	try {
		const firstHome = await createHome(root, "first");
		const secondHome = await createHome(root, "second");
		const firstPath = "/snapshot/first/bin:/usr/bin:/bin";
		const secondPath = "/snapshot/second/bin:/usr/bin:/bin";
		const thirdPath = "/snapshot/third/bin:/usr/bin:/bin";

		const first = await getOrCreateSnapshot("/bin/bash", {
			HOME: firstHome,
			PATH: firstPath,
			SESSION_MARKER: "first-marker",
		});
		const second = await getOrCreateSnapshot("/bin/bash", {
			HOME: secondHome,
			PATH: secondPath,
			SESSION_MARKER: "second-marker",
		});
		const third = await getOrCreateSnapshot("/bin/bash", {
			HOME: secondHome,
			PATH: thirdPath,
			SESSION_MARKER: "third-marker",
		});

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(third).not.toBeNull();
		expect(new Set([first, second, third]).size).toBe(3);
		const [firstContent, secondContent, thirdContent] = await Promise.all([
			Bun.file(first!).text(),
			Bun.file(second!).text(),
			Bun.file(third!).text(),
		]);
		expect(firstContent).toContain(firstPath);
		expect(firstContent).toContain("first-marker");
		expect(secondContent).toContain(secondPath);
		expect(secondContent).toContain("second-marker");
		expect(thirdContent).toContain(thirdPath);
		expect(thirdContent).toContain("third-marker");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("concurrent snapshot requests source an rc once and failed sources are retried after an rc edit", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-snapshot-concurrent-"));
	try {
		const home = await createHome(root, "home");
		const count = path.join(home, "sourced");
		await Bun.write(path.join(home, ".bashrc"), `printf x >> '${count}'\nprobe_marker() { printf ready; }\n`);
		const env = { HOME: home, PATH: "/usr/bin:/bin" };
		const snapshots = await Promise.all(Array.from({ length: 4 }, () => getOrCreateSnapshot("/bin/bash", env)));
		expect(snapshots.every(snapshot => snapshot === snapshots[0])).toBe(true);
		expect(await Bun.file(count).text()).toBe("x");
		await Bun.write(path.join(home, ".bashrc"), `printf y >> '${count}'\nexit 1\n`);
		expect(await getOrCreateSnapshot("/bin/bash", env)).toBeNull();
		expect(await getOrCreateSnapshot("/bin/bash", env)).toBeNull();
		expect(await Bun.file(count).text()).toBe("xy");
		await Bun.write(path.join(home, ".bashrc"), `printf z >> '${count}'\nprobe_marker() { printf repaired; }\n`);
		const repaired = await getOrCreateSnapshot("/bin/bash", env);
		expect(await Bun.file(repaired!).text()).toContain("repaired");
		expect(await Bun.file(count).text()).toBe("xyz");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("snapshot preserves private hyphenated function dependencies but not core command overrides", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-closure-"));
	try {
		await Bun.write(
			path.join(home, ".bashrc"),
			[
				"__private-helper() { printf 'closure-ok'; }",
				"public_wrapper() { __private-helper; }",
				"ls() { printf 'wrong-core-command'; }",
				'grep() { command grep "$@"; }',
				"alias ls='wrong-alias'",
			].join("\n"),
		);
		const snapshot = await getOrCreateSnapshot("/bin/bash", { HOME: home, PATH: "/usr/bin:/bin" });
		expect(snapshot).not.toBeNull();
		const child = Bun.spawn(
			[
				"/bin/bash",
				"--noprofile",
				"--norc",
				"-c",
				'source "$1"; public_wrapper; printf "\\n%s" "$(type -t ls)"',
				"snapshot-test",
				snapshot!,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(output).toBe("closure-ok\nfile");
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
});
