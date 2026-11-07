import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_FPS, maxFps, setMaxFps } from "@oh-my-pi/pi-tui/frame-rate";
import { motionEffectsEnabled, setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { DEFAULT_SPINNER_INTERVAL_MS, setSpinnerInterval, spinnerInterval } from "@oh-my-pi/pi-tui/spinner-clock";
import { parseMotionMode, resolveMotion } from "./motion-presets";
import { Settings } from "./settings";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

afterEach(() => {
	setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
	setMaxFps(DEFAULT_MAX_FPS);
	setMotionEffects(true);
});

async function settingsWith(config: string): Promise<Settings> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-motion-settings-"));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "work");
	await fs.mkdir(agentDir);
	await fs.mkdir(cwd);
	await Bun.write(path.join(agentDir, "config.yml"), config);
	return Settings.loadIsolated({ agentDir, cwd });
}

test("an explicit knob wins over the tui.motion preset", () => {
	const resolved = resolveMotion("none", { spinnerInterval: 80 });
	expect(resolved.spinnerInterval).toBe(80);
	// The preset still owns the knobs nobody set: decorative motion and shimmer stay off.
	expect(resolved.effects).toBe(false);
	expect(resolved.shimmer).toBe("disabled");
	// Presets never throttle content frames.
	expect(resolved.maxFps).toBe(DEFAULT_MAX_FPS);
});

test("tui.motion none loads as static spinners and no decorative motion", async () => {
	await settingsWith("tui:\n  motion: none\n");
	expect(spinnerInterval()).toBe(0);
	expect(motionEffectsEnabled()).toBe(false);
	expect(maxFps()).toBe(DEFAULT_MAX_FPS);
});

test("setting a governed knob explicitly re-applies it over the loaded preset", async () => {
	const settings = await settingsWith("tui:\n  motion: none\n");
	expect(spinnerInterval()).toBe(0);

	settings.override("tui.spinnerInterval", 80);
	expect(spinnerInterval()).toBe(80);
	// The rest of the preset is still in force.
	expect(motionEffectsEnabled()).toBe(false);
});

test("parseMotionMode accepts the three names case-insensitively and rejects others", () => {
	expect(parseMotionMode("FULL")).toBe("full");
	expect(parseMotionMode(" reduced ")).toBe("reduced");
	expect(parseMotionMode("none")).toBe("none");
	expect(() => parseMotionMode("fast")).toThrow();
});
