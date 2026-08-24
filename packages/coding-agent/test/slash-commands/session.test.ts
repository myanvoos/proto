import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: { showAgentsView?: InteractiveModeContext["showAgentsView"] }) {
	const setText = vi.fn();
	const showAgentsView =
		options?.showAgentsView ??
		vi.fn((_scope?: "current" | "global") => {
			return;
		});

	return {
		setText,
		showAgentsView,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showAgentsView,
			} as InteractiveModeContext,
		},
	};
}

describe("/session slash command (TUI)", () => {
	it("opens the agents view at global scope before resolving", async () => {
		const deferred = Promise.withResolvers<void>();
		const showAgentsView = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ showAgentsView });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(showAgentsView).toHaveBeenCalledTimes(1);
		expect(showAgentsView).toHaveBeenCalledWith("global");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();
		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("passes the open result through executeBuiltinSlashCommand", async () => {
		const harness = createRuntimeHarness({
			showAgentsView: vi.fn(() => {
				throw new Error("open failed");
			}),
		});

		await expect(executeBuiltinSlashCommand("/session", harness.runtime)).rejects.toThrow("open failed");
	});
});

describe("/agents slash command (TUI)", () => {
	it("opens the agents view scoped at the current session subtree", async () => {
		const harness = createRuntimeHarness();
		await executeBuiltinSlashCommand("/agents", harness.runtime);

		expect(harness.showAgentsView).toHaveBeenCalledTimes(1);
		expect(harness.showAgentsView).toHaveBeenCalledWith("current");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
