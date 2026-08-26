/**
 * Workflow commands for orchestrating multi-agent workflows.
 */
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { loadCapability } from "../discovery";

/** Workflow command definition */
export interface WorkflowCommand {
	name: string;
	description: string;
	instructions: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

/** Extract string value from frontmatter field */
function getString(frontmatter: Record<string, unknown>, key: string): string {
	const value = frontmatter[key];
	return typeof value === "string" ? value : "";
}

/**
 * Discover all available commands.
 *
 * Precedence (highest wins): .proto > .pi > .claude (project before user)
 */
export async function discoverCommands(cwd: string): Promise<WorkflowCommand[]> {
	const resolvedCwd = path.resolve(cwd);

	// Load slash commands from capability API
	const result = await loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: resolvedCwd });

	const commands: WorkflowCommand[] = [];
	const seen = new Set<string>();

	// Convert SlashCommand to WorkflowCommand format
	for (const cmd of result.items) {
		if (seen.has(cmd.name)) continue;

		const { frontmatter, body } = parseFrontmatter(cmd.content, {
			source: cmd.path ?? `workflow-command:${cmd.name}`,
			level: cmd.level === "native" ? "fatal" : "warn",
		});

		// Map capability levels to WorkflowCommand source
		const source: "bundled" | "user" | "project" = cmd.level === "native" ? "bundled" : cmd.level;

		commands.push({
			name: cmd.name,
			description: getString(frontmatter, "description"),
			instructions: body,
			source,
			filePath: cmd.path,
		});
		seen.add(cmd.name);
	}

	return commands;
}

/**
 * Get a command by name.
 */
export function getCommand(commands: WorkflowCommand[], name: string): WorkflowCommand | undefined {
	return commands.find(c => c.name === name);
}

/**
 * Expand command instructions with task input.
 * Replaces $@ with the provided input.
 */
export function expandCommand(command: WorkflowCommand, input: string): string {
	// Function replacement so `$`-patterns in user input ($$, $&, ...) stay literal.
	return command.instructions.replace(/\$@/g, () => input);
}
