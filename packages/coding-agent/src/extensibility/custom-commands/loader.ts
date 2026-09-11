import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import { getAgentDir, getProjectDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getConfigDirs } from "../../config";

import { execCommand } from "../../exec/exec";

import { ReviewCommand } from "./bundled/review";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./types";

const arktype = Object.assign(Function.prototype.bind.call(type, undefined) as typeof type, type, { type });

async function loadCommandModule(
	commandPath: string,
	_cwd: string,
	sharedApi: CustomCommandAPI,
): Promise<{ commands: CustomCommand[] | null; error: string | null }> {
	try {
		const module = await import(commandPath);
		const factory = (module.default ?? module) as CustomCommandFactory;

		if (typeof factory !== "function") {
			return { commands: null, error: "Command must export a default function" };
		}

		const result = await factory(sharedApi);
		const commands = Array.isArray(result) ? result : [result];

		for (const cmd of commands) {
			if (!cmd.name || typeof cmd.name !== "string") {
				return { commands: null, error: "Command must have a name" };
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				return { commands: null, error: `Command "${cmd.name}" must have a description` };
			}
			if (typeof cmd.execute !== "function") {
				return { commands: null, error: `Command "${cmd.name}" must have an execute function` };
			}
		}

		return { commands, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { commands: null, error: `Failed to load command: ${message}` };
	}
}

interface DiscoverCustomCommandsOptions {
	cwd?: string;

	agentDir?: string;
}

interface DiscoverCustomCommandsResult {
	paths: Array<{ path: string; source: CustomCommandSource }>;
}

export async function discoverCustomCommands(
	options: DiscoverCustomCommandsOptions = {},
): Promise<DiscoverCustomCommandsResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const paths: Array<{ path: string; source: CustomCommandSource }> = [];
	const seen = new Set<string>();

	const addPath = (commandPath: string, source: CustomCommandSource): void => {
		const resolved = path.resolve(commandPath);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		paths.push({ path: resolved, source });
	};

	const commandDirs: Array<{ path: string; source: CustomCommandSource }> = [];
	if (agentDir) {
		const userCommandsDir = path.join(agentDir, "commands");
		if (fs.existsSync(userCommandsDir)) {
			commandDirs.push({ path: userCommandsDir, source: "user" });
		}
	}

	for (const entry of getConfigDirs("commands", { cwd, existingOnly: true })) {
		const source = entry.level === "user" ? "user" : "project";
		if (!commandDirs.some(d => d.path === entry.path)) {
			commandDirs.push({ path: entry.path, source });
		}
	}

	const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	for (const { path: commandsDir, source } of commandDirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to read custom commands directory", { path: commandsDir, error: String(error) });
			}
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const commandDir = path.join(commandsDir, entry.name);

			for (const filename of indexCandidates) {
				const candidate = path.join(commandDir, filename);
				if (fs.existsSync(candidate)) {
					addPath(candidate, source);
					break;
				}
			}
		}
	}

	return { paths };
}

interface LoadCustomCommandsOptions {
	cwd?: string;

	agentDir?: string;
}

function loadBundledCommands(sharedApi: CustomCommandAPI): LoadedCustomCommand[] {
	const bundled: LoadedCustomCommand[] = [];

	bundled.push({
		path: "bundled:review",
		resolvedPath: "bundled:review",
		command: new ReviewCommand(sharedApi),
		source: "bundled",
	});

	return bundled;
}

export async function loadCustomCommands(options: LoadCustomCommandsOptions = {}): Promise<CustomCommandsLoadResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();

	const { paths } = await discoverCustomCommands({ cwd, agentDir });

	const commands: LoadedCustomCommand[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>();

	const sharedApi: CustomCommandAPI = {
		cwd,
		exec: (command: string, args: string[], execOptions) =>
			execCommand(command, args, execOptions?.cwd ?? cwd, execOptions),
		arktype,
		zod,
		pi: await import("../../index"),
	};

	for (const loaded of loadBundledCommands(sharedApi)) {
		seenNames.add(loaded.command.name);
		commands.push(loaded);
	}

	for (const { path: commandPath, source } of paths) {
		const { commands: loadedCommands, error } = await loadCommandModule(commandPath, cwd, sharedApi);

		if (error) {
			errors.push({ path: commandPath, error });
			continue;
		}

		if (loadedCommands) {
			for (const command of loadedCommands) {
				const existingIdx = commands.findIndex(c => c.command.name === command.name);
				if (existingIdx !== -1) {
					const existing = commands[existingIdx];
					if (existing.source === "bundled") {
						commands.splice(existingIdx, 1);
						seenNames.delete(command.name);
					} else {
						errors.push({
							path: commandPath,
							error: `Command name "${command.name}" conflicts with existing command`,
						});
						continue;
					}
				}

				seenNames.add(command.name);
				commands.push({
					path: commandPath,
					resolvedPath: path.resolve(commandPath),
					command,
					source,
				});
			}
		}
	}

	return { commands, errors };
}
