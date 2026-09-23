import { Command } from "@oh-my-pi/pi-utils/cli";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args } = await this.parse(Login);
		await runLoginCommand(args.provider);
	}
}
