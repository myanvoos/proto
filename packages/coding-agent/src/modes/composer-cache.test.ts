import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("composer startup cache", () => {
	it("loads XDG_CACHE_HOME from the home .env before the first cache access", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-composer-cache-dotenv-"));
		const home = path.join(root, "home");
		const xdgCache = path.join(root, "xdg-cache");
		const project = path.join(root, "project");
		try {
			await Promise.all([
				fs.mkdir(home, { recursive: true }),
				fs.mkdir(path.join(xdgCache, "proto"), { recursive: true }),
			]);
			await Bun.write(path.join(home, ".env"), `XDG_CACHE_HOME=${xdgCache}\n`);

			const composerCacheModule = path.resolve(import.meta.dir, "composer-cache.ts");
			const script = [
				'import * as path from "node:path";',
				`import { writeComposerWelcomeCache } from ${JSON.stringify(composerCacheModule)};`,
				`const project = ${JSON.stringify(project)};`,
				'await writeComposerWelcomeCache(project, { modelName: "model", providerName: "provider" });',
				'const key = Bun.hash.wyhash(path.resolve(project)).toString(16).padStart(16, "0");',
				`const expected = path.join(${JSON.stringify(xdgCache)}, "proto", "cache", "composer", key, "welcome.json");`,
				"process.stdout.write(String(await Bun.file(expected).exists()));",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
				cwd: root,
				env: {
					...process.env,
					HOME: home,
					XDG_CACHE_HOME: undefined,
					PI_CODING_AGENT_DIR: undefined,
					PI_CONFIG_DIR: undefined,
					PROTO_PROFILE: undefined,
					PI_PROFILE: undefined,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("true");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
