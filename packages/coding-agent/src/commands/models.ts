import { Command } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

export default class Models extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;
	static flags = commandHelp.flags;
	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
