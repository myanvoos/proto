import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { deleteManagedSkill, writeManagedSkill } from "./managed-skills";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const dir = await utils.TempDir.create("@managed-skill-root-");
	const agent = path.join(dir.path(), "agent");
	const target = path.join(dir.path(), "shared");
	await fs.mkdir(agent);
	await fs.mkdir(target);
	spyOn(utils, "getAgentDir").mockReturnValue(agent);
	return { dir, target, root: path.join(agent, "managed-skills") };
}

const skill = { name: "shared-skill", description: "Shared guidance", body: "Original body" };

test("a symlinked store creates, updates, and deletes skills in its target", async () => {
	const { dir, target, root } = await fixture();
	await using _cleanup = dir;
	await fs.symlink(target, root);
	await writeManagedSkill({ ...skill, action: "create" });
	const file = path.join(target, skill.name, "SKILL.md");
	expect(await Bun.file(file).text()).toContain("Original body");
	await writeManagedSkill({ ...skill, action: "update", body: "Updated body" });
	expect(await Bun.file(file).text()).toContain("Updated body");
	await deleteManagedSkill(skill.name);
	expect(await Bun.file(file).exists()).toBe(false);
	expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
});

test("a broken root link refuses writes without creating its missing target", async () => {
	const { dir, root, target } = await fixture();
	await using _cleanup = dir;
	const missing = path.join(target, "missing");
	await fs.symlink(missing, root);
	await expect(writeManagedSkill({ ...skill, action: "create" })).rejects.toThrow("broken symlink");
	expect(await Bun.file(path.join(missing, skill.name, "SKILL.md")).exists()).toBe(false);
});

test("a root link to a file refuses mutations and preserves the file", async () => {
	const { dir, root, target } = await fixture();
	await using _cleanup = dir;
	const file = path.join(target, "file");
	await Bun.write(file, "keep");
	await fs.symlink(file, root);
	await expect(writeManagedSkill({ ...skill, action: "create" })).rejects.toThrow("non-directory");
	await expect(deleteManagedSkill(skill.name)).rejects.toThrow("non-directory");
	expect(await Bun.file(file).text()).toBe("keep");
});

test("a shared root still refuses linked skill directories and linked skill files", async () => {
	const { dir, root, target } = await fixture();
	await using _cleanup = dir;
	await fs.symlink(target, root);
	const authored = path.join(dir.path(), "authored");
	await fs.mkdir(authored);
	await Bun.write(path.join(authored, "SKILL.md"), "User-authored");
	await fs.symlink(authored, path.join(target, skill.name));
	await expect(writeManagedSkill({ ...skill, action: "update" })).rejects.toThrow("symlink");
	await expect(deleteManagedSkill(skill.name)).rejects.toThrow("symlink");
	await fs.unlink(path.join(target, skill.name));
	await fs.mkdir(path.join(target, skill.name));
	const skillFile = path.join(target, skill.name, "SKILL.md");
	await fs.symlink(path.join(authored, "SKILL.md"), skillFile);
	await expect(writeManagedSkill({ ...skill, action: "update" })).rejects.toThrow("symlink");
	await fs.unlink(skillFile);
	await fs.link(path.join(authored, "SKILL.md"), skillFile);
	await expect(writeManagedSkill({ ...skill, action: "update" })).rejects.toThrow("hard links");
	expect(await Bun.file(path.join(authored, "SKILL.md")).text()).toBe("User-authored");
});
