import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// The defect was the text a user is left with when retries run out, so this drives the real CLI
// against a loopback provider that streams a degenerate repeat until the repetition guard trips.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");
const LOOP_UNIT = "I will now re-examine the whole plan once more.\n\n\n";

const loopServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(req) {
		if (req.method === "GET") return Response.json({ data: [{ id: "looping", object: "model" }] });
		const body = LOOP_UNIT.repeat(30);
		const frames = [];
		for (let index = 0; index < body.length; index += 64) {
			frames.push({ choices: [{ index: 0, delta: { content: body.slice(index, index + 64) } }] });
		}
		frames.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		const payload = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(payload, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-retry-report-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
for (const dir of [home, agentDir, cwd]) await fs.mkdir(dir, { recursive: true });

await fs.writeFile(
	path.join(agentDir, "config.yml"),
	[
		"startup:",
		"  setupWizard: false",
		"  checkUpdate: false",
		"  quiet: true",
		"retry:",
		"  maxRetries: 2",
		"  baseDelayMs: 50",
		"  maxDelayMs: 5000",
		"  modelFallback: false",
		"",
	].join("\n"),
);
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  loopback:",
		`    baseUrl: http://127.0.0.1:${loopServer.port}/v1`,
		"    apiKey: loopback-fixture",
		"    api: openai-completions",
		"    models:",
		"      - id: looping",
		'        name: "Looping"',
		"        input: [text]",
		"        contextWindow: 32768",
		"        maxTokens: 4096",
		"",
	].join("\n"),
);

afterAll(async () => {
	loopServer.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

test("a spent retry budget reports the guard that stopped it, once, and promises nothing further", async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			cliEntry,
			"--cwd",
			cwd,
			"--no-title",
			"--model",
			"loopback/looping",
			"-p",
			"repeat yourself",
		],
		cwd,
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
			NO_PROXY: "127.0.0.1,localhost",
			TERM: "dumb",
			NO_COLOR: "1",
		},
	});
	const stderr = new Response(child.stderr).text();
	const exitCode = await child.exited;
	const err = await stderr;

	expect(exitCode).toBe(1);
	// One report of the terminal failure, not a pair of near-duplicates in different words.
	const reports = err.split("\n").filter(line => line.includes("Retry budget exhausted"));
	expect(reports).toHaveLength(1);
	expect(err).not.toContain("Retry failed after");

	const report = reports[0]!;
	expect(report).toContain("Retry budget exhausted after 2 retries");
	// The cause is named, with the evidence the guard collected.
	expect(report).toContain("repetition guard");
	expect(report).toMatch(/repeated an exact \d+-character cycle \d+× back-to-back/);
	// Nothing is retried once the budget is spent, so the last word may not promise one. The
	// per-attempt progress lines above it still carry the provider's own wording.
	expect(report).not.toContain("Treating as a stream stall and retrying");
}, 90_000);
