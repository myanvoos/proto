import { runPauseScreen } from "../modes/components/pause-screen";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
