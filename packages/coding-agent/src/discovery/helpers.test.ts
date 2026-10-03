import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "../capability";
import { clearCache as clearFsCache } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { MCPManager } from "../mcp/manager";
import "./claude-plugins";
import {
	clearClaudePluginRootsCache,
	expandEnvVarsDeep,
	parseAgentFields,
	resolveActiveProjectRegistryPath,
	shouldPreloadPluginRoots,
} from "./helpers";

function envPlaceholder(name: string, defaultValue?: string): string {
	return ["$", "{", name, defaultValue === undefined ? "" : `:-${defaultValue}`, "}"].join("");
}

test("plugin roots are not preloaded when extension discovery is disabled", () => {
	expect(shouldPreloadPluginRoots({ noExtensions: true, pluginDirs: [] })).toBeFalse();
	expect(shouldPreloadPluginRoots({ noExtensions: true, pluginDirs: ["./plugin"] })).toBeTrue();
	expect(shouldPreloadPluginRoots({ noExtensions: false, pluginDirs: [] })).toBeTrue();
});

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

test("environment expansion ignores inherited names and preserves normal precedence", () => {
	const inheritedExtraEnv = Object.create({ constructor: "inherited", toString: "inherited" }) as Record<
		string,
		string
	>;
	const constructorPlaceholder = envPlaceholder("constructor");
	const inherited = expandEnvVarsDeep(
		{
			plain: constructorPlaceholder,
			fallback: envPlaceholder("toString", "safe"),
		},
		inheritedExtraEnv,
	);
	expect(inherited).toEqual({ plain: constructorPlaceholder, fallback: "safe" });

	const ambientPath = Bun.env.PATH;
	if (typeof ambientPath !== "string") throw new Error("PATH must be available to test ambient expansion");
	const pathPlaceholder = envPlaceholder("PATH");
	expect(expandEnvVarsDeep(pathPlaceholder)).toBe(ambientPath);
	expect(expandEnvVarsDeep(pathPlaceholder, { PATH: "extra-path" })).toBe("extra-path");
	expect(expandEnvVarsDeep(constructorPlaceholder, { constructor: "own-constructor" })).toBe("own-constructor");
});

test("deep expansion preserves literal __proto__ keys and insertion order", () => {
	const ambientPath = Bun.env.PATH;
	if (typeof ambientPath !== "string") throw new Error("PATH must be available to test ambient expansion");
	const pathPlaceholder = envPlaceholder("PATH");
	const input = JSON.parse(
		JSON.stringify({
			before: pathPlaceholder,
			["__proto__"]: "literal-proto",
			after: { clientId: pathPlaceholder },
		}),
	) as { before: string; __proto__: string; after: { clientId: string } };
	const expanded = expandEnvVarsDeep(input);

	expect(Object.getPrototypeOf(expanded)).toBeNull();
	expect(Object.keys(expanded)).toEqual(["before", "__proto__", "after"]);
	expect(Object.hasOwn(expanded, "__proto__")).toBeTrue();
	expect(Reflect.get(expanded, "__proto__")).toBe("literal-proto");
	expect(expanded.before).toBe(ambientPath);
	expect(Object.getPrototypeOf(expanded.after)).toBeNull();
	expect(expanded.after.clientId).toBe(ambientPath);
});

