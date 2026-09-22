import { expect, test } from "bun:test";
import type { ToolSession } from ".";
import { CheckpointTool, RewindTool } from "./checkpoint";
import { type XdevState, xdevEntries } from "./xdev";

// Contract: the device catalog line is the only description the model reads when checkpoint is
// mounted but not loaded. CheckpointTool/RewindTool capture conversation state only — they never
// invoke git and never touch the working tree — so the catalog must not promise a git checkpoint.
function catalog(): Map<string, string> {
	const session = {} as unknown as ToolSession;
	const tools = [new CheckpointTool(session), new RewindTool(session)];
	const state: XdevState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(tools.map(tool => tool.name)),
		isActive: () => false,
	};
	return new Map(xdevEntries(state).map(entry => [entry.name, entry.summary]));
}

test("the mounted checkpoint device never advertises git", () => {
	const summaries = catalog();
	const checkpoint = summaries.get("checkpoint") ?? "";
	expect(checkpoint).not.toMatch(/git/i);
	expect(checkpoint.toLowerCase()).toContain("context");
	expect(checkpoint.toLowerCase()).toContain("rewind");
	expect(summaries.get("rewind") ?? "").not.toMatch(/git/i);
});

test("the loaded checkpoint descriptions never mention git either", () => {
	const session = {} as unknown as ToolSession;
	expect(new CheckpointTool(session).description).not.toMatch(/\bgit\b/i);
	expect(new RewindTool(session).description).not.toMatch(/\bgit\b/i);
});
