import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import type { AgentSession } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { buildReplanTitleContext, USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession } from "../session/session-listing";
import type { SessionManagerStateSnapshot } from "../session/session-manager";
import { isLowSignalTitleInput } from "../tiny/text";
import { resolveToCwd } from "../tools/path-utils";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	clearSubmittedText(runtime);
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Point the process, settings, provider globals, and plugin-derived state at `cwd` (the session's cwd). */
async function rescopeHeadlessToCwd(runtime: SlashCommandRuntime, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await runtime.settings.reloadForCwd(cwd);
	applyProviderGlobalsFromSettings(runtime.settings);
	await runtime.reloadPlugins();
}

/**
 * Undo a session move whose workspace could not follow it. When the transcript cannot be moved back, the workspace
 * follows the transcript instead; a session whose workspace cannot be aligned either way is closed.
 */
async function rollbackHeadlessMove(
	runtime: SlashCommandRuntime,
	previousState: SessionManagerStateSnapshot,
	moveError: unknown,
): Promise<SlashCommandResult> {
	try {
		await runtime.session.rollbackMove(previousState);
		await rescopeHeadlessToCwd(runtime, previousState.cwd);
		return usage(`Move failed: ${errorMessage(moveError)}`, runtime);
	} catch (rollbackError) {
		const actual = runtime.sessionManager.getCwd();
		try {
			await rescopeHeadlessToCwd(runtime, actual);
		} catch {
			await runtime.output(
				`Move failed and rollback failed: ${errorMessage(rollbackError)} (failed to re-align workspace to ${actual}; closing the session)`,
			);
			await runtime.session.dispose();
			return commandConsumed();
		}
		return usage(
			`Move failed and rollback failed: ${errorMessage(rollbackError)} (workspace remains at ${actual})`,
			runtime,
		);
	}
}

function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = ["Workspace directories:", `  ${cwd} (working directory)`, ...additional.map(d => `  ${d}`)];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}

/**
 * Generates a title from the conversation. Null: no usable title. Undefined: the request was interrupted or
 * superseded (session switch, newer rename) and must be dropped silently.
 */
