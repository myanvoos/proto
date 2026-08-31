import * as os from "node:os";
import * as path from "node:path";
import { BINARY_NAME, normalizeProfileName } from "@oh-my-pi/pi-utils/dirs";

type ProfileAliasShell = "bash" | "zsh" | "fish";

function quoteForShell(pathValue: string): string {
	return `'${pathValue.replace(/'/g, `'"'"'`)}'`;
}

interface ProfileAliasCommand {
	display: string;
	posix: string;
	fish: string;
}

interface ProfileAliasProcessOptions {
	argv?: readonly string[];
	cwd?: string;
	compiled?: boolean;
}

const DEFAULT_ALIAS_COMMAND: ProfileAliasCommand = {
	display: BINARY_NAME,
	posix: BINARY_NAME,
	fish: BINARY_NAME,
};

interface ProfileAliasInstallOptions {
	profile: string;
	aliasName: string;
	shellPath?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	readFile?: (filePath: string) => Promise<string>;
	command?: ProfileAliasCommand;
	writeFile?: (filePath: string, content: string) => Promise<void>;
}

interface ProfileAliasInstallResult {
	shell: ProfileAliasShell;
	configPath: string;
	aliasName: string;
	profile: string;
	command: string;
	reloadedWith: string;
}

const ALIAS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const POSIX_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);
const FISH_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"and",
	"begin",
	"break",
	"builtin",
	"case",
	"command",
	"continue",
	"else",
	"end",
	"exec",
	"for",
	"function",
	"if",
	"not",
	"or",
	"return",
	"switch",
	"while",
]);

function isEnoentError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function getReservedAliasNames(shell: ProfileAliasShell): ReadonlySet<string> {
	switch (shell) {
		case "bash":
		case "zsh":
			return POSIX_RESERVED_ALIAS_NAMES;
		case "fish":
			return FISH_RESERVED_ALIAS_NAMES;
	}
}

function validateAliasName(aliasName: string, shell: ProfileAliasShell): string {
	const normalized = aliasName.trim();
	if (!ALIAS_NAME_RE.test(normalized)) {
		throw new Error(`Invalid alias "${aliasName}". Alias names must match ${ALIAS_NAME_RE.source}.`);
	}
	if (normalized.toLowerCase() === BINARY_NAME) {
		throw new Error(`Invalid alias "${BINARY_NAME}". Refusing to shadow the base ${BINARY_NAME} command.`);
	}
	if (getReservedAliasNames(shell).has(normalized.toLowerCase())) {
		throw new Error(`Invalid alias "${aliasName}". Refusing to create a ${shell} reserved word.`);
	}
	return normalized;
}

function normalizeShellName(shellPath: string | undefined): ProfileAliasShell {
	const shell = path.basename(shellPath ?? "").toLowerCase();
	if (shell === "zsh") return "zsh";
	if (shell === "bash") return "bash";
	if (shell === "fish") return "fish";
	throw new Error(`Unsupported shell${shell ? ` "${shell}"` : ""}. Supported shells: bash, zsh, fish.`);
}

export function resolveProfileAliasCommandFromProcess({
	argv = process.argv,
	cwd = process.cwd(),
	compiled = process.env.PI_COMPILED === "true",
}: ProfileAliasProcessOptions = {}): ProfileAliasCommand {
	if (compiled) return DEFAULT_ALIAS_COMMAND;

	const runtime = argv[0];
	const script = argv[1];
	if (!runtime || !script || !/\.[cm]?[jt]s$/.test(script)) return DEFAULT_ALIAS_COMMAND;

	const scriptPath = path.resolve(cwd, script);

	const posix = `${quoteForShell(runtime)} ${quoteForShell(scriptPath)}`;
	return {
		display: `${runtime} ${scriptPath}`,
		posix,
		fish: posix,
	};
}

function resolveShellConfigPath(
	shell: ProfileAliasShell,
	homeDir: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	switch (shell) {
		case "zsh":
			return path.join(env.ZDOTDIR ?? homeDir, ".zshrc");
		case "bash":
			return platform === "darwin" ? path.join(homeDir, ".bash_profile") : path.join(homeDir, ".bashrc");
		case "fish": {
			const configHome = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
			return path.join(configHome, "fish", "conf.d", "proto-profiles.fish");
		}
	}
}

function renderAliasBlock(
	shell: ProfileAliasShell,
	aliasName: string,
	profile: string,
	command: ProfileAliasCommand,
): { block: string; command: string } {
	const profiledCommand = `${command.display} --profile=${profile}`;
	const start = `# >>> proto profile alias: ${aliasName} >>>`;
	const end = `# <<< proto profile alias: ${aliasName} <<<`;
	let body: string;
	switch (shell) {
		case "fish":
			body = [
				`function ${aliasName} --wraps ${BINARY_NAME} --description 'PROTO profile ${profile}'`,
				`    command ${command.fish} --profile=${profile} $argv`,
				"end",
			].join("\n");
			break;
		default:
			body = [`${aliasName}() {`, `    command ${command.posix} --profile=${profile} "$@"`, "}"].join("\n");
			break;
	}
	return { block: `${start}\n${body}\n${end}`, command: profiledCommand };
}

function upsertBlock(content: string, aliasName: string, block: string): string {
	const start = `# >>> proto profile alias: ${aliasName} >>>`;
	const end = `# <<< proto profile alias: ${aliasName} <<<`;
	const startIndex = content.indexOf(start);
	if (startIndex !== -1) {
		const endIndex = content.indexOf(end, startIndex + start.length);
		if (endIndex === -1) {
			throw new Error(
				`Found "${start}" without a matching "${end}" in the shell config. ` +
					`The managed alias block is malformed; remove the stale marker line and rerun --alias.`,
			);
		}
		const afterEnd = endIndex + end.length;
		const prefix = content.slice(0, startIndex).replace(/[\t ]*\n?$/, "");
		const suffix = content.slice(afterEnd).replace(/^\n?/, "");
		return [prefix, block, suffix].filter(Boolean).join("\n\n").replace(/\n*$/, "\n");
	}
	const trimmed = content.replace(/\s*$/, "");
	return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

function readAliasConfigText(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

export async function readProfileAliasConfigFile(
	filePath: string,
	readText: (filePath: string) => Promise<string> = readAliasConfigText,
): Promise<string> {
	try {
		return await readText(filePath);
	} catch (error) {
		if (isEnoentError(error)) return "";
		throw error;
	}
}

export async function installProfileAlias(options: ProfileAliasInstallOptions): Promise<ProfileAliasInstallResult> {
	const profile = normalizeProfileName(options.profile);
	if (!profile) {
		throw new Error("--alias requires a named --profile value.");
	}
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;
	const shell = normalizeShellName(options.shellPath ?? env.SHELL);
	const aliasName = validateAliasName(options.aliasName, shell);
	const configPath = resolveShellConfigPath(shell, homeDir, platform, env);
	const { block, command } = renderAliasBlock(shell, aliasName, profile, options.command ?? DEFAULT_ALIAS_COMMAND);
	const readFile = options.readFile ?? readProfileAliasConfigFile;
	const writeFile =
		options.writeFile ??
		(async (filePath, content) => {
			await Bun.write(filePath, content);
		});

	const current = await readFile(configPath);
	await writeFile(configPath, upsertBlock(current, aliasName, block));

	return {
		shell,
		configPath,
		aliasName,
		profile,
		command,
		reloadedWith: shell === "fish" ? `source ${quoteForShell(configPath)}` : `. ${quoteForShell(configPath)}`,
	};
}
