import { postmortem } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { renderHelp as commandHelp } from "../cli/command-help";
import { runRenderCommand } from "../cli/render-cli";
import { validatePositiveIntegerFlag } from "../cli/usage-error";

export default class Render extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;
	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Render);
		validatePositiveIntegerFlag("width", flags.width);
		validatePositiveIntegerFlag("height", flags.height);
		validatePositiveIntegerFlag("repaint", flags.repaint);
		const exitCode = await runRenderCommand({
			session: args.session,
			width: flags.width,
			height: flags.height,
			timing: flags.timing,
			repaint: flags.repaint,
			plain: flags.plain,
			quiet: flags.quiet,
		});
		await postmortem.quit(exitCode);
	}
}
