import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "../../config/settings";
import type { InteractiveModeContext } from "../types";
import { EventController } from "./event-controller";
import { SelectorController } from "./selector-controller";

let restoreSettings: (() => void) | undefined;

afterEach(() => {
	vi.useRealTimers();
	restoreSettings?.();
	restoreSettings = undefined;
});

describe("idle compaction settings", () => {
	it("arms idle compaction when it is enabled while the session is already idle", async () => {
		await Settings.init({ inMemory: true });
		const previous = settings.getGroup("compaction");
		restoreSettings = () => {
			settings.set("compaction.idleEnabled", previous.idleEnabled);
			settings.set("compaction.idleThresholdTokens", previous.idleThresholdTokens);
			settings.set("compaction.idleTimeoutSeconds", previous.idleTimeoutSeconds);
		};
		settings.set("compaction.idleThresholdTokens", 100);
		settings.set("compaction.idleTimeoutSeconds", 60);
		vi.useFakeTimers();
		const runIdleCompaction = vi.fn();
		const viewSession = {
			isStreaming: false,
			isCompacting: false,
			getContextUsage: () => ({ tokens: 500 }),
			runIdleCompaction,
		};
		const ctx = {
			viewSession,
			editor: { getText: () => "" },
			settings,
			ui: { requestComponentRender: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);
		Object.assign(ctx, { eventController: controller });

		settings.set("compaction.idleEnabled", true);
		new SelectorController(ctx).handleSettingChange("compaction.idleEnabled", true);
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
	});
});
