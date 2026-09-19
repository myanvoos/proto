import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { setupHelp as commandHelp } from "../cli/command-help";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { runRootCommand } from "../main";
import { initTheme } from "../modes/theme/theme";

interface OnboardingSetupDependencies {
	runRoot?: typeof runRootCommand;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	writeStderr?: (text: string) => void;
	exit?: (code: number) => never;
}

export async function runOnboardingSetup(deps: OnboardingSetupDependencies = {}): Promise<void> {
	const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
	if (!stdinIsTTY || !stdoutIsTTY) {
		(deps.writeStderr ?? (text => process.stderr.write(text)))("proto setup requires an interactive TTY.\n");
		(deps.exit ?? process.exit)(1);
		return;
	}
	await (deps.runRoot ?? runRootCommand)(parseArgs([]), [], { forceSetupWizard: true });
}

export default class Setup extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;
	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			if (flags.check || flags.json) {
				throw new CliUsageError("setup --check/--json requires a COMPONENT (python|speech)");
			}
			await runOnboardingSetup();
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
