import { Command } from "@oh-my-pi/pi-utils/cli";
import { shellHelp as commandHelp } from "../cli/command-help";
import { runShellCommand, type ShellCommandArgs } from "../cli/shell-cli";
import { initTheme } from "../modes/theme/theme";

export default class Shell extends Command {
	static description = commandHelp.description;
	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { flags } = await this.parse(Shell);

		const cmd: ShellCommandArgs = {
			cwd: flags.cwd,
			timeoutMs: flags.timeout,
			noSnapshot: flags["no-snapshot"],
		};

		await initTheme();
		await runShellCommand(cmd);
	}
}
