import { expect, test } from "bun:test";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function describeBash(options: { launch: boolean; fleetActive: boolean; fleetMounted: boolean }): string {
	const session = {
		cwd: process.cwd(),
		settings: {
			get: (key: string) => (key === "launch.enabled" ? options.launch : undefined),
			getShellConfig: () => ({ env: {} }),
		},
		isToolActive: (name: string) => name === "fleet" && options.fleetActive,
		xdev: {
			tools: new Map(),
			mountedNames: new Set(options.fleetMounted ? ["fleet"] : []),
			builtInNames: new Set(),
			isActive: () => false,
		},
	} as unknown as ToolSession;
	return new BashTool(session).description;
}

test("bash docs route services to fleet through whichever surface exposes it", () => {
	// Demoted to an xd device, fleet is no longer an active top-level tool but still supervises processes.
	const viaDevice = describeBash({ launch: true, fleetActive: false, fleetMounted: true });
	expect(viaDevice).toContain("`xd fleet --op start`");

	const viaTool = describeBash({ launch: true, fleetActive: true, fleetMounted: false });
	expect(viaTool).toContain('`fleet` (`op:"start"`)');
	expect(viaTool).not.toContain("xd fleet");

	// With process supervision disabled, fleet start fails, so the docs must not route there.
	const disabled = describeBash({ launch: false, fleetActive: true, fleetMounted: true });
	expect(disabled).not.toContain('op:"start"');
	expect(disabled).not.toContain("fleet --op start");
});
