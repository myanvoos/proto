import { Command } from "@oh-my-pi/pi-utils/cli";
import { galleryHelp as commandHelp } from "../cli/command-help";
import { type GalleryState, parseGalleryStates, runGalleryCommand } from "../cli/gallery-cli";
import { validatePositiveIntegerFlag } from "../cli/usage-error";

export default class Gallery extends Command {
	static description = commandHelp.description;
	static flags = commandHelp.flags;

	async run(): Promise<void> {
		const { flags } = await this.parse(Gallery);
		validatePositiveIntegerFlag("width", flags.width);
		let states: GalleryState[] | undefined;
		try {
			states = parseGalleryStates(flags.state);
		} catch (err) {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await runGalleryCommand({
			tool: flags.tool,
			states,
			width: flags.width,
			expanded: flags.expanded,
			plain: flags.plain,
			screenshot: flags.screenshot,
			out: flags.out,
			font: flags.font,
			fontSize: flags["font-size"],
		});
	}
}
