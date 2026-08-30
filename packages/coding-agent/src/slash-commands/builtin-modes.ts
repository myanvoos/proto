import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import type { SettingPath, Settings } from "../config/settings";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import type { InspectMediaMode } from "../utils/inspect-media-mode";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		if (!submitted && ((runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0)) {
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

function formatExtendedContextStatus(settings: Settings): string {
	return settings.get("extendedContext") ? "on" : "off";
}

function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = settings.get("extendedContext");
	if (!arg || arg === "toggle") {
		const enabled = !current;
		settings.set("extendedContext", enabled);
		return `Extended context ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on") {
		settings.set("extendedContext", true);
		return "Extended context enabled.";
	}
	if (arg === "off") {
		settings.set("extendedContext", false);
		return "Extended context disabled.";
	}
	if (arg === "status") return `Extended context is ${formatExtendedContextStatus(settings)}.`;
	return undefined;
}

async function formatComputerUseStatus(session: AgentSession): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEnabledToolNames().includes("computer");
	const model = session.model;
	const modelName = model ? formatModelString(model) : "none";
	const exposure = !enabled
		? "not exposed (disabled)"
		: !active
			? "not exposed (tool inactive)"
			: computerExposureMode(model);
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	const computerTool = active
		? (session.getToolByName("computer") as Pick<ComputerTool, "capabilities"> | undefined)
		: undefined;
	const capabilities = await computerTool?.capabilities();
	const capabilityStatus = capabilities
		? [
				`backend=${capabilities.backend}${capabilities.displayServer ? `/${capabilities.displayServer}` : ""}`,
				`capture=${capabilities.capture} (${capabilities.capturePermission})`,
				`input=${capabilities.input} (${capabilities.inputPermission})`,
				`ax=${capabilities.ax} (${capabilities.axPermission})`,
				`backgroundWindowInput=${capabilities.backgroundWindowInput}`,
				`deliveryModes=${capabilities.deliveryModes.join(",") || "none"}`,
			].join(", ")
		: "session not started";
	return [
		`Computer use: ${enabled ? "enabled" : "disabled"}`,
		`tool: ${active ? "active" : "inactive"}`,
		`exposure: ${exposure}`,
		`model: ${modelName}`,
		`configured: display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
		`capabilities: ${capabilityStatus}`,
	].join(" · ");
}

async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const applied = await session.setComputerToolEnabled(enable);
	if (enable && !applied) {
		return "Computer use is unavailable in this session.";
	}
	session.settings.override("computer.enabled", enable);
	return enable
		? `Computer use enabled for this session. ${await formatComputerUseStatus(session)}`
		: "Computer use disabled for this session.";
}

function formatVisionStatus(session: AgentSession): string {
	const { mode, active, model } = session.inspectMediaState();
	const override = session.getInspectMediaModeOverride();
	const modelObj = session.model;
	const capability = modelObj
		? modelObj.input.includes("image")
			? "native image input"
			: "no native image input"
		: "no active model";
	return [
		`inspect_media: ${active ? "active" : "inactive"}`,
		`mode: ${mode}${override ? " (session override)" : ""}`,
		...(override ? [`configured: ${session.settings.get("inspect_media.mode")}`] : []),
		`model: ${model ?? "none"} (${capability})`,
	].join(" · ");
}

async function applyVisionMode(session: AgentSession, mode: InspectMediaMode): Promise<string> {
	const applied = await session.setInspectMediaMode(mode);
	if (!applied) {
		return "inspect_media is unavailable in this session.";
	}
	return `Vision mode: ${mode}. ${formatVisionStatus(session)}`;
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return "Goal: disabled in settings";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `Goal: ${state.goal.status} (${shortDetail(state.goal.objective)})` : "Goal: off";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Loop: off";
			if (runtime.ctx.loopModePaused) return "Loop: paused";
			if (runtime.ctx.loopLimit) return `Loop: on (${describeLoopLimitRuntime(runtime.ctx.loopLimit)})`;
			if (runtime.ctx.loopPrompt) return "Loop: on (repeating prompt)";
			return "Loop: on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");

			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "Model: none selected";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Fast: ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.",
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`Fast mode is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extended-context",
		description: "Toggle premium long-context windows",
		acpDescription: "Toggle extended context",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable premium long-context windows" },
			{ name: "off", description: "Use standard-pricing context windows" },
			{ name: "status", description: "Show extended context status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Extended context: ${formatExtendedContextStatus(runtime.ctx.settings)}`,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("Usage: /extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? "Usage: /extended-context [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		description: "Toggle the native computer-use tool for this session",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Computer: ${runtime.ctx.session.settings.get("computer.enabled") ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(await formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("Usage: /computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(await formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /computer [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vision",
		description: "Control the inspect_media media-delegation tool for this session",
		acpDescription: "Toggle vision delegation",
		acpInputHint: "[on|off|auto|status]",
		subcommands: [
			{ name: "on", description: "Always expose inspect_media this session" },
			{ name: "off", description: "Never expose inspect_media this session" },
			{ name: "auto", description: "Follow inspect_media.mode (auto hides it for vision-capable models)" },
			{ name: "status", description: "Show inspect_media status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Vision: ${runtime.ctx.session.inspectMediaState().mode}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatVisionStatus(runtime.session));
				return commandConsumed();
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				await runtime.output(await applyVisionMode(runtime.session, arg));
				return commandConsumed();
			}
			return usage("Usage: /vision [on|off|auto|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatVisionStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				runtime.ctx.showStatus(await applyVisionMode(runtime.ctx.session, arg));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /vision [on|off|auto|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		description: "Switch to a fast/cheap model at the next action (works even without --prewalk)",
		acpDescription: "Prewalk at the next action",
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? `Model "${rolePattern}" not found`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`No API key for ${resolved.model.provider}/${resolved.model.id}`, runtime);
			}
			const armed = runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk on: switching to ${resolved.model.provider}/${resolved.model.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
];
