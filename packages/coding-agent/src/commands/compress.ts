import { postmortem } from "@oh-my-pi/pi-utils";
import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { compressHelp as commandHelp } from "../cli/command-help";
import { runCompressCommand } from "../compress";

export default class Compress extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;
	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Compress);
		const files = args.files ?? [];
		if (files.length === 0) throw new CliUsageError("compress requires at least one file or glob pattern");
		if (flags.rounds <= 0) throw new CliUsageError("--rounds must be a positive integer");
		if (flags.agents <= 0) throw new CliUsageError("--agents must be a positive integer");
		if (flags.inPlace && flags.out) throw new CliUsageError("--in-place and --out are mutually exclusive");
		const result = await runCompressCommand({
			files,
			model: flags.model,
			maxRounds: flags.rounds,
			concurrency: flags.agents,
			output: flags.out,
			inPlace: flags.inPlace,
		});
		await postmortem.quit(result.exitCode);
	}
}
