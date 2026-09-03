import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOL_NAMES } from "./builtin-names";
import { defaultLoadModeForToolName, ESSENTIAL_BUILTIN_TOOL_NAMES } from "./essential-tools";
import { isMountableUnderXdev } from "./xdev";

// Contract: only these built-ins ship their schemas as native tools on every request. Everything
// else mounts under xd:// and is dispatched from bash. If this set drifts, every session silently
// gains or loses native tool schemas.
const ALWAYS_NATIVE_TOOL_NAMES = ["bash", "ask", "todo", "web_search", "inspect_media"] as const;

describe("ESSENTIAL_BUILTIN_TOOL_NAMES", () => {
	test("contains exactly the always-native built-ins", () => {
		expect(Object.keys(ESSENTIAL_BUILTIN_TOOL_NAMES).sort()).toEqual([...ALWAYS_NATIVE_TOOL_NAMES].sort());
	});

	test("every essential name is a real built-in tool name", () => {
		for (const name of Object.keys(ESSENTIAL_BUILTIN_TOOL_NAMES)) {
			expect(BUILTIN_TOOL_NAMES as readonly string[]).toContain(name);
		}
	});
});

describe("defaultLoadModeForToolName", () => {
	test("an explicit declaration always wins, in both directions", () => {
		expect(defaultLoadModeForToolName("read", "essential")).toBe("essential");
		expect(defaultLoadModeForToolName("read", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("web_search", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("anything", "essential")).toBe("essential");
	});

	test("undeclared always-native names default to essential; every other built-in to discoverable", () => {
		for (const name of ALWAYS_NATIVE_TOOL_NAMES) {
			expect(defaultLoadModeForToolName(name), name).toBe("essential");
		}
		for (const name of BUILTIN_TOOL_NAMES) {
			if ((ALWAYS_NATIVE_TOOL_NAMES as readonly string[]).includes(name)) continue;
			expect(defaultLoadModeForToolName(name), name).toBe("discoverable");
		}
	});

	test("unknown names default to discoverable", () => {
		expect(defaultLoadModeForToolName("mcp__server__query")).toBe("discoverable");
	});
});

describe("isMountableUnderXdev", () => {
	test("never mounts the bash transport or keep-top-level names, even when declared discoverable", () => {
		for (const name of ["bash", ...ALWAYS_NATIVE_TOOL_NAMES.filter(n => n !== "bash")]) {
			expect(isMountableUnderXdev({ name, loadMode: "discoverable" }), name).toBe(false);
		}
	});

	test("mounts discoverable non-transport tools — including read — and keeps essential tools native", () => {
		expect(isMountableUnderXdev({ name: "read", loadMode: "discoverable" })).toBe(true);
		expect(isMountableUnderXdev({ name: "orchestrate_spawn", loadMode: "discoverable" })).toBe(true);
		expect(isMountableUnderXdev({ name: "orchestrate_spawn", loadMode: "essential" })).toBe(false);
		expect(isMountableUnderXdev({ name: "orchestrate_spawn" })).toBe(false);
	});
});
