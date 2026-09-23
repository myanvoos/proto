import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "../mcp/manager";
import type { McpConnectionStatusEvent } from "../mcp/startup-events";
import { Settings } from "./settings";

const CLI = path.resolve(import.meta.dir, "../cli.ts");
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeFixture(
	files: Record<string, string> = {},
): Promise<{ agentDir: string; cwd: string; root: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-config-visibility-"));
	roots.push(root);
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "work");
	await fs.mkdir(agentDir);
	await fs.mkdir(cwd);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content);
	}
	return { agentDir, cwd, root };
}

async function loadSettings(fixture: { agentDir: string; cwd: string }): Promise<Settings> {
	return await Settings.loadIsolated({ agentDir: fixture.agentDir, cwd: fixture.cwd });
}

test("a setting written as a flat dotted key is read like the nested form", async () => {
	const fixture = await makeFixture({ "profile/config.yml": "theme.dark: gruvbox\n" });
	const settings = await loadSettings(fixture);

	expect(settings.get("theme.dark")).toBe("gruvbox");
	expect(settings.getConfigIssues()).toEqual([]);
});

test("a hand-edited value of the wrong type falls back to the default and is reported", async () => {
	const fixture = await makeFixture({ "profile/config.yml": "autoResume: yes-please\n" });
	const settings = await loadSettings(fixture);

	expect(settings.get("autoResume")).toBe(false);
	const issue = settings.getConfigIssues().find(candidate => candidate.key === "autoResume");
	expect(issue?.kind).toBe("invalid-value");
	expect(issue?.message).toContain("expects a boolean");
	expect(issue?.message).toContain("yes-please");
});

test("the boolean words the config CLI accepts also work in a hand-edited config", async () => {
	const fixture = await makeFixture({ "profile/config.yml": 'autoResume: on\nstatusLine:\n  enabled: "0"\n' });
	const settings = await loadSettings(fixture);

	expect(settings.get("autoResume")).toBe(true);
	expect(settings.get("statusLine.enabled")).toBe(false);
	expect(settings.getConfigIssues()).toEqual([]);
});

test("a section that is not a setting is reported instead of silently ignored", async () => {
	const fixture = await makeFixture({
		"profile/config.yml": "appearance:\n  theme:\n    light: solarized\n",
	});
	const settings = await loadSettings(fixture);

	expect(settings.get("theme.light")).toBe("light");
	const issue = settings.getConfigIssues().find(candidate => candidate.key === "appearance");
	expect(issue?.kind).toBe("unknown-setting");
});

test("settings imported from another tool do not report unknown keys", async () => {
	const fixture = await makeFixture({
		"work/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash"] }, env: { A: "b" } }),
	});
	const settings = await loadSettings(fixture);

	expect(settings.getConfigIssues()).toEqual([]);
});

test("an invalid config is quarantined with a notice and every later run keeps reporting the backup", async () => {
	const fixture = await makeFixture({ "profile/config.yml": "theme:\n  dark: gruvbox\n  : : broken\n\t- nope\n" });

	const first = await loadSettings(fixture);
	expect(first.get("theme.dark")).toBe("proto");
	const quarantine = first.getConfigIssues().find(issue => issue.kind === "quarantined-config");
	expect(quarantine?.message).toContain("is not valid YAML");
	expect(quarantine?.message).toContain("moved aside to");

	const entries = await fs.readdir(fixture.agentDir);
	expect(entries.some(entry => entry.startsWith("config.yml.broken-"))).toBe(true);

	const second = await loadSettings(fixture);
	const leftover = second.getConfigIssues().find(issue => issue.kind === "quarantined-config");
	expect(leftover?.message).toContain("could not parse and moved aside");
	expect(second.get("theme.dark")).toBe("proto");
});

test("a legacy settings.json that cannot be parsed is reported instead of ignored forever", async () => {
	const fixture = await makeFixture({ "profile/settings.json": '{"theme": {"dark": "gruvbox"},,,}' });

	const first = await loadSettings(fixture);
	const issue = first.getConfigIssues().find(candidate => candidate.kind === "unmigrated-legacy");
	expect(issue?.message).toContain("is not valid JSON");

	const second = await loadSettings(fixture);
	expect(second.getConfigIssues().some(candidate => candidate.kind === "unmigrated-legacy")).toBe(true);
});

test("saving a setting keeps the hand-edited entries the runtime rejected", async () => {
	const fixture = await makeFixture({ "profile/config.yml": "autoResume: yes-please\nnotARealKey: 3\n" });
	const settings = await loadSettings(fixture);

	settings.set("theme.dark", "nord");
	await settings.flush();

	const written = await fs.readFile(path.join(fixture.agentDir, "config.yml"), "utf8");
	expect(written).toContain("yes-please");
	expect(written).toContain("notARealKey");
	expect(written).toContain("nord");
});

test("a broken .mcp.json reaches the MCP startup diagnostics", async () => {
	const fixture = await makeFixture({ "work/.mcp.json": '{"mcpServers": {"ghost": {"command": "x"},,}}' });
	const manager = new MCPManager(fixture.cwd, null);
	const events: McpConnectionStatusEvent[] = [];
	try {
		const result = await manager.discoverAndConnect({ onStatus: event => events.push(event) });

		expect(result.configErrors.some(error => error.includes(".mcp.json"))).toBe(true);
		expect(events.some(event => event.type === "config-error")).toBe(true);
		expect(manager.getStartupDiagnostics().configErrors.some(error => error.includes(".mcp.json"))).toBe(true);
	} finally {
		await manager.dispose();
	}
});

test("a corrupt config.yml reports on stderr and exits 0 on the first run and every run after", async () => {
	const fixture = await makeFixture({ "profile/config.yml": "theme:\n  dark: gruvbox\n  : : broken\n\t- nope\n" });
	const env = {
		...(process.env as Record<string, string>),
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		TERM: "dumb",
		NO_COLOR: "1",
	};
	const run = async () => {
		const child = Bun.spawn([process.execPath, CLI, "config", "get", "theme.dark"], {
			cwd: fixture.cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	};

	const first = await run();
	expect(first.exitCode).toBe(0);
	expect(first.stdout.trim()).toBe("proto");
	expect(first.stderr).toMatch(/is not valid YAML/);
	expect(first.stderr).toMatch(/moved aside to/);
	expect(first.stderr).not.toMatch(/^error:/m);
	expect(first.stderr).not.toMatch(/\bat #/);

	const second = await run();
	expect(second.exitCode).toBe(0);
	expect(second.stderr).toMatch(/could not parse and moved aside/);
	expect(second.stderr).not.toMatch(/^error:/m);
}, 30_000);
