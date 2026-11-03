import { expect, test } from "bun:test";
import { collectBundledHostEntries } from "./host-virtual-module";

test("compiled extensions can resolve catalog build and TUI root, nested, and index module keys", async () => {
	const entries = await collectBundledHostEntries();
	const keys = new Set(entries.map(entry => entry.key));
	for (const key of [
		"@oh-my-pi/pi-catalog/build",
		"@oh-my-pi/pi-tui/terminal-capabilities",
		"@oh-my-pi/pi-tui/components/editor",
	]) {
		const entry = entries.find(candidate => candidate.key === key);
		expect(entry?.importSpecifier).toBe(key);
		expect(Bun.resolveSync(key, import.meta.dir)).toEndWith(".ts");
	}
	// A registry catch-all must never load the CLI or worker entry on the main thread.
	expect(keys.has("@oh-my-pi/pi-coding-agent/cli")).toBe(false);
	expect(keys.has("@oh-my-pi/pi-coding-agent/main")).toBe(false);
	expect(keys.has("@oh-my-pi/pi-catalog/provider-models/index")).toBe(true);
	expect(entries.some(entry => entry.key.endsWith("/worker-entry"))).toBe(false);
});
