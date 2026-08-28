import { postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { commitHelp as commandHelp } from "../cli/command-help";
import { CommitAbortedError, runCommitCommand } from "../commit";
import type { CommitCommandArgs } from "../commit/types";
import { initTheme } from "../modes/theme/theme";

export default class Commit extends Command {
	static description = commandHelp.description;
	static flags = {
		push: Flags.boolean({ description: "Push after committing" }),
		"dry-run": Flags.boolean({ description: "Preview without committing" }),
		"no-changelog": Flags.boolean({ description: "Skip changelog updates" }),
		legacy: Flags.boolean({ description: "Use legacy deterministic pipeline" }),
		context: Flags.string({ char: "c", description: "Additional context for the model" }),
		model: Flags.string({ char: "m", description: "Override model selection" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Commit);

		const cmd: CommitCommandArgs = {
			push: flags.push ?? false,
			dryRun: flags["dry-run"] ?? false,
			noChangelog: flags["no-changelog"] ?? false,
			legacy: flags.legacy,
			context: flags.context,
			model: flags.model,
		};

		await initTheme();

		let exitCode = 0;
		try {
			const { usedFallback } = await runCommitCommand(cmd);

			if (usedFallback) exitCode = 1;
		} catch (error) {
			if (!(error instanceof CommitAbortedError)) throw error;

			exitCode = 1;
		}
		await postmortem.quit(exitCode);
	}
}
