import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { launchHelp } from "./launch-help";

export default class Index extends Command {
	static description = launchHelp.description;
	static hidden = launchHelp.hidden;
	static args = launchHelp.args;
	static flags = launchHelp.flags;
	static examples = launchHelp.examples;

	static strict = false;

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		// Clients that launch `proto --mode acp` get `proto --mode acp --acp-terminal-auth` for terminal auth.
		await runRootCommand(parsed, args, terminalAuth ? { acpTerminalAuth: true } : undefined);
	}
}
