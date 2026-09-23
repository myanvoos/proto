import * as path from "node:path";

import { Command } from "@oh-my-pi/pi-utils/cli";
import { ttsrHelp as commandHelp, type TTSR_ACTIONS } from "../cli/command-help";
import { runTtsrCommand, type TtsrCommandArgs, type TtsrScanArgs, type TtsrTestArgs } from "../cli/ttsr-cli";
import type { TtsrMatchSource } from "../export/ttsr";

export default class Ttsr extends Command {
	static description = commandHelp.description;
	static args = commandHelp.args;

	static flags = commandHelp.flags;

	static examples = commandHelp.examples;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ttsr);
		const action = (args.action ?? "list") as (typeof TTSR_ACTIONS)[number];

		let file = flags.file;
		let snippet = args.snippet;
		if (action === "test" && snippet && !file) {
			const resolved = path.resolve(snippet);
			if (await Bun.file(resolved).exists()) {
				file = resolved;
				snippet = undefined;
			}
		}

		const test: TtsrTestArgs | undefined =
			action === "test"
				? {
						snippet,
						file,
						rule: flags.rule,
						source: flags.source as TtsrMatchSource | undefined,
						tool: flags.tool,
						filePath: flags.path,
						verbose: flags.verbose,
						llm: flags.llm,
					}
				: undefined;

		const scan: TtsrScanArgs | undefined =
			action === "scan"
				? {
						directory: args.snippet,
						rule: flags.rule,
						gitignore: !flags["no-gitignore"],
						maxBytes: flags["max-bytes"],
						verbose: flags.verbose,
					}
				: undefined;

		const cmd: TtsrCommandArgs = {
			action,
			test,
			scan,
			json: flags.json,
		};

		await runTtsrCommand(cmd);
	}
}
