import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { readMCPConfigFile } from "../mcp/config-writer";
import { collectMcpServerNames } from "../modes/controllers/mcp-command-controller";
import { expandTilde } from "../tools/path-utils";
import type { SubcommandDef, TuiSlashCommandRuntime } from "./types";

export function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null;
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

const MCP_SERVER_NAME_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	test: true,
	remove: true,
	reconnect: true,
	reauth: true,
	unauth: true,
};

const MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
};

const MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	unauth: true,
};

export function buildMcpArgumentCompletions(
	subcommands: SubcommandDef[],
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
	const genericCompletions = buildArgumentCompletions(subcommands);
	return async (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return genericCompletions(argumentPrefix);

		const rawSubcommand = argumentPrefix.slice(0, spaceIndex);
		const lowerSubcommand = rawSubcommand.toLowerCase();
		if (MCP_SERVER_NAME_SUBCOMMANDS[lowerSubcommand] !== true) return null;
		const namePrefix = argumentPrefix.slice(spaceIndex + 1).toLowerCase();
		if (lowerSubcommand === "remove") {
			return await buildMcpRemoveCompletions(rawSubcommand, namePrefix);
		}

		let serverNames: string[];
		try {
			serverNames = await collectMcpServerNames(
				runtime.ctx,
				undefined,
				MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
				MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
			);
		} catch (error) {
			logger.warn("MCP server-name autocomplete failed to read config", { error });
			return null;
		}
		const matches: AutocompleteItem[] = serverNames
			.filter(name => name.toLowerCase().startsWith(namePrefix))
			.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
		return matches.length > 0 ? matches : null;
	};
}

async function buildMcpRemoveCompletions(
	rawSubcommand: string,
	namePrefix: string,
): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	let projectNames: string[];
	let userNames: string[];
	try {
		const [projectConfig, userConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
		]);
		projectNames = Object.keys(projectConfig.mcpServers ?? {});
		userNames = Object.keys(userConfig.mcpServers ?? {});
	} catch (error) {
		logger.warn("MCP remove autocomplete failed to read config", { error });
		return null;
	}

	const projectNameSet = new Set(projectNames);
	const allNames = new Set([...projectNames, ...userNames]);
	const matches: AutocompleteItem[] = [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNameSet.has(name)
				? { value: `${rawSubcommand} ${name} `, label: name }
				: { value: `${rawSubcommand} ${name} --scope user `, label: `${name} (user)` },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return matches.length > 0 ? matches : null;
}

export function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

export function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/** Trailing path separator: `/` everywhere, `\` too on Windows. */
const TRAILING_SEPARATOR = process.platform === "win32" ? /[\\/]$/ : /\/$/;
/** A path whose last segment is `.` or `..` (or a bare `~`) names a directory without listing it. */
const UNTERMINATED_DIRECTORY = process.platform === "win32" ? /(?:^|[\\/])\.{1,2}$|^~$/ : /(?:^|\/)\.{1,2}$|^~$/;

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 *
 * Tab accepts the highlighted suggestion, so only a prefix that ends in a
 * separator lists the directory's children. A prefix naming a directory
 * without one (`..`, `~`, `foo/.`) completes the separator first; otherwise
 * Tab would jump straight into the first child.
 */
export function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();
		if (UNTERMINATED_DIRECTORY.test(prefix)) return [{ value: `${prefix}/`, label: `${prefix}/` }];

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);
		const resolvedPrefix = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (prefix === "" || TRAILING_SEPARATOR.test(prefix)) {
			searchDir = resolvedPrefix;
			searchPrefix = "";
		} else {
			searchDir = path.dirname(resolvedPrefix);
			searchPrefix = path.basename(resolvedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, isAbsolute, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(
	prefix: string,
	isAbsolute: boolean,
	absoluteValue: string,
	cwd: string,
): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix === "~" || prefix.startsWith("~/")) {
		const homeRelative = path.relative(os.homedir(), normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	// Absolute stays absolute, including Windows drive paths (`C:/…`, `C:\…`).
	if (isAbsolute) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	const relative = path.relative(cwd, normalized).replaceAll("\\", "/");
	// The project directory itself: `""` would render as `/`, the filesystem root.
	if (relative === "") return "./";
	return prefix.startsWith("./") ? `./${relative}/` : `${relative}/`;
}
