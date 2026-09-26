import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import { parseInternalUrl } from "./parse";
import { SkillProtocolHandler } from "./skill-protocol";

async function withSkill(run: (handler: SkillProtocolHandler, skill: Skill) => Promise<void>): Promise<void> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-"));
	const skill: Skill = {
		name: "demo",
		description: "Test skill",
		baseDir,
		filePath: path.join(baseDir, "entry.txt"),
		source: "test",
	};
	try {
		await fs.writeFile(skill.filePath, "skill entry");
		await fs.writeFile(path.join(baseDir, "secret"), "in-root secret");
		await run(new SkillProtocolHandler(), skill);
	} finally {
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

test.each([
	"../secret",
	"%2e%2e/secret",
	"%2E%2E/secret",
	".%2e/secret",
	"%2e./secret",
	"nested/../secret",
	"nested/%2e%2e/secret",
	"%2e%2e%2fsecret",
	"%2e%2e%5csecret",
])("skill rejects parent segments before URL normalization: %s", async relativePath => {
	await withSkill(async (handler, skill) => {
		const url = parseInternalUrl(`skill://demo/${relativePath}`);
		await expect(handler.resolve(url, { skills: [skill] })).rejects.toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});
});

test("ordinary and encoded skill paths resolve after exactly one decode", async () => {
	await withSkill(async (handler, skill) => {
		await fs.mkdir(path.join(skill.baseDir, "%2e%2e"));
		await fs.writeFile(path.join(skill.baseDir, "%2e%2e", "secret"), "literal encoded directory");
		await fs.writeFile(path.join(skill.baseDir, "safe name.txt"), "safe name");
		const cases = [
			["skill://demo", "skill entry", skill.filePath],
			["skill://demo/secret", "in-root secret", path.join(skill.baseDir, "secret")],
			["skill://demo/%73ecret", "in-root secret", path.join(skill.baseDir, "secret")],
			["skill://demo/safe%20name.txt", "safe name", path.join(skill.baseDir, "safe name.txt")],
			["skill://demo/%252e%252e/secret", "literal encoded directory", path.join(skill.baseDir, "%2e%2e", "secret")],
		];
		for (const [input, content, sourcePath] of cases) {
			const result = await handler.resolve(parseInternalUrl(input), { skills: [skill] });
			expect(result.content).toBe(content);
			expect(result.sourcePath).toBe(sourcePath);
		}
	});
});
