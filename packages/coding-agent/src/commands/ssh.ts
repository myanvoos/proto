import { Command } from "@oh-my-pi/pi-utils/cli";
import { sshHelp as commandHelp } from "../cli/command-help";
import { runSSHCommand, type SSHAction, type SSHCommandArgs } from "../cli/ssh-cli";
import { initTheme } from "../modes/theme/theme";

export default class SSH extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SSH);
		const action = (args.action ?? "list") as SSHAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];

		const cmd: SSHCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				host: flags.host,
				user: flags.user,
				port: flags.port,
				key: flags.key,
				desc: flags.desc,
				scope: flags.scope as "project" | "user" | undefined,
			},
		};

		await initTheme();
		await runSSHCommand(cmd);
	}
}
