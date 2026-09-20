import type { BuiltinSlashCommand } from "../../slash-commands/types";
import { escapeTableCell } from "./tools-markdown";

interface HelpMarkdownBindings {
	/** Builtin slash commands in registry order (related commands sit together). */
	commands: ReadonlyArray<Pick<BuiltinSlashCommand, "name" | "aliases" | "description">>;
}

export function buildHelpMarkdown(bindings: HelpMarkdownBindings): string {
	const rows = bindings.commands.map(command => {
		const aliases = (command.aliases ?? []).map(alias => `\`/${alias}\``).join(", ");
		return `| \`/${command.name}\` | ${aliases} | ${escapeTableCell(command.description)} |`;
	});
	return [
		"**Commands**",
		"| Command | Aliases | Description |",
		"|---------|---------|-------------|",
		...rows,
		"",
		"**See also**",
		"- `/hotkeys` — keyboard shortcuts",
		"- `/settings` — open the settings menu",
		"- `/tools` — tools currently visible to the agent",
		"- `/model` — switch the model for this session",
		"- `/resume` — resume a different session",
		"- `proto://` — internal documentation URLs; type `proto://` in the prompt to browse them",
	].join("\n");
}
