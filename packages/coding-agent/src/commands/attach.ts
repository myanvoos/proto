import { Command } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { type AttachCommandArgs, runAttachCommand } from "../session-host/attach-cli";

export default class Attach extends Command {
	static description = commandHelp.description;

	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Attach);
		const command: AttachCommandArgs = {
			session: args.session,
			dir: flags.dir,
			messages: flags.messages,
			stop: flags.stop === true,
		};
		await runAttachCommand(command);
	}
}
