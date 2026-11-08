import { GrepOutputMode } from "@oh-my-pi/pi-natives";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { grepHelp as commandHelp } from "../cli/command-help";
import { type GrepCommandArgs, runGrepCommand } from "../cli/grep-cli";
import { Settings } from "../config/settings";
import { initTheme } from "../modes/theme/theme";
import { protofsCommand } from "../protofs/settings";

export default class Grep extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grep);

		const mode: GrepCommandArgs["mode"] = flags.count
			? GrepOutputMode.Count
			: flags.files
				? GrepOutputMode.FilesWithMatches
				: GrepOutputMode.Content;

		const cmd: GrepCommandArgs = {
			pattern: args.pattern ?? "",
			path: args.path ?? ".",
			glob: flags.glob,
			limit: flags.limit,
			context: flags.context,
			mode,
			gitignore: !flags["no-gitignore"],
			protofs: protofsCommand(await Settings.loadReadOnly()),
		};

		await initTheme();
		await runGrepCommand(cmd);
	}
}
