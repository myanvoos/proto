import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * Contract: `/quit` and `/exit` do not wait on an unresponsive OTLP collector.
 * The probe's collector accepts the log export and never answers, so an
 * unbounded shutdown export would hold the process open instead of exiting.
 */
describe("OTLP shutdown", () => {
	it("releases the process promptly when a collector accepts logs but never responds", async () => {
		const probe = fileURLToPath(new URL("../test/fixtures/otel-shutdown-probe.ts", import.meta.url));
		const proc = Bun.spawn([process.execPath, probe], {
			env: { ...process.env },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
		});
		expect(await proc.exited).toBe(0);
	}, 15_000);
});
