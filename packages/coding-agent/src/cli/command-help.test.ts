import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

function help(...args: string[]): string {
	const result = Bun.spawnSync([process.execPath, cli, ...args, "--help"], {
		env: { ...process.env, NO_COLOR: "1" },
	});
	expect(result.exitCode).toBe(0);
	expect(result.stderr.toString()).toBe("");
	return result.stdout.toString();
}

describe("CLI command help", () => {
	test.each([
		["agents", "--project"],
		["attach", "--stop"],
		["auth-broker", "--bind"],
		["auth-gateway", "--bind"],
		["bench", "--runs"],
		["browser-relay", "--port"],
		["commit", "--dry-run"],
		["completions", "Target shell"],
		["compress", "--model"],
		["config", "--json"],
		["dry-balance", "--count"],
		["gallery", "--screenshot"],
		["grep", "--context"],
		["grievances", "--json"],
		["images", "--json"],
		["install", "--scope"],
		["plugin", "--scope"],
		["ps", "--json"],
		["read", "ARGUMENTS"],
		["render", "--repaint"],
		["shell", "--no-snapshot"],
		["ssh", "--host"],
		["tiny-models", "--json"],
		["token", "--force-refresh"],
		["ttsr", "--source"],
		["update", "--check"],
		["usage", "--history"],
		["search", "--recency"],
		["worktree", "--dry-run"],
	])("%s documents its invocation", (command, detail) => {
		const output = help(command);
		expect(output).toContain(`$ proto ${command}`);
		expect(output).toContain(detail);
	});

	test("render documents session arguments and runnable examples", () => {
		const output = help("render");
		expect(output).toContain("[SESSION] [FLAGS]");
		expect(output).toContain("Session file path or id prefix");
		expect(output).toContain("EXAMPLES");
		expect(output).toContain("proto render 01a0285c --plain");
	});

	test("command aliases display canonical help", () => {
		expect(help("img")).toBe(help("images"));
		expect(help("wt")).toBe(help("worktree"));
		expect(help("q")).toBe(help("search"));
	});

	test("root help names the product Proto and executable proto", () => {
		const output = help();
		expect(output).toContain("$ proto [COMMAND]");
		expect(output).toContain("Import a Claude Code session into Proto");
		expect(output).toContain("Import a Codex session into Proto");
	});
});

test.each([
	["render", "width", "0"],
	["render", "height", "-1"],
	["render", "repaint", "0"],
	["gallery", "width", "0"],
	["gallery", "width", "-1"],
	["render", "width", "9007199254740992"],
])("%s rejects invalid --%s=%s with usage, not a stack trace", (command, flag, value) => {
	const result = Bun.spawnSync([process.execPath, cli, command, `--${flag}=${value}`], {
		env: { ...process.env, NO_COLOR: "1" },
	});
	expect(result.exitCode).toBe(1);
	expect(result.stdout.toString()).toBe("");
	expect(result.stderr.toString()).toBe(
		`error: --${flag} must be a positive integer\n\nUSAGE\n  $ proto ${command}${command === "render" ? " [SESSION]" : ""} [FLAGS]\n\nRun \`proto ${command} --help\` for details.\n`,
	);
});
