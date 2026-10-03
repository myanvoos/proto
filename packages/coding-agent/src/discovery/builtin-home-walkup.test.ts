import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { clearCache } from "../capability/fs";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext } from "../capability/types";
import "./builtin";

let tempDir: string;
let home: string;

async function loadNative<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const native = getCapability<T>(capabilityId)?.providers.find(provider => provider.id === "native");
	if (!native) throw new Error(`native provider missing for ${capabilityId}`);
	return (await native.load(ctx)).items;
}

beforeEach(async () => {
	clearCache();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-home-walkup-"));
	home = path.join(tempDir, "home");
	await Bun.write(path.join(home, ".proto", "SYSTEM.md"), "operator system prompt\n");
	await Bun.write(path.join(home, ".proto", "RULES.md"), "operator rule\n");
	await Bun.write(path.join(home, ".proto", "AGENTS.md"), "operator agents\n");
	await Bun.write(
		path.join(home, ".proto", "skills", "operator", "SKILL.md"),
		"---\nname: operator\ndescription: operator skill\n---\nbody\n",
	);
});

afterEach(async () => {
	clearCache();
	await fs.rm(tempDir, { recursive: true, force: true });
});

test("a cwd under home without a repo does not load ~/.proto as project config", async () => {
	const cwd = path.join(home, "scratch", "work");
	await fs.mkdir(cwd, { recursive: true });
	const ctx: LoadContext = { cwd, home, repoRoot: null };
	const fromHome = (item: { path: string }) => item.path.startsWith(path.join(home, ".proto") + path.sep);

	expect((await loadNative<SystemPrompt>(systemPromptCapability.id, ctx)).filter(fromHome)).toEqual([]);
	expect((await loadNative<Rule>(ruleCapability.id, ctx)).filter(fromHome)).toEqual([]);
	expect((await loadNative<ContextFile>(contextFileCapability.id, ctx)).filter(fromHome)).toEqual([]);
	expect((await loadNative<Skill>(skillCapability.id, ctx)).filter(fromHome)).toEqual([]);
});

test("a project .proto below home still loads", async () => {
	const project = path.join(home, "project");
	await Bun.write(path.join(project, ".proto", "RULES.md"), "project rule\n");
	const ctx: LoadContext = { cwd: path.join(project, "src"), home, repoRoot: null };
	await fs.mkdir(ctx.cwd, { recursive: true });

	const rules = await loadNative<Rule>(ruleCapability.id, ctx);

	expect(rules.map(rule => rule.path)).toContain(path.join(project, ".proto", "RULES.md"));
});
