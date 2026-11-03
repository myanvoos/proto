import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
	it.each(["ordinary", "persistent", "switch-to-persistent"] as const)(
		"idle compaction preserves persistent prompt caches (%s)",
		async mode => {
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
			const ordinary = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!ordinary) throw new Error("Expected bundled model");
			const persistent: Model = {
				...ordinary,
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api/codex",
			};
			const viewSession: {
				model: Model;
				isStreaming: boolean;
				isCompacting: boolean;
				getContextUsage: () => { tokens: number };
				runIdleCompaction: () => void;
			} = {
				model: mode === "persistent" ? persistent : ordinary,
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
			if (mode === "switch-to-persistent") viewSession.model = persistent;
			vi.advanceTimersByTime(60_000);

			expect(runIdleCompaction).toHaveBeenCalledTimes(mode === "ordinary" ? 1 : 0);
		},
	);
});
