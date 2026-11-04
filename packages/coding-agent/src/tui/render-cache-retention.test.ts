import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface WrappingProbeResult {
	rows: number;
	retainedBytes: number;
}

const probePath = path.resolve(import.meta.dir, "../../test/fixtures/render-cache-retention.ts");
// Allows runtime/accounting variation while rejecting the former 27–35 MiB retained cache.
const MAX_RETAINED_BYTES = 12 * 1024 * 1024;

describe("render cache retention", () => {
	for (const mode of ["ascii", "unicode"] as const) {
		test(`wrapping many ${mode} strings keeps cold payloads bounded and exits without waiting for cache expiry`, async () => {
			const proc = Bun.spawn([process.execPath, probePath, mode], {
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result: WrappingProbeResult = JSON.parse(stdout);
			expect(result.rows).toBe(250_000);
			expect(result.retainedBytes, stdout).toBeLessThan(MAX_RETAINED_BYTES);
		}, 15_000);
	}
});
