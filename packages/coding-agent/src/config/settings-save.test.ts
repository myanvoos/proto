import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { AgentStorage } from "../session/agent-storage";
import { onAppendOnlyModeChanged, Settings } from "./settings";

let tempDir: TempDir;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	tempDir = TempDir.createSync("@proto-settings-save-");
	agentDir = path.join(tempDir.path(), "agent");
	cwd = path.join(tempDir.path(), "project");
	for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tempDir.remove();
});

const configPath = () => path.join(agentDir, "config.yml");
const writeConfig = (settings: Record<string, unknown>) => Bun.write(configPath(), YAML.stringify(settings));
const readConfig = async () => YAML.parse(await Bun.file(configPath()).text()) as Record<string, unknown>;
const load = () => Settings.loadIsolated({ agentDir, cwd });

describe("saving after an external config.yml edit", () => {
	it("keeps a same-key external edit made after a local change was queued", async () => {
		await writeConfig({ theme: { dark: "nord" } });
		const settings = await load();

		settings.set("theme.dark", "gruvbox");
		await writeConfig({ theme: { dark: "titanium" } });
		await settings.flush();

		expect(await readConfig()).toEqual({ theme: { dark: "titanium" } });
		expect(settings.get("theme.dark")).toBe("titanium");
	});

	it("merges a pending local change with a disjoint external edit", async () => {
		await writeConfig({ theme: { dark: "nord" } });
		const settings = await load();

		settings.set("theme.dark", "gruvbox");
		await writeConfig({ theme: { dark: "nord" }, enabledModels: ["openai/gpt-5.2-codex"] });
		await settings.flush();

		expect(await readConfig()).toEqual({ theme: { dark: "gruvbox" }, enabledModels: ["openai/gpt-5.2-codex"] });
	});

	it("keeps a same-role external model role edit made after a local change was queued", async () => {
		await writeConfig({ modelRoles: { default: "anthropic/claude-sonnet-4-5", smol: "openai/gpt-5-mini" } });
		const settings = await load();

		settings.setModelRole("default", "openai/gpt-5.2-codex");
		settings.setModelRole("smol", "openai/gpt-5-nano");
		await writeConfig({ modelRoles: { default: "moonshot/kimi-k3", smol: "openai/gpt-5-mini" } });
		await settings.flush();

		expect((await readConfig()).modelRoles).toEqual({ default: "moonshot/kimi-k3", smol: "openai/gpt-5-nano" });
		expect(settings.getModelRole("default")).toBe("moonshot/kimi-k3");
	});

	it("re-runs setting hooks when the external edit wins", async () => {
		await writeConfig({ provider: { appendOnlyContext: "auto" } });
		const settings = await load();
		const received: string[] = [];
		const unsubscribe = onAppendOnlyModeChanged(value => received.push(value));
		try {
			settings.set("provider.appendOnlyContext", "on");
			await writeConfig({ provider: { appendOnlyContext: "off" } });
			await settings.flush();

			expect(settings.get("provider.appendOnlyContext")).toBe("off");
			expect(received).toEqual(["on", "off"]);
		} finally {
			unsubscribe();
		}
	});
});

describe("no-op saves", () => {
	/** Backdates config.yml so any rewrite shows in its mtime. */
	function snapshotConfig(): { text: string; mtimeMs: number } {
		const past = new Date(Date.now() - 3_600_000);
		fs.utimesSync(configPath(), past, past);
		return { text: fs.readFileSync(configPath(), "utf8"), mtimeMs: fs.statSync(configPath()).mtimeMs };
	}
	const currentConfig = () => ({
		text: fs.readFileSync(configPath(), "utf8"),
		mtimeMs: fs.statSync(configPath()).mtimeMs,
	});

	it("re-setting persisted values and model roles leaves config.yml untouched", async () => {
		await writeConfig({ theme: { dark: "titanium" }, modelRoles: { default: "openai/gpt-5" } });
		const settings = await load();
		const before = snapshotConfig();

		settings.set("theme.dark", "titanium");
		settings.setModelRole("default", "openai/gpt-5");
		settings.setModelRole("absent-role", undefined);
		await settings.flush();

		expect(currentConfig()).toEqual(before);
	});

	it("skips a save whose merged YAML matches the file, while a real change still writes", async () => {
		const settings = await load();
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		const before = snapshotConfig();

		settings.set("theme.dark", "titanium");
		settings.set("theme.dark", "anthracite");
		await settings.flush();
		expect(currentConfig()).toEqual(before);

		settings.set("theme.dark", "titanium");
		await settings.flush();
		expect(currentConfig().mtimeMs).toBeGreaterThan(before.mtimeMs);
		expect(await readConfig()).toEqual({ theme: { dark: "titanium" } });
	});
});

