import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// The defects were end-to-end reporting bugs (exit code + stderr of a real
// `proto -p` run), so every case drives the real CLI against a local
// fault-injection server. No real provider is contacted.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const htmlServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response("<html>not json at all</html>", { headers: { "content-type": "text/html" } }),
});

const hangServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Promise<Response>(() => {}),
});

const errorServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () =>
		new Response(
			JSON.stringify({
				error: { message: "Invalid API key provided", type: "invalid_request_error", code: "invalid_api_key" },
			}),
			{ status: 401, headers: { "content-type": "application/json" } },
		),
});

const okServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => {
		const frames = [
			{ choices: [{ delta: { content: "PRINTED ANSWER" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		];
		const body = frames
			.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
			.join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-print-failure-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });

function portOf(server: { port?: number | null }): number {
	const port = server.port;
	if (typeof port !== "number") throw new Error("fault-injection server did not bind a port");
	return port;
}

function providerBlock(name: string, port: number): string {
	return [
		`  ${name}:`,
		`    baseUrl: http://127.0.0.1:${port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		`      - id: ${name}-model`,
		`        name: "${name}"`,
		"        contextWindow: 16384",
		"        maxTokens: 1024",
	].join("\n");
}

await fs.writeFile(
	path.join(agentDir, "config.yml"),
	["retry:", "  maxRetries: 2", "  baseDelayMs: 50", "  maxDelayMs: 200", "  modelFallback: false", ""].join("\n"),
);

await fs.writeFile(
	path.join(agentDir, "models.yml"),
	`providers:\n${[
		providerBlock("faulthtml", portOf(htmlServer)),
		providerBlock("faulthang", portOf(hangServer)),
		providerBlock("fault401", portOf(errorServer)),
		providerBlock("faultok", portOf(okServer)),
	].join("\n")}\n`,
);

afterAll(async () => {
	errorServer.stop(true);
	htmlServer.stop(true);
	hangServer.stop(true);
	okServer.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

async function runPrint(args: string[], timeoutMs = 60_000): Promise<RunResult> {
	const started = Date.now();
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, "--cwd", cwd, "--no-session", "--no-title", "--no-tools", ...args],
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
			TERM: "dumb",
			NO_COLOR: "1",
		},
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => -1)]);
	if (exitCode === -1) {
		child.kill("SIGKILL");
		await child.exited;
		throw new Error(`proto ${args.join(" ")} did not exit within ${timeoutMs}ms`);
	}
	return { exitCode, stdout: await stdout, stderr: await stderr, elapsedMs: Date.now() - started };
}

test("a 200 response that is not a stream fails instead of printing an empty success", async () => {
	const result = await runPrint(["-p", "hi", "--model", "faulthtml/faulthtml-model"], 45_000);

	expect(result.exitCode).toBe(1);
	expect(result.stdout.trim()).toBe("");
	expect(result.stderr).toContain("was not a stream");
	expect(result.stderr).toContain("content-type text/html");
}, 60_000);

test("a --max-time cutoff reports the truncation instead of exiting 0", async () => {
	const result = await runPrint(["-p", "hello", "--max-time", "3", "--model", "faulthang/faulthang-model"], 60_000);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("--max-time");
	expect(result.elapsedMs).toBeLessThan(45_000);
}, 90_000);

test("a --max-time cutoff also fails the json print mode", async () => {
	const result = await runPrint(
		["-p", "hello", "--max-time", "3", "--mode", "json", "--model", "faulthang/faulthang-model"],
		60_000,
	);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("--max-time");
	expect(result.stdout).toContain('"agent_start"');
}, 90_000);

test("a hard provider error is still reported verbatim", async () => {
	const result = await runPrint(["-p", "hi", "--model", "fault401/fault401-model"], 45_000);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("401");
	expect(result.stderr).toContain("Invalid API key provided");
}, 60_000);

test("an unreachable provider fails fast with visible retry progress", async () => {
	// Nothing is listening on this port: the run must neither hang nor go silent.
	const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unused") });
	const deadPort = portOf(dead);
	dead.stop(true);
	const models = path.join(agentDir, "models.yml");
	const original = await fs.readFile(models, "utf8");
	await fs.writeFile(models, `${original}${providerBlock("faultdead", deadPort)}\n`);
	try {
		const result = await runPrint(["-p", "hi", "--model", "faultdead/faultdead-model"], 90_000);

		expect(result.exitCode).toBe(1);
		expect(result.elapsedMs).toBeLessThan(45_000);
		expect(result.stderr).toContain("retry 1/2");
		expect(result.stderr).toContain("Retry budget exhausted after 2 retries");
		expect(result.stderr).toContain("Unable to connect");
	} finally {
		await fs.writeFile(models, original);
	}
}, 120_000);

test("a healthy provider still prints its answer and exits 0", async () => {
	const result = await runPrint(["-p", "hi", "--model", "faultok/faultok-model"], 45_000);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("PRINTED ANSWER");
}, 60_000);