test("plugin env expands before root substitution and survives subprocess config preparation", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-env-test-"));
	const claudeConfigDir = path.join(tempDir, ".claude");
	const pluginPath = path.join(tempDir, "plugins", `${envPlaceholder("PATH")}-plugin`);
	const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const ambientPath = Bun.env.PATH;
	if (typeof ambientPath !== "string") throw new Error("PATH must be available to test ambient expansion");

	try {
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
		Bun.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
		clearClaudePluginRootsCache();
		clearFsCache();

		await fs.mkdir(path.join(claudeConfigDir, "plugins"), { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await Bun.write(
			path.join(claudeConfigDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"ordered@market": [{ scope: "user", installPath: pluginPath, version: "1.0.0" }],
				},
			}),
		);
		await Bun.write(
			path.join(pluginPath, ".mcp.json"),
			JSON.stringify({
				ordered: {
					command: "noop",
					env: {
						FIRST: `${envPlaceholder("PATH")}:${envPlaceholder("CLAUDE_PLUGIN_ROOT")}/data`,
						["__proto__"]: "literal://proto",
						LAST: "literal://last",
					},
				},
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		const server = result.items.find(item => item.name === "ordered:ordered");
		if (server?.env === undefined) throw new Error(`Missing discovered test server: ${result.warnings.join("; ")}`);

		expect(Object.getPrototypeOf(server.env)).toBeNull();
		expect(Object.keys(server.env)).toEqual(["FIRST", "__proto__", "LAST"]);
		expect(server.env.FIRST).toBe(`${ambientPath}:${pluginPath}/data`);
		expect(Object.hasOwn(server.env, "__proto__")).toBeTrue();
		expect(Reflect.get(server.env, "__proto__")).toBe("literal://proto");

		const delivered = await new MCPManager(tempDir).prepareConfig({
			type: "stdio",
			command: server.command ?? "noop",
			env: server.env,
		});
		if (delivered.type !== "stdio" || delivered.env === undefined) {
			throw new Error("Prepared stdio config lost its environment");
		}
		expect(Object.getPrototypeOf(delivered.env)).toBeNull();
		expect(Object.keys(delivered.env)).toEqual(["FIRST", "__proto__", "LAST"]);
		expect(Reflect.get(delivered.env, "__proto__")).toBe("literal://proto");
	} finally {
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		clearFsCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("default placeholders also replace empty variables", () => {
	const env = { EMPTY: "", SET: "value" };
	expect(expandEnvVarsDeep(envPlaceholder("EMPTY", "fallback"), env)).toBe("fallback");
	expect(expandEnvVarsDeep(envPlaceholder("EMPTY"), env)).toBe("");
	expect(expandEnvVarsDeep(envPlaceholder("SET", "fallback"), env)).toBe("value");
});

test("expanded plugin env values are never reinterpreted at connect time", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-env-literal-test-"));
	const claudeConfigDir = path.join(tempDir, ".claude");
	const pluginPath = path.join(tempDir, "plugins", "literal");
	const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
	const originalToken = process.env.PROTO_TEST_PLUGIN_TOKEN;
	const ambientHome = Bun.env.HOME;
	if (typeof ambientHome !== "string") throw new Error("HOME must be available to test env-name resolution");

	try {
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		restoreEnvValue("CLAUDE_CONFIG_DIR", claudeConfigDir);
		restoreEnvValue("CLAUDE_PLUGIN_ROOT", "/caller/plugin");
		restoreEnvValue("PROTO_TEST_PLUGIN_TOKEN", "HOME");
		clearClaudePluginRootsCache();
		clearFsCache();

		await fs.mkdir(path.join(claudeConfigDir, "plugins"), { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await Bun.write(
			path.join(claudeConfigDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"literal@market": [{ scope: "user", installPath: pluginPath, version: "1.0.0" }],
					"broken@market": [{ scope: "user", installPath: path.join(tempDir, "plugins", "broken") }],
				},
			}),
		);
		await fs.mkdir(path.join(tempDir, "plugins", "broken"), { recursive: true });
		await Bun.write(
			path.join(tempDir, "plugins", "broken", ".mcp.json"),
			JSON.stringify({ broken: { command: "noop", env: null } }),
		);
		await Bun.write(
			path.join(pluginPath, ".mcp.json"),
			JSON.stringify({
				literal: {
					command: "noop",
					env: {
						TOKEN: envPlaceholder("PROTO_TEST_PLUGIN_TOKEN"),
						EMPTY: envPlaceholder("PROTO_TEST_PLUGIN_UNSET", ""),
						ROOT: envPlaceholder("CLAUDE_PLUGIN_ROOT"),
						LEGACY: "HOME",
					},
				},
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.warnings.some(warning => warning.includes('"broken"') && warning.includes("malformed env"))).toBe(
			true,
		);
		const server = result.items.find(item => item.name === "literal:literal");
		if (server?.env === undefined) throw new Error(`Missing discovered test server: ${result.warnings.join("; ")}`);
		expect(server.envLiteralKeys).toEqual(["TOKEN", "EMPTY", "ROOT"]);

		const delivered = await new MCPManager(tempDir).prepareConfig({
			type: "stdio",
			command: server.command ?? "noop",
			env: server.env,
			envLiteralKeys: server.envLiteralKeys,
		});
		if (delivered.type !== "stdio" || delivered.env === undefined) {
			throw new Error("Prepared stdio config lost its environment");
		}
		expect({ ...delivered.env }).toEqual({ TOKEN: "HOME", EMPTY: "", ROOT: pluginPath, LEGACY: ambientHome });
	} finally {
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		restoreEnvValue("CLAUDE_PLUGIN_ROOT", originalPluginRoot);
		restoreEnvValue("PROTO_TEST_PLUGIN_TOKEN", originalToken);
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		clearFsCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("marketplace plugin rules load and honor enabled: false frontmatter", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-rules-test-"));
	const claudeConfigDir = path.join(tempDir, ".claude");
	const pluginPath = path.join(tempDir, "plugins", "rules-plugin");
	const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

	try {
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		restoreEnvValue("CLAUDE_CONFIG_DIR", claudeConfigDir);
		clearClaudePluginRootsCache();
		clearFsCache();

		await fs.mkdir(path.join(claudeConfigDir, "plugins"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "rules"), { recursive: true });
		await Bun.write(
			path.join(claudeConfigDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "rules-plugin@market": [{ scope: "user", installPath: pluginPath, version: "1.0.0" }] },
			}),
		);
		await Bun.write(
			path.join(pluginPath, "rules", "style.md"),
			"---\ndescription: Marketplace style rule\n---\nUse tabs.\n",
		);
		await Bun.write(path.join(pluginPath, "rules", "off.md"), "---\nenabled: false\n---\nIgnored.\n");

		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: tempDir, providers: ["claude-plugins"] });

		expect(result.items.map(rule => rule.name)).toEqual(["style"]);
		expect(result.items[0]?.description).toBe("Marketplace style rule");
	} finally {
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		clearFsCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

for (const catalogDir of [".claude-plugin", ".proto-plugin"]) {
	test(`marketplace-root ${catalogDir} entry limits shared skills to declared paths`, async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-shared-root-skills-test-"));
		const claudeConfigDir = path.join(tempDir, ".claude");
		const pluginPath = path.join(tempDir, "plugins", "anthropic-skills");
		const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

		try {
			vi.spyOn(os, "homedir").mockReturnValue(tempDir);
			restoreEnvValue("CLAUDE_CONFIG_DIR", claudeConfigDir);
			clearClaudePluginRootsCache();
			clearFsCache();

			for (const skill of ["xlsx", "skill-creator"]) {
				await Bun.write(
					path.join(pluginPath, "skills", skill, "SKILL.md"),
					`---\nname: ${skill}\ndescription: ${skill} skill\n---\nBody\n`,
				);
			}
			await Bun.write(
				path.join(pluginPath, catalogDir, "marketplace.json"),
				JSON.stringify({
					name: "anthropic-agent-skills",
					owner: { name: "Anthropic" },
					plugins: [
						{ name: "document-skills", source: "./", skills: ["./skills/xlsx"] },
						{ name: "example-skills", source: "./", skills: ["./skills/skill-creator"] },
					],
				}),
			);
			await Bun.write(
				path.join(claudeConfigDir, "plugins", "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						"document-skills@anthropic-agent-skills": [
							{ scope: "user", installPath: pluginPath, version: "1.0.0" },
						],
					},
				}),
			);

			const result = await loadCapability<Skill>(skillCapability.id, {
				cwd: tempDir,
				providers: ["claude-plugins"],
			});

			expect(result.items.map(skill => skill.name)).toEqual(["xlsx"]);
		} finally {
			restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
			vi.restoreAllMocks();
			clearClaudePluginRootsCache();
			clearFsCache();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
}

describe("parseAgentFields", () => {
	test("keeps an explicitly empty tools list distinct from an absent one", () => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: [] })?.tools).toEqual(["yield"]);
		expect(parseAgentFields({ name: "quiet", description: "desc" })?.tools).toBeUndefined();
	});
});

describe("resolveActiveProjectRegistryPath", () => {
	let homeDir = "";

	function registryPath(root: string): string {
		return path.join(root, ".proto", "plugins", "installed_plugins.json");
	}

	beforeEach(async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-project-registry-test-"));
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		await fs.rm(homeDir, { recursive: true, force: true });
	});

	test("uses the nearest Git root when no .proto directory exists", async () => {
		const repoRoot = path.join(homeDir, "work", "repo");
		const cwd = path.join(repoRoot, "one", "two");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		expect(await resolveActiveProjectRegistryPath(cwd)).toBe(registryPath(repoRoot));
	});

	test("uses the nearest .proto directory when no Git root exists", async () => {
		const projectRoot = path.join(homeDir, "work", "project");
		const cwd = path.join(projectRoot, "one", "two");
		await fs.mkdir(path.join(projectRoot, ".proto"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		expect(await resolveActiveProjectRegistryPath(cwd)).toBe(registryPath(projectRoot));
	});

	test("preserves .proto precedence when .proto and .git are at the same level", async () => {
		const projectRoot = path.join(homeDir, "work", "project");
		const cwd = path.join(projectRoot, "nested");
		await Promise.all([
			fs.mkdir(path.join(projectRoot, ".proto"), { recursive: true }),
			fs.mkdir(path.join(projectRoot, ".git"), { recursive: true }),
			fs.mkdir(cwd, { recursive: true }),
		]);

		expect(await resolveActiveProjectRegistryPath(cwd)).toBe(registryPath(projectRoot));
	});

	test("preserves a higher .proto directory over a nearer Git root", async () => {
		const projectRoot = path.join(homeDir, "work");
		const repoRoot = path.join(projectRoot, "repo");
		const cwd = path.join(repoRoot, "nested");
		await Promise.all([
			fs.mkdir(path.join(projectRoot, ".proto"), { recursive: true }),
			fs.mkdir(path.join(repoRoot, ".git"), { recursive: true }),
			fs.mkdir(cwd, { recursive: true }),
		]);

		expect(await resolveActiveProjectRegistryPath(cwd)).toBe(registryPath(projectRoot));
	});

	test("returns null when no .proto directory or Git root exists", async () => {
		const cwd = path.join(homeDir, "work", "project", "nested");
		await fs.mkdir(cwd, { recursive: true });

		expect(await resolveActiveProjectRegistryPath(cwd)).toBeNull();
	});
});
