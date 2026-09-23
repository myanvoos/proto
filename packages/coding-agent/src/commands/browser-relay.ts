import { Command } from "@oh-my-pi/pi-utils/cli";
import { type BrowserRelayAction, runBrowserRelayCommand } from "../cli/browser-relay-cli";
import { browserRelayHelp as commandHelp } from "../cli/command-help";

export default class BrowserRelay extends Command {
	static description = commandHelp.description;

	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		await runBrowserRelayCommand({
			action: (args.action as BrowserRelayAction | undefined) ?? "serve",
			port: flags.port,
			token: flags.token,
			dir: flags.dir,
			group: !flags["no-group"],
			verbose: flags.verbose,
		});
	}
}
