import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";
import {
	installProfileAlias,
	readProfileAliasConfigFile,
	resolveProfileAliasCommandFromProcess,
} from "../src/cli/profile-alias";

describe("profile alias installer", () => {
	it("writes a bash-compatible function that forwards subcommands through proto", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/bin/bash",
			platform: "linux",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/home/me/.bashrc");
		expect(result.command).toBe("proto --profile=work");
		expect(files.get("/home/me/.bashrc")).toContain("proto-work() {");
		expect(files.get("/home/me/.bashrc")).toContain('command proto --profile=work "$@"');
	});

	it("resolves source invocations without forcing the source checkout as cwd", () => {
		const command = resolveProfileAliasCommandFromProcess({
			argv: ["/bin/bun", "src/cli.ts"],
			cwd: "/repo/packages/coding-agent",
		});

		// path.resolve is platform-dependent (adds drive letter on Windows);
		// the code normalizes to forward slashes for POSIX shell fields.
		const expectedScriptPath = path.resolve("/repo/packages/coding-agent", "src/cli.ts");
		const expectedPosixPath = expectedScriptPath.replace(/\\/g, "/");

		expect(command.display).toBe(`/bin/bun ${expectedPosixPath}`);
		expect(command.posix).toBe(`'/bin/bun' '${expectedPosixPath}'`);
		expect(command.fish).toBe(`'/bin/bun' '${expectedPosixPath}'`);
		expect(command.powerShell).toBe(`'/bin/bun' '${expectedScriptPath}'`);
	});

	it("uses the installed command for a compiled standalone invocation", () => {
		const command = resolveProfileAliasCommandFromProcess({
			argv: ["bun", "/$bunfs/root/packages/coding-agent/src/cli.js"],
			compiled: true,
		});

		expect(command).toEqual({
			display: BINARY_NAME,
			posix: BINARY_NAME,
			fish: BINARY_NAME,
			powerShell: BINARY_NAME,
		});
	});

	it("normalizes a backslash runtime path for POSIX shell command fields", () => {
		// On Windows argv[0] is typically a native path like C:\Users\me\.bun\bin\bun.exe;
		// bash/zsh/fish fields must use forward slashes while PowerShell keeps the native path.
		const runtime = "C:\\Users\\me\\.bun\\bin\\bun.exe";
		const command = resolveProfileAliasCommandFromProcess({
			argv: [runtime, "src/cli.ts"],
			cwd: "/repo/packages/coding-agent",
		});

		const expectedScriptPath = path.resolve("/repo/packages/coding-agent", "src/cli.ts");
		const expectedPosixPath = expectedScriptPath.replace(/\\/g, "/");
		const posixRuntime = runtime.replace(/\\/g, "/");

		expect(command.display).toBe(`${posixRuntime} ${expectedPosixPath}`);
		expect(command.posix).toBe(`'${posixRuntime}' '${expectedPosixPath}'`);
		expect(command.fish).toBe(`'${posixRuntime}' '${expectedPosixPath}'`);
		expect(command.powerShell).toBe(`'${runtime}' '${expectedScriptPath}'`);
	});

	it("can target the current source invocation instead of the installed proto binary", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/Users/me",
			command: {
				display: "bun /repo/packages/coding-agent/src/cli.ts",
				posix: "bun '/repo/packages/coding-agent/src/cli.ts'",
				fish: "bun /repo/packages/coding-agent/src/cli.ts",
				powerShell: "bun '/repo/packages/coding-agent/src/cli.ts'",
			},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.command).toBe("bun /repo/packages/coding-agent/src/cli.ts --profile=work");
		expect(files.get("/Users/me/.zshrc")).toContain("proto-work() {");
		expect(files.get("/Users/me/.zshrc")).toContain(
			`command bun '/repo/packages/coding-agent/src/cli.ts' --profile=work "$@"`,
		);
	});

	it("installs the zsh alias under ZDOTDIR when set", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/Users/me",
			env: { ZDOTDIR: "/Users/me/.config/zsh" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/Users/me/.config/zsh/.zshrc");
		expect(files.get(result.configPath)).toContain("proto-work() {");
	});

	it("writes a fish function that forwards argv", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/opt/homebrew/bin/fish",
			platform: "darwin",
			homeDir: "/Users/me",
			env: {},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/Users/me/.config/fish/conf.d/proto-profiles.fish") ?? "";
		expect(content).toContain("function proto-work --wraps proto");
		expect(content).toContain("command proto --profile=work $argv");
	});

	it("installs the fish alias under XDG_CONFIG_HOME when set", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/usr/bin/fish",
			platform: "linux",
			homeDir: "/home/me",
			env: { XDG_CONFIG_HOME: "/home/me/.dotfiles/config" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/home/me/.dotfiles/config/fish/conf.d/proto-profiles.fish");
		expect(files.get(result.configPath)).toContain("function proto-work --wraps proto");
	});

	it("writes a PowerShell function because aliases cannot carry arguments", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/usr/bin/pwsh",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const psConfigPath = path.join("/home/me", ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
		const content = files.get(psConfigPath) ?? "";
		expect(content).toContain("function proto-work");
		expect(content).toContain("& proto --profile=work @args");
	});
	it("replaces a previous block for the same alias", async () => {
		const files = new Map<string, string>([
			[
				"/home/me/.zshrc",
				[
					"before",
					"# >>> proto profile alias: proto-work >>>",
					"alias proto-work='command proto --profile=old'",
					"# <<< proto profile alias: proto-work <<<",
					"after",
				].join("\n"),
			],
		]);

		await installProfileAlias({
			profile: "work",
			aliasName: "proto-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/home/me/.zshrc") ?? "";
		expect(content).toContain("before");
		expect(content).toContain("after");
		expect(content).toContain('command proto --profile=work "$@"');
		expect(content).not.toContain("--profile=old");
	});

	it("refuses to rewrite a malformed managed block missing its end marker", async () => {
		// A start marker without its matching end marker means a previous install
		// was interrupted or hand-edited. Appending a fresh block would let the
		// *next* install splice from the stale start through the new end, deleting
		// the user config in between. Refuse and preserve the file untouched.
		const original = ["# >>> proto profile alias: proto-work >>>", "proto-work() {", "export SECRET=keepme"].join(
			"\n",
		);
		const files = new Map<string, string>([["/home/me/.zshrc", original]]);
		let wrote = false;

		await expect(
			installProfileAlias({
				profile: "work",
				aliasName: "proto-work",
				shellPath: "/bin/zsh",
				platform: "darwin",
				homeDir: "/home/me",
				readFile: async filePath => files.get(filePath) ?? "",
				writeFile: async (filePath, content) => {
					wrote = true;
					files.set(filePath, content);
				},
			}),
		).rejects.toThrow(/without a matching/);

		expect(wrote).toBe(false);
		expect(files.get("/home/me/.zshrc")).toBe(original);
	});

	it("refuses to shadow the base proto command case-insensitively", async () => {
		for (const aliasName of ["proto", "PROTO"]) {
			await expect(
				installProfileAlias({
					profile: "work",
					aliasName,
					shellPath: "/bin/bash",
					homeDir: "/home/me",
				}),
			).rejects.toThrow("Refusing to shadow");
		}
	});

	it("rejects shell reserved words before rendering alias functions", async () => {
		for (const { aliasName, shellPath } of [
			{ aliasName: "if", shellPath: "/bin/bash" },
			{ aliasName: "end", shellPath: "/opt/homebrew/bin/fish" },
			{ aliasName: "foreach", shellPath: "/usr/bin/pwsh" },
		]) {
			await expect(
				installProfileAlias({
					profile: "work",
					aliasName,
					shellPath,
					homeDir: "/home/me",
				}),
			).rejects.toThrow("reserved word");
		}
	});

	it("rejects POSIX sh because it does not read bash config files", async () => {
		await expect(
			installProfileAlias({
				profile: "work",
				aliasName: "proto-work",
				shellPath: "/bin/sh",
				platform: "linux",
				homeDir: "/home/me",
			}),
		).rejects.toThrow('Unsupported shell "sh"');
	});

	it("treats missing shell config as empty but preserves other read failures", async () => {
		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			}),
		).resolves.toBe("");

		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			}),
		).rejects.toThrow("denied");
	});

	it("validates profile names before rendering shell code", async () => {
		const files = new Map<string, string>();

		await expect(
			installProfileAlias({
				profile: "work'; touch /tmp/pwn; #",
				aliasName: "proto-work",
				shellPath: "/bin/bash",
				platform: "linux",
				homeDir: "/home/me",
				readFile: async filePath => files.get(filePath) ?? "",
				writeFile: async (filePath, content) => {
					files.set(filePath, content);
				},
			}),
		).rejects.toThrow("Invalid PROTO profile");
		expect(files.size).toBe(0);
	});
});
