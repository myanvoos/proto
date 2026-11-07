import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reset as resetCapabilities } from "../capability";
import { buildSkillPromptMessage, loadSkills } from "./skills";

for (const newline of ["\n", "\r\n"]) {
	for (const invocation of ["user", "autoload"] as const) {
		for (const body of ["# Fixture body", "# Fixture body\n<!-- Keep this comment -->\ntext", ""]) {
			test(`${invocation} skill extraction accepts ${JSON.stringify(newline)} frontmatter with ${body ? "body" : "closing EOF"}`, async () => {
				const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-skill-prompt-"));
				const filePath = path.join(baseDir, "SKILL.md");
				try {
					const content =
						["---", "name: metadata-only-name", "description: metadata-only-description", "---"].join(newline) +
						(body ? newline + body.replaceAll("\n", newline) : "");
					await fs.writeFile(filePath, content);
					const built = await buildSkillPromptMessage(
						{ name: "fixture", filePath, baseDir },
						" argument ",
						invocation,
					);
					expect(built.message).not.toContain("metadata-only-name");
					expect(built.message).not.toContain("metadata-only-description");
					if (body) expect(built.message).toContain(body);
					expect(built.details).toEqual({
						name: "fixture",
						path: filePath,
						args: "argument",
						lineCount: body ? body.split("\n").length : 0,
					});
				} finally {
					await fs.rm(baseDir, { recursive: true, force: true });
				}
			});
		}
	}
}

// A manual-only skill must stay invocable by name while dropping out of the model's skill listing.
test("manual-only patterns hide matching skills from the model listing", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-skill-manual-"));
	const skillDir = path.join(dir, "deploy");
	await fs.mkdir(skillDir);
	await fs.writeFile(
		path.join(skillDir, "SKILL.md"),
		"---\nname: deploy\ndescription: deploy the app\n---\nDeploy it.\n",
	);
	const options = {
		cwd: dir,
		customDirectories: [dir],
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enablePiUser: false,
		enablePiProject: false,
		enableAgentsUser: false,
		enableAgentsProject: false,
	};
	try {
		const visible = await loadSkills(options);
		const manual = await loadSkills({ ...options, manualSkills: ["dep*"] });
		expect(visible.skills.find(skill => skill.name === "deploy")?.hide).not.toBe(true);
		expect(manual.skills.find(skill => skill.name === "deploy")?.hide).toBe(true);
	} finally {
		resetCapabilities();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
