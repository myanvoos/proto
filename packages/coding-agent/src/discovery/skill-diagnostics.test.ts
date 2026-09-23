import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// What a skill is worth is decided by what ends up in the model's context, so these cases run the real
// CLI against a local model server and read the system prompt it was sent.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const requestBodies: string[] = [];
const modelServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async request => {
		requestBodies.push(await request.text());
		return new Response(
			`data: ${JSON.stringify({ choices: [{ delta: { content: "SKILLS-OK" } }] })}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-skill-diagnostics-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const project = path.join(root, "project");
const outside = path.join(root, "outside");
const skillsDir = path.join(project, ".proto", "skills");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(outside, { recursive: true });

async function writeSkill(dir: string, content: string): Promise<void> {
	await fs.mkdir(path.join(skillsDir, dir), { recursive: true });
	await fs.writeFile(path.join(skillsDir, dir, "SKILL.md"), content);
}

await writeSkill("good-skill", "---\nname: good-skill\ndescription: A perfectly fine skill\n---\n\nBODY_GOOD\n");
// Declares a name that belongs to another directory.
await writeSkill("dup-name", "---\nname: good-skill\ndescription: duplicate of good-skill\n---\n\nBODY_DUP\n");
await writeSkill("no-desc", "---\nname: no-desc\n---\n\nBODY_NODESC\n");
await writeSkill("empty-skill", "");
await writeSkill("broken-frontmatter", "---\nname: broken-frontmatter\ndescription: [unclosed\n\nBODY_BROKEN\n");
await fs.writeFile(
	path.join(outside, "SECRET.md"),
	"---\nname: escaped\ndescription: outside the project\n---\n\nBODY_ESCAPED\n",
);
await fs.mkdir(path.join(skillsDir, "escaped"), { recursive: true });
await fs.symlink(path.join(outside, "SECRET.md"), path.join(skillsDir, "escaped", "SKILL.md"));

await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  w8local:",
		`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		"      - id: local-stream",
		'        name: "local-stream"',
		"        contextWindow: 16384",
		"        maxTokens: 1024",
		"",
	].join("\n"),
);

afterAll(async () => {
	modelServer.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

const child = Bun.spawn({
	cmd: [process.execPath, cliEntry, "--cwd", project, "--no-title", "--model", "w8local/local-stream", "-p", "hello"],
	cwd: project,
	stdin: "ignore",
	stdout: "pipe",
	stderr: "pipe",
	env: {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		PI_CODING_AGENT_DIR: agentDir,
		TERM: "dumb",
		NO_COLOR: "1",
		NO_PROXY: "127.0.0.1,localhost",
	},
});
const stdout = await new Response(child.stdout).text();
const stderr = await new Response(child.stderr).text();
const exitCode = await child.exited;
const systemPrompt = requestBodies.join("\n");

test("the run itself is unaffected by the rejected skills", () => {
	expect(exitCode).toBe(0);
	expect(stdout).toContain("SKILLS-OK");
	expect(requestBodies.length).toBeGreaterThan(0);
});

test("a skill name collision resolves to the directory that owns the name and names the loser", () => {
	expect(systemPrompt).toContain("A perfectly fine skill");
	expect(systemPrompt).not.toContain("duplicate of good-skill");
	expect(stderr).toContain('name collision: "good-skill"');
	expect(stderr).toContain(path.join(skillsDir, "dup-name", "SKILL.md"));
	expect(stderr).toContain(`using ${path.join(skillsDir, "good-skill", "SKILL.md")}`);
});

test("a project skill whose SKILL.md escapes the project is refused and reported", () => {
	expect(systemPrompt).not.toContain("outside the project");
	expect(systemPrompt).not.toContain("BODY_ESCAPED");
	expect(stderr).toContain('Skipping skill "escaped"');
	expect(stderr).toContain("resolves outside");
});

test("every dropped skill says which file it was and what was wrong with it", () => {
	expect(stderr).toContain('Skipping skill "no-desc"');
	expect(stderr).toContain('has no "description"');
	expect(stderr).toContain('Skipping skill "empty-skill"');
	expect(stderr).toContain("is empty or unreadable");
	expect(stderr).toContain('Skipping skill "broken-frontmatter"');
	expect(stderr).toContain("never closed");
	// Each diagnostic carries the path of the file it is about.
	for (const dir of ["no-desc", "empty-skill", "broken-frontmatter"]) {
		expect(stderr).toContain(path.join(skillsDir, dir, "SKILL.md"));
	}
});

test("a healthy skill is loaded without a diagnostic of its own", () => {
	expect(stderr).not.toContain('Skipping skill "good-skill"');
	expect(systemPrompt).toContain("good-skill");
});
