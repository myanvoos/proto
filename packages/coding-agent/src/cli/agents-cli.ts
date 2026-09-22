import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { YAML } from "bun";
import { theme } from "../modes/theme/theme";
import { loadBundledAgents } from "../task/agents";
import type { AgentDefinition } from "../task/types";

export type AgentsAction = "unpack";

export interface AgentsCommandArgs {
	action: AgentsAction;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir !== undefined) {
		// An empty --dir is a mistake (usually an unset shell variable), never a request to
		// fall back to the user profile: writing agents somewhere the caller did not name is
		// the one outcome they cannot have wanted.
		const dir = flags.dir.trim();
		if (dir.length === 0) {
			throw new CliUsageError("--dir requires a directory path; received an empty value.");
		}
		return path.resolve(getProjectDir(), dir);
	}

	if (flags.user && flags.project) {
		throw new CliUsageError("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".proto", "agents");
	}

	return path.join(getAgentDir(), "agents");
}

function toFrontmatter(agent: AgentDefinition): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
	};

	if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
	if (agent.spawns !== undefined) frontmatter.spawns = agent.spawns;
	if (agent.model && agent.model.length > 0) frontmatter.model = agent.model;
	if (agent.thinkingLevel) frontmatter.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) frontmatter.output = agent.output;

	return frontmatter;
}

function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = YAML.stringify(toFrontmatter(agent), null, 2).trimEnd();
	const body = agent.systemPrompt.trim();
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function describeFsError(error: unknown): string {
	if (error instanceof Error && "code" in error && error.code) return String(error.code);
	return error instanceof Error ? error.message : String(error);
}

/** Targets that cannot be written, each with the reason a write would fail. */
async function collectUnwritableTargets(
	targetDir: string,
	filePaths: readonly string[],
): Promise<Array<{ filePath: string; reason: string }>> {
	if (filePaths.length === 0) return [];

	try {
		await fs.access(targetDir, fs.constants.W_OK | fs.constants.X_OK);
	} catch (error) {
		return filePaths.map(filePath => ({
			filePath,
			reason: `${targetDir} is not writable (${describeFsError(error)})`,
		}));
	}

	const blocked: Array<{ filePath: string; reason: string }> = [];
	for (const filePath of filePaths) {
		let stats: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stats = await fs.stat(filePath);
		} catch (error) {
			// Absent files inherit the directory permission checked above.
			if (!isEnoent(error)) blocked.push({ filePath, reason: describeFsError(error) });
			continue;
		}
		if (stats.isDirectory()) {
			blocked.push({ filePath, reason: "EISDIR (a directory occupies this path)" });
			continue;
		}
		try {
			await fs.access(filePath, fs.constants.W_OK);
		} catch (error) {
			blocked.push({ filePath, reason: describeFsError(error) });
		}
	}
	return blocked;
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	try {
		await fs.mkdir(targetDir, { recursive: true });
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
		throw new CliUsageError(
			`Cannot create the agents directory ${targetDir}: ${code ?? (error instanceof Error ? error.message : String(error))}.`,
		);
	}

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const pending: Array<{ agent: AgentDefinition; filePath: string }> = [];
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}

		pending.push({ agent, filePath });
	}

	// Unpacking is a batch: a run that overwrites half the agents and then dies on a
	// read-only file leaves a directory nobody can reason about. Prove every target is
	// writable before the first byte lands, the way the target directory itself is checked.
	const blocked = await collectUnwritableTargets(
		targetDir,
		pending.map(entry => entry.filePath),
	);
	if (blocked.length > 0) {
		const details = blocked.map(entry => `  ${entry.filePath}: ${entry.reason}`).join("\n");
		throw new CliUsageError(
			`Cannot write ${blocked.length} of ${pending.length} agent file(s) in ${targetDir}. Nothing was written.\n${details}`,
		);
	}

	for (const { agent, filePath } of pending) {
		try {
			await Bun.write(filePath, serializeAgent(agent));
		} catch (error) {
			throw new CliUsageError(
				`Failed to write ${filePath}: ${describeFsError(error)}. ` +
					`${written.length} of ${pending.length} agent file(s) were already written: ${written.join(", ") || "none"}.`,
			);
		}
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
	}
}
