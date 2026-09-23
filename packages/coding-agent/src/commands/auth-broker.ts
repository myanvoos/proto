import { Command, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";
import { type AuthBrokerAction, type AuthBrokerCommandArgs, runAuthBrokerCommand } from "../cli/auth-broker-cli";
import { authBrokerHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthBroker extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthBroker);
		if (!args.action) {
			renderCommandHelp(BINARY_NAME, "auth-broker", AuthBroker);
			return;
		}
		const action = args.action as AuthBrokerAction;
		const cmd: AuthBrokerCommandArgs = {
			action,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				via: flags.via,

				provider: action === "import" ? flags.provider : (args.source ?? flags.provider),
				source: args.source,
				includeDisabled: flags["include-disabled"],
				fromLocal: flags["from-local"],
				includeEnv: flags["include-env"],
				includeOauth: flags["include-oauth"],
				dryRun: flags["dry-run"],
			},
		};
		await initTheme();
		await runAuthBrokerCommand(cmd);
	}
}
