import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner } from "./context-manager";
import { executeJs } from "./executor";

for (const runtime of ["bun", "node"] as const) {
	test(`${runtime} syntax errors identify original cell positions without replacing runtime errors`, async () => {
		using temp = TempDir.createSync("@cell-diagnostics-");
		const owner = `cell-diagnostics:${crypto.randomUUID()}`;
		const session = { cwd: temp.path(), settings: Settings.isolated({}) } as ToolSession;
		const options = { runtime, cwd: temp.path(), session, sessionId: owner, kernelOwnerId: owner };
		try {
			const invalid = await executeJs("const before = 1;\nconst broken = ;", options);
			expect(invalid.exitCode).toBe(1);
			expect(invalid.output).toContain("line 2, column 16");
			expect(invalid.output).toContain("const broken = ;");
			expect(invalid.output).toContain("^");
			const recovered = await executeJs("break;", options);
			expect(recovered.output).toContain("line 1, column 1");
			const native = await executeJs('JSON.parse("bad-json")', options);
			expect(native.exitCode).toBe(1);
			expect(native.output).not.toContain("line 1, column");
		} finally {
			await disposeVmContextsByOwner(owner);
		}
	}, 30_000);

	test(`${runtime} awaited cells retain block vars without changing catch parameter bindings`, async () => {
		using temp = TempDir.createSync("@cell-var-bindings-");
		const owner = `cell-bindings:${crypto.randomUUID()}`;
		const session = { cwd: temp.path(), settings: Settings.isolated({}) } as ToolSession;
		const options = { runtime, cwd: temp.path(), session, sessionId: owner, kernelOwnerId: owner };
		try {
			const seeded = await executeJs(
				'await Promise.resolve(); if (true) { var blockValue = 7; } var caught = "outer"; try { throw "inner"; } catch (caught) { var caught = "updated"; console.log(caught); }',
				options,
			);
			expect(seeded.exitCode).toBe(0);
			expect(seeded.output).toContain("updated");
			const retained = await executeJs("console.log(blockValue, caught)", options);
			expect(retained.output).toContain("7 outer");
		} finally {
			await disposeVmContextsByOwner(owner);
		}
	}, 30_000);
}
