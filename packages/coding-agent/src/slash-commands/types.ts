import type { Settings } from "../config/settings";
import type { InteractiveModeContext, SubmittedUserInput } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

export interface SubcommandDef {
	name: string;
	description: string;

	usage?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	aliases?: string[];
	description: string;

	allowArgs?: boolean;

	subcommands?: SubcommandDef[];

	inlineHint?: string;

	getTuiAutocompleteDescription?: (runtime: TuiSlashCommandRuntime) => string | undefined;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
	text: string;
}

export type SlashCommandResult = undefined | { consumed: true } | { prompt: string };

export interface SlashCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;

	output: (text: string) => Promise<void> | void;

	refreshCommands: () => Promise<void> | void;

	reloadPlugins: () => Promise<void>;

	runCommandInBackground?: (task: () => Promise<void>) => void;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

export interface TuiSlashCommandRuntime {
	ctx: InteractiveModeContext;

	input?: Pick<SubmittedUserInput, "images" | "imageLinks">;

	draftDetached?: boolean;
}

export interface SlashCommandSpec extends BuiltinSlashCommand {
	allowArgs?: boolean;

	acpDescription?: string;

	acpInputHint?: string;

	handle?:
		| ((
				command: ParsedSlashCommand,
				runtime: SlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: SlashCommandRuntime) => void | Promise<void>);

	handleTui?:
		| ((
				command: ParsedSlashCommand,
				runtime: TuiSlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime) => void | Promise<void>);
}

export type AcpBuiltinSlashCommandResult = false | { consumed: true } | { prompt: string };
