import { BINARY_NAME, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { type CliConfig, CliUsageError, Command, type CommandCtor } from "@oh-my-pi/pi-utils/cli";
import { completionsHelp as commandHelp } from "../cli/command-help";
import { buildSpec, generateCompletion, type Shell } from "../cli/completion-gen";
import { commands } from "../cli-commands";

const ROOT_COMMAND = "launch";

export async function generateLiveCompletion(shell: Shell): Promise<string> {
	const loaded = await Promise.all(commands.map(async entry => ({ entry, Cmd: await entry.load() })));
	const map = new Map<string, CommandCtor>();
	const aliasMap = new Map<string, readonly string[]>();
	for (const { entry, Cmd } of loaded) {
		map.set(entry.name, Cmd);
		const merged = new Set<string>([...(Cmd.aliases ?? []), ...(entry.aliases ?? [])]);
		aliasMap.set(entry.name, [...merged]);
	}

	const config: CliConfig = { bin: BINARY_NAME, version: VERSION, commands: map };
	return generateCompletion(shell, buildSpec(config, ROOT_COMMAND, aliasMap));
}

export default class Completions extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		// Parsing (rather than reading argv[0]) is what rejects an unknown shell and a second
		// positional instead of quietly generating a script for the first one.
		const { args } = await this.parse(Completions);
		const shell = args.shell;
		if (!isShell(shell)) {
			throw new CliUsageError(
				`Expected shell to be one of: ${commandHelp.args.shell.options!.join(", ")}; got ${JSON.stringify(shell)}`,
			);
		}

		await Bun.write(Bun.stdout, await generateLiveCompletion(shell));
		await postmortem.quit(0);
	}
}

function isShell(value: string | undefined): value is Shell {
	return value === "bash" || value === "zsh" || value === "fish";
}
