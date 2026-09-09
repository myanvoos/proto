import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { Shell } from "@oh-my-pi/pi-natives";
import { executeBash } from "./bash-executor";

afterEach(() => {
	vi.restoreAllMocks();
});

test("keeps raw failure diagnostics when minimized output cannot be persisted", async () => {
	const rawOutput =
		"src/event-cache.ts:281:5 error TS2304 Cannot find name 'foo'\n" +
		"src/event-cache.ts:300:9 error TS2345 Argument of type 'string' is not assignable\n";
	spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, _options, onChunk) {
		onChunk?.(null, rawOutput);
		return Promise.resolve({
			exitCode: 1,
			cancelled: false,
			timedOut: false,
			workingDir: process.cwd(),
			fsObservations: [],
			xdDispatches: [],
			minimized: {
				filter: "lint",
				text: "src/event-cache.ts:281-405 multiple ... errors\n",
				originalText: rawOutput,
				inputBytes: Buffer.byteLength(rawOutput, "utf-8"),
				outputBytes: 52,
			},
		});
	});

	const result = await executeBash("pnpm lint", {
		sessionKey: `bash-executor-minimized-save-${crypto.randomUUID()}`,
		onMinimizedSave: async () => undefined,
	});

	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("TS2304 Cannot find name 'foo'");
	expect(result.output).not.toContain("multiple ... errors");
});
