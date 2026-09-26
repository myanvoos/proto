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

test("bash docs explain additive semantics without byte-stream workarounds", () => {
	const description = describeBash({ launch: true, jobsActive: false, jobsMounted: true });
	expect(description).toContain("Ordinary interpreter code, retained state, additive tools.");
	expect(description).toContain("presentation sidebands");
	expect(description).toContain("no `_ =` / `void` suppression is needed");
	expect(description).toContain("Ordinary synchronous Python cells support `asyncio.run()`");
	expect(description).toContain("Program arguments stay in the kernel");
	expect(description).toContain("Persistence is not a fresh OS process");
	expect(description).not.toContain("Byte-only producers:");
});

test("bash docs route services to jobs through whichever surface exposes it", () => {
	// Demoted to a protolens device, jobs is no longer an active top-level tool but still supervises processes.
	const viaDevice = describeBash({ launch: true, jobsActive: false, jobsMounted: true });
	expect(viaDevice).toContain("`protolens jobs --op start`");

	const viaTool = describeBash({ launch: true, jobsActive: true, jobsMounted: false });
	expect(viaTool).toContain('`jobs` (`op:"start"`)');
	expect(viaTool).not.toContain("protolens jobs --op start");

	// With process supervision disabled, jobs start fails, so the docs must not route there.
	const disabled = describeBash({ launch: false, jobsActive: true, jobsMounted: true });
	expect(disabled).not.toContain('op:"start"');
	expect(disabled).not.toContain("jobs --op start");
});
