import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

const manageSkillSchema = type({
	action: "'create' | 'update' | 'delete'",
	name: type("string").describe("kebab-case skill name"),
	"description?": type("string").describe(
		"one-line description of when to use the skill (required for create/update)",
	),
	"body?": type("string").describe("the SKILL.md body in markdown, no frontmatter (required for create/update)"),
}).narrow(
	(p, ctx) =>
		p.action === "delete" ||
		(p.description !== undefined && p.body !== undefined) ||
		ctx.mustBe('used with both "description" and "body" for "create" and "update"'),
);

type ManageSkillParams = typeof manageSkillSchema.infer;

export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly label = "Manage Skill";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Create, update, or delete an isolated managed skill";

	constructor(private readonly refreshSkills?: () => Promise<void>) {}

	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		return new ManageSkillTool(session.refreshSkills);
	}

	async execute(_id: string, params: ManageSkillParams): Promise<AgentToolResult> {
		if (params.action === "delete") {
			await deleteManagedSkill(params.name);
			await this.refreshSkills?.();
			return {
				content: [{ type: "text", text: `Deleted managed skill "${params.name}".` }],
				details: { action: "delete", name: params.name },
			};
		}

		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" requires both "description" and "body".`);
		}

		if (params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name))) {
			return {
				content: [
					{
						type: "text",
						text: `Cannot create managed skill "${params.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
					},
				],
				isError: true,
				details: { action: "create", name: params.name, shadowed: true },
			};
		}
		const { path: skillPath } = await writeManagedSkill({
			action: params.action,
			name: params.name,
			description: params.description,
			body: params.body,
		});
		await this.refreshSkills?.();
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "Created" : "Updated";
		return {
			content: [{ type: "text", text: `${verb} managed skill "${params.name}" (managed-skills/${relativePath}).` }],
			details: { action: params.action, name: params.name },
		};
	}
}
