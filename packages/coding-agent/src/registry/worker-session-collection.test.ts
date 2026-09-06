import { expect, test } from "bun:test";
import * as path from "node:path";

test("parking and terminating revived workers release their live session graphs", async () => {
	const script = path.resolve(import.meta.dir, "../../scripts/bench-worker-lifecycle-memory.ts");
	const child = Bun.spawn(
		[process.execPath, "--expose-gc", script, "--child", "--workers", "1", "--payload-kib", "16"],
		{ stdout: "pipe", stderr: "pipe", timeout: 30_000 },
	);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
			new Response(child.stderr as ReadableStream<Uint8Array>).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const measurement = JSON.parse(stdout) as {
			collectibleOriginalSessionsAfterPark: number;
			collectibleRevivedSessionsAfterRelease: number;
		};
		expect(measurement.collectibleOriginalSessionsAfterPark).toBe(1);
		expect(measurement.collectibleRevivedSessionsAfterRelease).toBe(1);
	} finally {
		if (child.exitCode === null) child.kill();
	}
}, 35_000);
