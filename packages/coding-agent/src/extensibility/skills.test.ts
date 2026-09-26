import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillPromptMessage } from "./skills";

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
