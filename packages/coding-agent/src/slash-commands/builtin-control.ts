import { runPauseScreen } from "../modes/components/pause-screen";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "pause",
		scope: "application",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		scope: "application",
		aliases: ["q"],
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "update",
		scope: "application",
		description: "Update proto, then resume this session in the new version",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			void runtime.ctx.updateAndRestart();
			return commandConsumed();
		},
	},
];
