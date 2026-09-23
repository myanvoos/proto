import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";
import { levenshteinDistance } from "@oh-my-pi/pi-utils/levenshtein";
import * as commandHelp from "./cli/command-help";
import { flagConsumesValue, OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS, VALUELESS_FLAGS } from "./cli/flag-tables";
import { launchHelp } from "./commands/launch-help";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default), help: launchHelp },
	{
		name: "acp",
		load: () => import("./commands/acp").then(m => m.default),
		help: commandHelp.acpHelp,
	},
	{
		name: "auth-broker",
		load: () => import("./commands/auth-broker").then(m => m.default),
		help: commandHelp.authBrokerHelp,
	},
	{
		name: "auth-gateway",
		load: () => import("./commands/auth-gateway").then(m => m.default),
		help: commandHelp.authGatewayHelp,
	},
	{
		name: "agents",
		load: () => import("./commands/agents").then(m => m.default),
		help: commandHelp.agentsHelp,
	},
	{
		name: "bench",
		load: () => import("./commands/bench").then(m => m.default),
		help: commandHelp.benchHelp,
	},
	{
		name: "browser-relay",
		load: () => import("./commands/browser-relay").then(m => m.default),
		help: commandHelp.browserRelayHelp,
	},
	{
		name: "commit",
		load: () => import("./commands/commit").then(m => m.default),
		help: commandHelp.commitHelp,
	},
	{
		name: "attach",
		load: () => import("./commands/attach").then(m => m.default),
		help: commandHelp.attachHelp,
	},
	{
		name: "completions",
		load: () => import("./commands/completions").then(m => m.default),
		help: commandHelp.completionsHelp,
	},
	{
		name: "__complete",
		load: () => import("./commands/complete").then(m => m.default),
		help: commandHelp.completeHelp,
	},
	{
		name: "compress",
		load: () => import("./commands/compress").then(m => m.default),
		help: commandHelp.compressHelp,
	},
	{
		name: "config",
		load: () => import("./commands/config").then(m => m.default),
		help: commandHelp.configHelp,
	},
	{
		name: "dry-balance",
		load: () => import("./commands/dry-balance").then(m => m.default),
		help: commandHelp.dryBalanceHelp,
	},
	{
		name: "gc",
		load: () => import("./commands/gc").then(m => m.default),
		help: commandHelp.gcHelp,
	},
	{
		name: "grep",
		load: () => import("./commands/grep").then(m => m.default),
		help: commandHelp.grepHelp,
	},
	{
		name: "gallery",
		load: () => import("./commands/gallery").then(m => m.default),
		help: commandHelp.galleryHelp,
	},
	{
		name: "grievances",
		load: () => import("./commands/grievances").then(m => m.default),
		help: commandHelp.grievancesHelp,
	},
	{
		name: "images",
		load: () => import("./commands/images").then(m => m.default),
		aliases: ["img"],
		help: commandHelp.imagesHelp,
	},
	{
		name: "install",
		load: () => import("./commands/install").then(m => m.default),
		help: commandHelp.installHelp,
	},
	{
		name: "models",
		load: () => import("./commands/models").then(m => m.default),
		help: commandHelp.modelsHelp,
	},
	{
		name: "plugin",
		load: () => import("./commands/plugin").then(m => m.default),
		help: commandHelp.pluginHelp,
	},
	{
		name: "ps",
		load: () => import("./commands/ps").then(m => m.default),
		help: commandHelp.psHelp,
	},
	{
		name: "setup",
		load: () => import("./commands/setup").then(m => m.default),
		help: commandHelp.setupHelp,
	},
	{
		name: "shell",
		load: () => import("./commands/shell").then(m => m.default),
		help: commandHelp.shellHelp,
	},
	{
		name: "read",
		load: () => import("./commands/read").then(m => m.default),
		help: commandHelp.readHelp,
	},
	{
		name: "render",
		load: () => import("./commands/render").then(m => m.default),
		help: commandHelp.renderHelp,
	},
	{
		name: "ssh",
		load: () => import("./commands/ssh").then(m => m.default),
		help: commandHelp.sshHelp,
	},
	{
		name: "update",
		load: () => import("./commands/update").then(m => m.default),
		help: commandHelp.updateHelp,
	},
	{
		name: "usage",
		load: () => import("./commands/usage").then(m => m.default),
		help: commandHelp.usageHelp,
	},
	{
		name: "tiny-models",
		load: () => import("./commands/tiny-models").then(m => m.default),
		help: commandHelp.tinyModelsHelp,
	},
	{
		name: "token",
		load: () => import("./commands/token").then(m => m.default),
		help: commandHelp.tokenHelp,
	},
	{
		name: "ttsr",
		load: () => import("./commands/ttsr").then(m => m.default),
		help: commandHelp.ttsrHelp,
	},
	{
		name: "worktree",
		load: () => import("./commands/worktree").then(m => m.default),
		aliases: ["wt"],
		help: commandHelp.worktreeHelp,
	},
	{
		name: "search",
		load: () => import("./commands/web-search").then(m => m.default),
		aliases: ["q"],
		help: commandHelp.searchHelp,
	},
];

