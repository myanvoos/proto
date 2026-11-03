import { expect, test } from "bun:test";
import { __resetShellConfigCacheForTests, getShellConfig, refreshShellConfigCache } from "./procmgr";

test("a spawned shell sees the completed main-session environment instead of later in-process edits", () => {
	const name = "PROTO_CAPTURE_ENV_TEST";
	const previous = process.env[name];
	try {
		process.env[name] = "main-lifecycle-complete";
		refreshShellConfigCache();
		process.env[name] = "subagent-mutated";
		const config = getShellConfig("/bin/sh");
		const child = Bun.spawnSync([config.shell, "-c", `printf %s "$${name}"`], {
			env: config.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		expect(child.stdout.toString()).toBe("main-lifecycle-complete");
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
		__resetShellConfigCacheForTests();
	}
});
