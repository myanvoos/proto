import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// `proto read skill://x` used to fail with "Available: none" because the standalone command built a
// session without capability discovery. Every case drives the real CLI; the parity case additionally
// drives a real session against a local fake provider that answers with a read tool call.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");
const SKILL_MARKER = "GOOD SKILL BODY MARKER";
const REFERENCE_MARKER = "SKILL REFERENCE MARKER";
const RULE_MARKER = "TEST RULE BODY MARKER";

const requestBodies: string[] = [];
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async request => {
		const body = await request.text();
		requestBodies.push(body);
		const callsRead = body.includes('"role":"tool"');
		const frames = callsRead
			? [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]
			: [
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_read_1",
											type: "function",
											function: { name: "read", arguments: JSON.stringify({ path: "skill://good-skill" }) },
										},
									],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				];
		const payload = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(payload, { headers: { "content-type": "text/event-stream" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-w8-read-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const work = path.join(root, "work");

beforeAll(async () => {
	for (const dir of [
		home,
		agentDir,
		path.join(work, ".proto", "skills", "good-skill"),
		path.join(work, ".proto", "rules"),
	]) {
		await fs.mkdir(dir, { recursive: true });
	}
	await fs.writeFile(
		path.join(work, ".proto", "skills", "good-skill", "SKILL.md"),
		["---", "name: good-skill", "description: Verifies standalone read resolution", "---", SKILL_MARKER, ""].join(
			"\n",
		),
	);
	await fs.writeFile(path.join(work, ".proto", "skills", "good-skill", "reference.md"), `${REFERENCE_MARKER}\n`);
	await fs.writeFile(
		path.join(work, ".proto", "rules", "testrule.md"),
		["---", "name: testrule", "description: Verifies standalone rule resolution", "---", RULE_MARKER, ""].join("\n"),
	);
	await fs.writeFile(path.join(work, "plain.txt"), "PLAIN FILE MARKER\n");
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		["retry:", "  maxRetries: 0", "  baseDelayMs: 10", "  maxDelayMs: 20", "  modelFallback: false", ""].join("\n"),
	);
	await fs.writeFile(path.join(root, "no-skills.yml"), "skills:\n  enabled: false\n");
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  w8fake:",
			`    baseUrl: http://127.0.0.1:${provider.port}/v1`,
			"    apiKey: test-key",
			"    api: openai-completions",
			"    models:",
			"      - id: w8-model",
			'        name: "w8"',
			"        contextWindow: 16384",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);
});

afterAll(async () => {
	provider.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

async function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, ...args],
		cwd: work,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...(process.env as Record<string, string>),
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			PI_CODING_AGENT_DIR: agentDir,
			TERM: "dumb",
			NO_COLOR: "1",
			...env,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

test("skill:// resolves against discovered skills", async () => {
	const skill = await runCli(["read", "skill://good-skill"]);
	expect(skill.exitCode).toBe(0);
	expect(skill.stdout).toContain(SKILL_MARKER);

	const reference = await runCli(["read", "skill://good-skill/reference.md"]);
	expect(reference.exitCode).toBe(0);
	expect(reference.stdout).toContain(REFERENCE_MARKER);

	const unknown = await runCli(["read", "skill://not-a-skill"]);
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stderr).toContain("Unknown skill: not-a-skill");
	expect(unknown.stderr).toContain("Available: good-skill");
}, 60_000);

test("rule:// resolves against discovered rules", async () => {
	const rule = await runCli(["read", "rule://testrule"]);
	expect(rule.exitCode).toBe(0);
	expect(rule.stdout).toContain(RULE_MARKER);

	const unknown = await runCli(["read", "rule://not-a-rule"]);
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stderr).toContain("Unknown rule: not-a-rule");
	expect(unknown.stderr).toContain("testrule");
}, 60_000);

test("discovery honours settings instead of scanning unconditionally", async () => {
	const disabled = await runCli(["--config", path.join(root, "no-skills.yml"), "read", "skill://good-skill"]);
	expect(disabled.exitCode).toBe(1);
	expect(disabled.stderr).toContain("Available: none");
});

test("schemes that need no capability discovery keep working", async () => {
	const docs = await runCli(["read", "proto://"]);
	expect(docs.exitCode).toBe(0);
	expect(docs.stdout).toContain("Documentation");

	const plain = await runCli(["read", "plain.txt"]);
	expect(plain.exitCode).toBe(0);
	expect(plain.stdout).toContain("PLAIN FILE MARKER");
}, 60_000);

test("standalone read and in-session read resolve skill:// the same way", async () => {
	const standalone = await runCli(["read", "skill://good-skill"]);
	expect(standalone.stdout).toContain(SKILL_MARKER);

	requestBodies.length = 0;
	const session = await runCli([
		"-p",
		"read the good-skill skill",
		"--model",
		"w8fake/w8-model",
		"--tools",
		"read",
		"--no-session",
		"--no-extensions",
	]);
	expect(session.exitCode).toBe(0);
	// The follow-up request carries the tool result, so the session saw the same skill body.
	const toolResults = requestBodies.filter(body => body.includes('"role":"tool"'));
	expect(toolResults.length).toBeGreaterThan(0);
	expect(toolResults.some(body => body.includes(SKILL_MARKER))).toBe(true);
}, 120_000);