describe("saving through a dangling config.yml symlink", () => {
	it("writes the final target of a link chain and keeps every link", async () => {
		const managed = path.join(tempDir.path(), "dotfiles");
		fs.mkdirSync(managed);
		fs.symlinkSync(path.join(managed, "final.yml"), path.join(managed, "mid.yml"));
		fs.symlinkSync("../dotfiles/mid.yml", configPath());
		const settings = await load();

		settings.set("theme.dark", "gruvbox");
		await settings.flush();

		expect(fs.lstatSync(configPath()).isSymbolicLink()).toBe(true);
		expect(fs.lstatSync(path.join(managed, "mid.yml")).isSymbolicLink()).toBe(true);
		expect(YAML.parse(fs.readFileSync(path.join(managed, "final.yml"), "utf8"))).toEqual({
			theme: { dark: "gruvbox" },
		});
	});

	it("follows a directory link before popping its physical parent with `..`", async () => {
		const real = path.join(tempDir.path(), "real", "inner");
		fs.mkdirSync(real, { recursive: true });
		fs.symlinkSync(real, path.join(agentDir, "alias"));
		fs.symlinkSync("alias/../final.yml", configPath());
		const settings = await load();

		settings.set("theme.dark", "gruvbox");
		await settings.flush();

		expect(fs.existsSync(path.join(tempDir.path(), "real", "final.yml"))).toBe(true);
		expect(fs.existsSync(path.join(agentDir, "final.yml"))).toBe(false);
		expect(fs.lstatSync(configPath()).isSymbolicLink()).toBe(true);
	});

	it("fails the save instead of writing past a missing component the target must enter", async () => {
		fs.symlinkSync("missing/../final.yml", configPath());
		const settings = await load();

		settings.set("theme.dark", "gruvbox");
		await expect(settings.flush()).rejects.toThrow("ENOTDIR");
		expect(fs.existsSync(path.join(agentDir, "final.yml"))).toBe(false);
		expect(fs.lstatSync(configPath()).isSymbolicLink()).toBe(true);
	});
});

describe("reloading project settings", () => {
	it("picks up a project config.yml created, changed, and removed after startup", async () => {
		const projectConfig = path.join(cwd, ".proto", "config.yml");
		const settings = await load();
		expect(settings.get("theme.dark")).toBe("proto");

		fs.mkdirSync(path.dirname(projectConfig));
		fs.writeFileSync(projectConfig, "theme:\n  dark: nord\n");
		await settings.reloadFromDisk();
		expect(settings.get("theme.dark")).toBe("nord");

		fs.writeFileSync(projectConfig, "theme:\n  dark: gruvbox\n");
		await settings.reloadFromDisk();
		expect(settings.get("theme.dark")).toBe("gruvbox");

		fs.rmSync(projectConfig);
		await settings.reloadFromDisk();
		expect(settings.get("theme.dark")).toBe("proto");
	});
});

describe("legacy settings.json migration", () => {
	it("keeps settings.json when writing the migrated config.yml fails", async () => {
		const jsonPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(jsonPath, JSON.stringify({ theme: { dark: "nord" } }));
		const open = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
			if (String(filePath).startsWith(`${configPath()}.`) && String(filePath).endsWith(".tmp")) {
				throw Object.assign(new Error("EACCES: injected migration write failure"), { code: "EACCES" });
			}
			return open(filePath, flags, mode);
		});

		await load();

		expect(fs.existsSync(configPath())).toBe(false);
		expect(fs.existsSync(`${jsonPath}.bak`)).toBe(false);
		expect(JSON.parse(fs.readFileSync(jsonPath, "utf8"))).toEqual({ theme: { dark: "nord" } });
	});

	it("clears migrated agent.db settings so deleting config.yml starts fresh", async () => {
		await AgentStorage.open(getAgentDbPath(agentDir));
		AgentStorage.close();
		const db = new Database(getAgentDbPath(agentDir));
		db.run("INSERT INTO settings (key, value) VALUES ('theme', ?)", [JSON.stringify({ dark: "nord" })]);
		db.close();

		await load();
		expect(await readConfig()).toEqual({ theme: { dark: "nord" } });

		fs.rmSync(configPath());
		const fresh = await load();
		expect(fresh.get("theme.dark")).toBe("proto");
		expect(fs.existsSync(configPath())).toBe(false);
	});

	it("archives settings.json once config.yml holds its settings", async () => {
		const jsonPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(jsonPath, JSON.stringify({ theme: { dark: "nord" } }));

		await load();

		expect(await readConfig()).toEqual({ theme: { dark: "nord" } });
		expect(fs.existsSync(jsonPath)).toBe(false);
		expect(fs.existsSync(`${jsonPath}.bak`)).toBe(true);
	});
});

describe("project settings warnings", () => {
	it("logs a malformed project .claude/settings.json once, including one broken after startup", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const claudeSettings = path.join(cwd, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(claudeSettings));
		fs.writeFileSync(claudeSettings, "{}");
		const settings = await load();
		const parseWarnings = () =>
			warn.mock.calls.filter(([message]) => String(message).includes(`Failed to parse JSON in ${claudeSettings}`));
		expect(parseWarnings()).toHaveLength(0);

		fs.writeFileSync(claudeSettings, "{ not json");
		await settings.reloadFromDisk();
		await settings.reloadFromDisk();
		expect(parseWarnings()).toHaveLength(1);
	});
});

describe("record entry writes", () => {
	it("persists one fallback chain without copying overlay-supplied chains into config.yml", async () => {
		await writeConfig({ retry: { fallbackChains: { smol: ["openai/gpt-5-mini"] } } });
		const overlayPath = path.join(tempDir.path(), "overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ retry: { fallbackChains: { slow: ["openai/gpt-5.2"] } } }));
		const settings = await Settings.loadIsolated({ agentDir, cwd, configFiles: [overlayPath] });

		settings.setRecordEntry("retry.fallbackChains", "default", ["anthropic/claude-sonnet-4-5"]);
		settings.setRecordEntry("retry.fallbackChains", "smol", undefined);
		await settings.flush();

		expect(await readConfig()).toEqual({
			retry: { fallbackChains: { default: ["anthropic/claude-sonnet-4-5"] } },
		});
		expect(settings.get("retry.fallbackChains")).toEqual({
			default: ["anthropic/claude-sonnet-4-5"],
			slow: ["openai/gpt-5.2"],
		});
	});
});