const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`proto extensions` is not a management command. Use `proto plugin list` / `proto plugin install`, or run `proto launch extensions` if you meant to send "extensions" as a prompt.',
	list: '`proto list` is not a top-level command. Use `proto plugin list` to list installed plugins, or run `proto launch list` if you meant to send "list" as a prompt.',
	remove:
		'`proto remove` is not a top-level command. Use `proto plugin uninstall <name>` to remove a plugin, or run `proto launch remove` if you meant to send "remove" as a prompt.',
	uninstall:
		'`proto uninstall` is not a top-level command. Use `proto plugin uninstall <name@marketplace>` to remove a plugin, or run `proto launch uninstall` if you meant to send "uninstall" as a prompt.',
	marketplace:
		'`proto marketplace` is not a top-level command. Use `proto plugin marketplace <add|remove|update|list>` to manage marketplaces, or run `proto launch marketplace` if you meant to send "marketplace" as a prompt.',
	discover:
		'`proto discover` is not a top-level command. Use `proto plugin discover [marketplace]` to browse available plugins, or run `proto launch discover` if you meant to send "discover" as a prompt.',
	upgrade:
		'`proto upgrade` is not a top-level command. Use `proto plugin upgrade [name@marketplace]` to upgrade plugins, or run `proto launch upgrade` if you meant to send "upgrade" as a prompt.',
	enable:
		'`proto enable` is not a top-level command. Use `proto plugin enable <name@marketplace>` to enable a plugin, or run `proto launch enable` if you meant to send "enable" as a prompt.',
	disable:
		'`proto disable` is not a top-level command. Use `proto plugin disable <name@marketplace>` to disable a plugin, or run `proto launch disable` if you meant to send "disable" as a prompt.',
	mcp: '`proto mcp` is not a top-level command. Configure MCP servers with `proto config` (or `.mcp.json`) and inspect them with `/mcp` inside a session, or run `proto launch mcp` if you meant to send "mcp" as a prompt.',
};

const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

function reservedTopLevelWordMessage(argv: readonly string[]): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hint = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hint) return undefined;
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

/** Longest edit distance still treated as a typo, by word length. */
function typoTolerance(word: string): number {
	if (word.length <= 3) return 0;
	return word.length <= 5 ? 1 : 2;
}

/**
 * A lone bare word that almost spells a command is a typo, not a prompt: `proto modles` should say
 * so instead of silently opening the TUI with "modles" typed in.
 */
function misspelledCommandMessage(argv: readonly string[]): string | undefined {
	if (argv.length !== 1) return undefined;
	const word = argv[0];
	if (!word || !/^[a-z][a-z0-9-]*$/.test(word) || isSubcommand(word)) return undefined;
	const tolerance = typoTolerance(word);
	if (tolerance === 0) return undefined;
	const names = commands.filter(entry => !entry.name.startsWith("__")).map(entry => entry.name);
	let best: { name: string; distance: number } | undefined;
	for (const name of names) {
		const distance = levenshteinDistance(word, name);
		if (distance <= tolerance && (best === undefined || distance < best.distance)) {
			best = { name, distance };
		}
	}
	if (!best) return undefined;
	return `\`${BINARY_NAME} ${word}\` is not a command. Did you mean \`${BINARY_NAME} ${best.name}\`? Run \`${BINARY_NAME} launch ${word}\` to send "${word}" as a prompt.`;
}

export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

type ResolvedCliArgv = { argv: string[]; configFiles?: string[] } | { error: string };

function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

export const LAUNCH_FLAG_COMMANDS: Record<string, true> = { launch: true, acp: true };

function isLaunchGlobalFlag(arg: string): boolean {
	const eq = arg.indexOf("=");
	const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
	return STRING_VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name) || VALUELESS_FLAGS.has(name);
}

/**
 * Subcommands cannot parse launch flags, so leading ones are dropped — except `--config`, whose
 * overlays decide what every command reads. Those travel on so `proto --config x config get y`
 * answers for the overlay instead of ignoring it.
 */
function stripLaunchGlobalFlags(leading: readonly string[]): { kept: string[]; configFiles: string[] } {
	const kept: string[] = [];
	const configFiles: string[] = [];
	for (let index = 0; index < leading.length; index += 1) {
		const arg = leading[index];
		if (isLaunchGlobalFlag(arg)) {
			const consumesValue = flagConsumesValue(arg, leading[index + 1]);
			if (arg === "--config" && consumesValue) configFiles.push(leading[index + 1]);
			else if (arg.startsWith("--config=")) configFiles.push(arg.slice("--config=".length));
			if (consumesValue) index += 1;
			continue;
		}
		kept.push(arg);
	}
	return { kept, configFiles };
}

export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv) ?? misspelledCommandMessage(argv);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };

	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		const sub = argv[subIndex];
		const leading = argv.slice(0, subIndex);
		const trailing = argv.slice(subIndex + 1);
		if (LAUNCH_FLAG_COMMANDS[sub] === true) return { argv: [sub, ...leading, ...trailing] };
		const stripped = stripLaunchGlobalFlags(leading);
		return { argv: [sub, ...stripped.kept, ...trailing], configFiles: stripped.configFiles };
	}
	return { argv: ["launch", ...argv] };
}
