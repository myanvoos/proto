import { expect, test } from "bun:test";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function describeBash(options: { launch: boolean; jobsActive: boolean; jobsMounted: boolean }): string {
	const session = {
		cwd: process.cwd(),
		settings: {
			get: (key: string) => (key === "launch.enabled" ? options.launch : undefined),
			getShellConfig: () => ({ env: {} }),
		},
		isToolActive: (name: string) => name === "jobs" && options.jobsActive,
		xdev: {
			tools: new Map(),
			mountedNames: new Set(options.jobsMounted ? ["jobs"] : []),
			builtInNames: new Set(),
			isActive: () => false,
		},
	} as unknown as ToolSession;
	return new BashTool(session).description;
}

test("bash docs route services to jobs through whichever surface exposes it", () => {
	// Demoted to an xd device, jobs is no longer an active top-level tool but still supervises processes.
	const viaDevice = describeBash({ launch: true, jobsActive: false, jobsMounted: true });
	expect(viaDevice).toContain("`xd jobs --op start`");

	const viaTool = describeBash({ launch: true, jobsActive: true, jobsMounted: false });
	expect(viaTool).toContain('`jobs` (`op:"start"`)');
	expect(viaTool).not.toContain("xd jobs --op start");

	// With process supervision disabled, jobs start fails, so the docs must not route there.
	const disabled = describeBash({ launch: false, jobsActive: true, jobsMounted: true });
	expect(disabled).not.toContain('op:"start"');
	expect(disabled).not.toContain("jobs --op start");
});
