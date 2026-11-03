import { expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AdvisorConfig, WatchdogConfigDoc } from "../../advisor/config";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { AuthStorage } from "../../session/auth-storage";
import { initThemeSync } from "../theme/theme";
import { AdvisorConfigOverlayComponent } from "./advisor-config";

const cases: AdvisorConfig[] = [
	{ name: "default", scope: "main" },
	{ name: "default", includeReasoning: false },
	{ name: "default" },
];

test.each(cases)("saving the default advisor preserves explicit scope/reasoning settings: %j", async advisor => {
	initThemeSync();
	const auth = await AuthStorage.create(":memory:");
	try {
		const doc: WatchdogConfigDoc = { advisors: [advisor] };
		const saved = Promise.withResolvers<WatchdogConfigDoc>();
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{
				modelRegistry: new ModelRegistry(auth),
				settings: Settings.isolated(),
				scopedModels: [],
				availableToolNames: [],
			},
			"project",
			doc,
			{
				loadDoc: async () => doc,
				save: async (_scope, value) => {
					saved.resolve(value);
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		// From the first roster row, Up wraps to Close and another Up selects Save & apply.
		overlay.handleInput("\x1b[A");
		overlay.handleInput("\x1b[A");
		overlay.handleInput("\r");
		const persisted = await saved.promise;
		if (advisor.scope !== undefined || advisor.includeReasoning !== undefined)
			expect(persisted.advisors).toEqual([advisor]);
		else expect(persisted.advisors).toEqual([]);
	} finally {
		auth.close();
	}
});
