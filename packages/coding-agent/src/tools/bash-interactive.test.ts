import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { PtySession } from "@oh-my-pi/pi-natives";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "../config/keybindings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";
import { OutputSink } from "../session/streaming-output";
import { runInteractiveBashPty } from "./bash-interactive";

let mounted: Component | undefined;

function testUi(): ExtensionUIContext {
	async function custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> {
		const completion = Promise.withResolvers<T>();
		const tui = {
			terminal: { rows: 24, columns: 80 },
			requestRender: () => {},
		} as unknown as TUI;
		mounted = await factory(tui, {} as Theme, {} as KeybindingsManager, completion.resolve);
		return await completion.promise;
	}
	return { custom } as unknown as ExtensionUIContext;
}

afterEach(() => {
	mounted?.dispose?.();
	mounted = undefined;
	vi.restoreAllMocks();
});

test("PTY sink finalization failure completes the overlay with a bounded error result", async () => {
	spyOn(PtySession.prototype, "start").mockResolvedValue({ exitCode: 0, cancelled: false, timedOut: false });
	spyOn(PtySession.prototype, "kill").mockImplementation(() => {});
	spyOn(OutputSink.prototype, "dump").mockRejectedValue(new Error("sink exploded"));

	const run = runInteractiveBashPty(testUi(), { command: "printf ok", cwd: process.cwd() });
	// This real deadline is the contract: the regression leaves the UI promise permanently unsettled, with no clock seam.
	const bounded = await Promise.race([
		run.then(result => ({ kind: "result" as const, result })),
		Bun.sleep(1_000).then(() => ({ kind: "timeout" as const })),
	]);

	expect(bounded.kind).toBe("result");
	if (bounded.kind !== "result") return;
	expect(bounded.result.exitCode).toBeUndefined();
	expect(bounded.result.output).toContain("PTY finalization failed: sink exploded");
	expect(bounded.result.collector).toEqual({ state: "failed", error: "sink exploded" });
}, 5_000);
