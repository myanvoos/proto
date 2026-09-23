import { Command } from "@oh-my-pi/pi-utils/cli";
import { tinyModelsHelp as commandHelp } from "../cli/command-help";
import { runTinyModelsCommand, type TinyModelsAction, type TinyModelsCommandArgs } from "../cli/tiny-models-cli";

export default class TinyModels extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(TinyModels);
		const command: TinyModelsCommandArgs = {
			action: (args.action ?? "download") as TinyModelsAction,
			model: args.model,
			flags: {
				json: flags.json,
			},
		};
		await runTinyModelsCommand(command);
	}
}
