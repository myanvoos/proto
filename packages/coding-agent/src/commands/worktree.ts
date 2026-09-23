import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { worktreeHelp as commandHelp } from "../cli/command-help";
import { clearWorktrees, listWorktrees } from "../cli/worktree-cli";
import { Settings } from "../config/settings";

export default class Worktree extends Command {
	static description = commandHelp.description;
	static aliases = ["wt"];

	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Worktree);

		await Settings.init({ cwd: getProjectDir() });
		if (args.action === "clear") {
			await clearWorktrees({
				all: flags.all ?? false,
				dryRun: flags["dry-run"] ?? false,
				json: flags.json ?? false,
			});
			return;
		}
		await listWorktrees({ json: flags.json ?? false });
	}
}
