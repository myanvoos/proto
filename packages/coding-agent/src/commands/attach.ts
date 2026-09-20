import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { type AttachCommandArgs, runAttachCommand } from "../session-host/attach-cli";

export default class Attach extends Command {
	static description = commandHelp.description;

	static args = {
		session: Args.string({
			description: "Session id or file path (default: most recent session for the project)",
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({ description: "Project directory the session belongs to (default: cwd)" }),
		messages: Flags.integer({ description: "Number of recent messages to replay on attach (default 10)" }),
		stop: Flags.boolean({ description: "Stop the daemon-supervised session host instead of attaching" }),
	};

	static examples = ["proto attach", "proto attach <session-id>", "proto attach --stop <session-id>"];

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