async function generateRenameTitle(session: AgentSession, signal?: AbortSignal): Promise<string | null | undefined> {
	const { sessionManager } = session;
	const context = buildReplanTitleContext(session.messages);
	if (!context || isLowSignalTitleInput(context)) return null;
	const revision = sessionManager.reserveTitleRevision();
	const sessionId = sessionManager.getSessionId();
	const titleSignal = session.titleGenerationSignal;
	const cleanupProgress = session.notifyTitleGenerationStart();
	try {
		const title = await session.generateTitle(context, undefined, signal);
		return !titleSignal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === revision
			? title
			: undefined;
	} finally {
		cleanupProgress?.();
	}
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "Start a new session",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "clear",
		description: "Clear the conversation context in place, keeping the session",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "Clear: unavailable while streaming" : "Clear: drop context, keep session",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "compact",
		description: "Manually compact the session context",
		acpDescription: "Compact the conversation",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage ? `Compact: context ${Math.round(usage.percent)}% used` : "Compact: context unavailable";
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const runCompact = async (): Promise<void> => {
				const before = runtime.session.getContextUsage?.();
				const beforeTokens = before?.tokens;
				try {
					await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
				} catch (err) {
					if (err instanceof CompactionCancelledError && err.cause === USER_INTERRUPT_LABEL) return;

					await runtime.output(`Compaction failed: ${errorMessage(err)}`);
					return;
				}
				const after = runtime.session.getContextUsage?.();
				const afterTokens = after?.tokens;
				if (beforeTokens != null && afterTokens != null) {
					const saved = beforeTokens - afterTokens;
					await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
				} else {
					await runtime.output("Compaction complete.");
				}
			};

			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runCompact);
				return commandConsumed();
			}
			await runCompact();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			clearSubmittedText(runtime);
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "resume",
		description: "Resume a different session",
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			clearSubmittedText(runtime);
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`Session "${sessionArg}" not found`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "side",
		description:
			"Ask an ephemeral side question using the current session context, or delegate tangential work to a background agent via --agent",
		inlineHint: "<question> | --agent <work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const text = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			if (!text) {
				runtime.ctx.showStatus("Usage: /side <question> | /side --agent <work>");
				return;
			}
			if (text === "--agent" || text.startsWith("--agent ")) {
				await runtime.ctx.handleSideCommand("agent", text.slice("--agent".length).trim());
				return;
			}
			await runtime.ctx.handleSideCommand("question", text);
		},
	},
	{
		name: "rename",
		description: "Rename the current session (omit title to generate)",
		inlineHint: "[title]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const session = runtime.session;
			const sessionManager = runtime.sessionManager;
			const runRename = async (): Promise<void> => {
				const sessionId = sessionManager.getSessionId();
				const titleSignal = session.titleGenerationSignal;
				let titleRevision = sessionManager.titleRevision;
				// Every await below can be overtaken by a session switch, an interrupt, or a newer rename.
				const isCurrent = (): boolean =>
					runtime.session === session &&
					runtime.sessionManager === sessionManager &&
					!runtime.signal?.aborted &&
					!titleSignal.aborted &&
					sessionManager.getSessionId() === sessionId &&
					sessionManager.titleRevision === titleRevision;
				try {
					const generation = command.args || generateRenameTitle(session, runtime.signal);
					titleRevision = sessionManager.titleRevision;
					const title = typeof generation === "string" ? generation : await generation;
					if (!isCurrent() || title === undefined) return;
					if (!title) {
						await runtime.output("Could not generate a session title. Use /rename <title> to set one.");
						return;
					}
					const persistence = sessionManager.setSessionName(title, "user");
					titleRevision = sessionManager.titleRevision;
					const ok = await persistence;
					if (!isCurrent()) return;
					if (!ok) {
						await runtime.output("Session name not changed (a user-set name takes precedence).");
						return;
					}
					await runtime.notifyTitleChanged?.();
					if (!isCurrent()) return;
					await runtime.output(`Session renamed to ${title}.`);
				} catch (err) {
					if (!isCurrent()) return;
					if (command.args || !runtime.runCommandInBackground) throw err;
					await runtime.output(`Rename failed: ${errorMessage(err)}`);
				}
			};
			if (!command.args && runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runRename);
				return commandConsumed();
			}
			await runRename();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const session = runtime.ctx.session;
			const sessionManager = runtime.ctx.sessionManager;
			const sessionId = sessionManager.getSessionId();
			const titleSignal = session.titleGenerationSignal;
			const generation = command.args.trim() || generateRenameTitle(session);
			const titleRevision = sessionManager.titleRevision;
			const title = typeof generation === "string" ? generation : await generation;
			if (
				runtime.ctx.session !== session ||
				runtime.ctx.sessionManager !== sessionManager ||
				titleSignal.aborted ||
				sessionManager.getSessionId() !== sessionId ||
				sessionManager.titleRevision !== titleRevision ||
				title === undefined
			)
				return;
			if (!title) {
				runtime.ctx.showError("Could not generate a session title. Use /rename <title> to set one.");
				return;
			}
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "Move the current session to a different directory",
		acpDescription: "Move the current session to a different directory",
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot move while streaming.", runtime);
			if (!command.args) return usage("Usage: /move <path>", runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}`, runtime);
			}
			try {
				await runtime.settings.flush();
			} catch (err) {
				return usage(`Failed to save pending settings: ${errorMessage(err)}`, runtime);
			}
			const previousState = runtime.sessionManager.captureState();
			try {
				await runtime.session.moveSession(resolvedPath);
			} catch (err) {
				return usage(`Move failed: ${errorMessage(err)}`, runtime);
			}
			try {
				await rescopeHeadlessToCwd(runtime, resolvedPath);
			} catch (err) {
				return rollbackHeadlessMove(runtime, previousState, err);
			}
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`Moved to ${runtime.sessionManager.getCwd()}.`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		description: "Add a workspace directory to this session (multi-root)",
		acpDescription: "Add a workspace directory to this session",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot add a directory while streaming.", runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, "Usage: /add-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(`Not a directory: ${resolved}`, runtime);
			} catch {
				return usage(`Directory does not exist: ${resolved}`, runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(`Already in the workspace: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Added ${added}.`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		description: "Remove a workspace directory from this session",
		acpDescription: "Remove a workspace directory from this session",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("Cannot remove a directory while streaming.", runtime);
			if (!command.args) return usage("Usage: /remove-dir <path>", runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage("Cannot remove the working directory; use /move to change it.", runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(`Not a workspace directory: ${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Removed ${removed}.`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: "List this session's workspace directories",
		acpDescription: "List this session's workspace directories",
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: "Exit the application",
		handleTui: shutdownHandlerTui,
	},
];
