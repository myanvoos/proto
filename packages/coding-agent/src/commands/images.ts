import { Command } from "@oh-my-pi/pi-utils/cli";
import { imagesHelp as commandHelp } from "../cli/command-help";
import { type ImagesAction, type ImagesCommandArgs, runImagesCommand } from "../cli/images-cli";

export default class Images extends Command {
	static description = commandHelp.description;
	static aliases = ["img"];
	static args = commandHelp.args;
	static flags = commandHelp.flags;
	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Images);
		const command: ImagesCommandArgs = {
			action: (args.action ?? "status") as ImagesAction,
			flags: {
				json: flags.json,
				apply: flags.apply,
				all: flags.all,
				dir: flags.dir,
				timeout: flags.timeout,
			},
		};
		const result = await runImagesCommand(command);
		if (result.exitCode !== 0) process.exitCode = result.exitCode;
	}
}
