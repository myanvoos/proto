import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "../modes/types";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "./builtin-registry";

function fakeCtx(calls: string[]): InteractiveModeContext {
	return {
		editor: { setText: (text: string) => calls.push(`editor:${text}`) },
		showStatus: (text: string) => calls.push(`status:${text}`),
		updateAndRestart: () => calls.push("updateAndRestart"),
	} as unknown as InteractiveModeContext;
}

describe("/update builtin", () => {
	it("clears the editor draft and routes to updateAndRestart", async () => {
		const calls: string[] = [];
		expect(await executeBuiltinSlashCommand("/update", { ctx: fakeCtx(calls) })).toBe(true);
		expect(calls).toEqual(["editor:", "updateAndRestart"]);
	});

	it("rejects arguments instead of relaunching with them", async () => {
		const calls: string[] = [];
		expect(await executeBuiltinSlashCommand("/update --force", { ctx: fakeCtx(calls) })).toBe(true);
		expect(calls).toEqual(["status:/update does not take arguments"]);
	});

	it("is registered as a reserved builtin name", () => {
		expect(lookupBuiltinSlashCommand("update")?.description).toBe(
			"Update proto, then resume this session in the new version",
		);
	});
});
