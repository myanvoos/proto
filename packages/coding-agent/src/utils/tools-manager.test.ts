import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface FixtureResult {
	visibleDuringDownload: boolean;
	installedPaths: Array<string | undefined>;
	installedContent: string;
	streamingCounts: { metadataRequests: number; assetRequests: number };
	emptyResult?: string;
	emptyFinalExists: boolean;
}

test("concurrent installs share one atomic validated download", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-manager-test-"));
	try {
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: dir,
			PATH: "/usr/bin:/bin",
		};
		delete env.PROTO_PROFILE;
		delete env.PI_PROFILE;
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tools-manager-concurrency.fixture.ts")], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as FixtureResult;
		expect(result.streamingCounts).toEqual({ metadataRequests: 1, assetRequests: 1 });
		expect(result.visibleDuringDownload).toBe(false);
		expect(result.installedPaths[0]).toBe(result.installedPaths[1]);
		expect(result.installedContent).toBe("#!/bin/sh\nexit 0\n");
		expect(result.emptyResult).toBeUndefined();
		expect(result.emptyFinalExists).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 10_000);
