import { afterEach, beforeEach, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { runSetupWizard } from "./index";
import { providersSetupScene } from "./scenes/providers";

let auth: AuthStorage;
let ctx: InteractiveModeContext;
let overlayVisible: boolean;
let mounted: Component | undefined;

beforeEach(async () => {
	initThemeSync();
	auth = await AuthStorage.create(":memory:");
	overlayVisible = false;
	mounted = undefined;
	ctx = {
		settings: Settings.isolated(),
		session: { modelRegistry: { authStorage: auth, async refreshProvider() {} } },
		ui: {
			terminal: { rows: 24 },
			requestRender() {},
			setFocus() {},
			showOverlay(component: Component) {
				mounted = component;
				overlayVisible = true;
				return {
					hide() {
						overlayVisible = false;
					},
				};
			},
		},
	} as unknown as InteractiveModeContext;
});

afterEach(() => {
	auth.close();
});

/** Drives the wizard the way a terminal would: feed keys to the overlay it mounted. */
function press(...keys: string[]): void {
	expect(mounted).toBeDefined();
	for (const key of keys) mounted?.handleInput?.(key);
}

test("ctrl+c leaves setup unfinished instead of recording a setup version", async () => {
	const run = runSetupWizard(ctx, [providersSetupScene]);
	press("\x03");
	expect(await run).toBe("cancelled");
	expect(ctx.settings.get("setupVersion")).toBe(0);
	expect(overlayVisible).toBe(false);
});

test("walking every scene records the setup version", async () => {
	const run = runSetupWizard(ctx, [providersSetupScene]);
	press("\x1b");
	expect(await run).toBe("completed");
	expect(ctx.settings.get("setupVersion")).toBeGreaterThan(0);
});

test("a cancelled partial run cannot mark full setup complete", async () => {
	const run = runSetupWizard(ctx, [providersSetupScene], { markComplete: false });
	press("\x03");
	expect(await run).toBe("cancelled");
	expect(ctx.settings.get("setupVersion")).toBe(0);
});

test("a completed partial run still leaves full setup pending", async () => {
	const run = runSetupWizard(ctx, [providersSetupScene], { markComplete: false });
	press("\x1b");
	expect(await run).toBe("completed");
	expect(ctx.settings.get("setupVersion")).toBe(0);
});
