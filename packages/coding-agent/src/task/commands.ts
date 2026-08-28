import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { loadCapability } from "../discovery";

export interface WorkflowCommand {
	name: string;
	description: string;
	instructions: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

function getString(frontmatter: Record<string, unknown>, key: string): string {
	const value = frontmatter[key];
	return typeof value === "string" ? value : "";
}

export async function discoverCommands(cwd: string): Promise<WorkflowCommand[]> {
	const resolvedCwd = path.resolve(cwd);

	const result = await loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: resolvedCwd });

	const commands: WorkflowCommand[] = [];
	const seen = new Set<string>();

	for (const cmd of result.items) {
		if (seen.has(cmd.name)) continue;

		const { frontmatter, body } = parseFrontmatter(cmd.content, {
			source: cmd.path ?? `workflow-command:${cmd.name}`,
			level: cmd.level === "native" ? "fatal" : "warn",
		});

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

export function getCommand(commands: WorkflowCommand[], name: string): WorkflowCommand | undefined {
	return commands.find(c => c.name === name);
}

export function expandCommand(command: WorkflowCommand, input: string): string {
	return command.instructions.replace(/\$@/g, () => input);
}
