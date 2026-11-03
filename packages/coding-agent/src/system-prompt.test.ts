import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSystemPrompt, composeAppendPrompt } from "./system-prompt";
import "./discovery";

const MCP_SECTION =
	"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.\n\n### codegraph\nUse codegraph.";

test("user append text gets its own section instead of trailing the MCP server instructions", () => {
	const composed = composeAppendPrompt(["auto-learn guidance", MCP_SECTION], "Reply in English.")!;
	const boundary = composed.indexOf("\n## User Instructions\n\n");
	expect(boundary).toBeGreaterThan(composed.indexOf("### codegraph"));
	expect(composed.slice(0, boundary)).not.toContain("Reply in English.");
	expect(composed.endsWith("Reply in English.")).toBe(true);
});

test("user append Markdown and template-like text survive framing byte-for-byte", () => {
	const user = "Keep this hard break.  \nNext line.\n\n\n| left | right |\n{{literal}} <user> & value\n";
	const composed = composeAppendPrompt([MCP_SECTION], user)!;
	expect(composed.startsWith(`${MCP_SECTION}\n\n## User Instructions\n\n`)).toBe(true);
	expect(composed.slice(-user.length)).toBe(user);
});

test("a lone or blank user append adds no heading", () => {
	expect(composeAppendPrompt([], "Only me.")).toBe("Only me.");
	expect(composeAppendPrompt([MCP_SECTION], "  \n")).toBe(MCP_SECTION);
	expect(composeAppendPrompt([], undefined)).toBeUndefined();
});

test("an explicitly empty custom prompt ignores a discovered SYSTEM.md instead of letting it hide always-apply rules", async () => {
	using tmp = TempDir.createSync("@system-prompt-empty-override-");
	const marker = "Never edit generated files. (sticky marker)";
	await Bun.write(path.join(tmp.path(), ".proto", "SYSTEM.md"), marker);
	const { systemPrompt } = await buildSystemPrompt({
		cwd: tmp.path(),
		customPrompt: "",
		alwaysApplyRules: [{ name: "sticky", path: path.join(tmp.path(), "RULES.md"), content: marker }],
		contextFiles: [],
		skills: [],
		activeRepoContext: null,
		workspaceTree: { rootPath: tmp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	expect(systemPrompt.join("\n")).toContain(marker);
});

test("disabling context discovery omits cwd, additional roots and nested AGENTS while retaining explicit context", async () => {
	using tmp = TempDir.createSync("@system-prompt-no-context-");
	const primary = path.join(tmp.path(), "primary");
	const extra = path.join(tmp.path(), "extra");
	await Bun.write(path.join(primary, "AGENTS.md"), "PRIMARY-CONTEXT-SENTINEL");
	await Bun.write(path.join(extra, "AGENTS.md"), "EXTRA-CONTEXT-SENTINEL");
	const result = await buildSystemPrompt({
		cwd: primary,
		additionalWorkspaceRoots: [extra],
		noContextFiles: true,
		skills: [],
		activeRepoContext: null,
		workspaceTree: {
			rootPath: primary,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: ["nested/AGENTS.md"],
		},
	});
	const output = result.systemPrompt.join("\n");
	expect(output).not.toContain("PRIMARY-CONTEXT-SENTINEL");
	expect(output).not.toContain("EXTRA-CONTEXT-SENTINEL");
	expect(output).not.toContain("nested/AGENTS.md");
	const explicit = await buildSystemPrompt({
		cwd: primary,
		additionalWorkspaceRoots: [extra],
		noContextFiles: true,
		contextFiles: [{ path: path.join(primary, "PINNED.md"), content: "EXPLICIT-CONTEXT-SENTINEL" }],
		skills: [],
		activeRepoContext: null,
		includeWorkspaceTree: false,
	});
	expect(explicit.systemPrompt.join("\n")).toContain("EXPLICIT-CONTEXT-SENTINEL");
});

test("subagent context exclusion filters inherited and additional-root AGENTS but retains other context files", async () => {
	using tmp = TempDir.createSync("@system-prompt-exclude-agents-");
	const extra = path.join(tmp.path(), "extra");
	await Bun.write(path.join(extra, "AGENTS.md"), "EXTRA-AGENTS-SENTINEL");

	const result = await buildSystemPrompt({
		cwd: tmp.path(),
		additionalWorkspaceRoots: [extra],
		excludeAgentsMd: true,
		contextFiles: [
			{ path: path.join(tmp.path(), "AgEnTs.Md"), content: "INHERITED-AGENTS-SENTINEL" },
			{ path: path.join(tmp.path(), "NOTES.md"), content: "INHERITED-NOTES-SENTINEL" },
		],
		skills: [],
		activeRepoContext: null,
		includeWorkspaceTree: false,
	});
	const output = result.systemPrompt.join("\n");
	expect(output).not.toContain("INHERITED-AGENTS-SENTINEL");
	expect(output).not.toContain("EXTRA-AGENTS-SENTINEL");
	expect(output).toContain("INHERITED-NOTES-SENTINEL");
	const included = await buildSystemPrompt({
		cwd: tmp.path(),
		additionalWorkspaceRoots: [extra],
		contextFiles: [],
		skills: [],
		activeRepoContext: null,
		includeWorkspaceTree: false,
	});
	expect(included.systemPrompt.join("\n")).toContain("EXTRA-AGENTS-SENTINEL");
});
