import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import {
	type CommandScope,
	captureSessionCommandTarget,
	isSessionCommandTargetCurrent,
} from "../session/command-target";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { BUILTIN_TRAJECTORY_SLASH_COMMANDS } from "./builtin-trajectory";
import { clearSubmittedText } from "./helpers/draft";
import { parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
	...BUILTIN_TRAJECTORY_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

export async function executeBuiltinSlashCommand(text: string, runtime: BuiltinSlashCommandRuntime): Promise<boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		// A known builtin invoked with unsupported arguments is a usage error,
		// not an unknown command: consume it instead of leaking the literal
		// text to the model as a prompt.
		runtime.ctx.showStatus(`/${parsed.name} does not take arguments`);
		return true;
	}
	const scope = resolveBuiltinCommandScope(command, parsed);
	const session = scope === "node" ? runtime.ctx.viewSession : runtime.ctx.session;
	runtime = {
		...runtime,
		target:
			scope === "application"
				? undefined
				: scope === "node" && runtime.target
					? runtime.target
					: captureSessionCommandTarget(session),
	};
	if (scope === "node" && runtime.target && !isSessionCommandTargetCurrent(runtime.target, runtime.ctx.viewSession)) {
		runtime.ctx.showStatus("Selection expired: the session changed");
		return true;
	}
	if (command.handleTui) {
		await command.handleTui(parsed, runtime);
		return true;
	}
	if (command.handle) {
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: runtime.target?.session ?? session,
			sessionManager: runtime.target?.sessionManager ?? session.sessionManager,
			settings: ctx.settings,
			cwd: (runtime.target?.sessionManager ?? session.sessionManager).getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		await command.handle(parsed, adapted);
		clearSubmittedText(runtime);
		return true;
	}
	return false;
}

export function resolveBuiltinCommandScope(command: SlashCommandSpec, parsed: ParsedSlashCommand): CommandScope {
	return typeof command.scope === "function" ? command.scope(parsed) : command.scope;
}

export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
