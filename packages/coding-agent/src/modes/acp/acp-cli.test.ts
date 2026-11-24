import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { workerEnvFromParent } from "../../subprocess/worker-client";

// `proto acp` command-line contracts, driven through the real CLI: a misconfigured launch command must
// fail loudly instead of running with defaults, and terminal auth must run a sign-in step that exits
// with the status the client reads as the result. No real provider is contacted.
const cliEntry = path.resolve(import.meta.dir, "..", "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-cli-"));
const workDir = path.join(tmpDir, "work");
const agentDir = path.join(tmpDir, "agent");
const emptyAgentDir = path.join(tmpDir, "agent-empty");
await fs.mkdir(workDir, { recursive: true });

const modelServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => Response.json({ data: [{ id: "mok", object: "model" }] }),
});

// A local model server on the test host would count as a usable model.
const baseConfig = "setupVersion: 4\ndisabledProviders: [ollama, llama.cpp, lm-studio]\n";
await Bun.write(path.join(agentDir, "config.yml"), baseConfig);
await Bun.write(path.join(emptyAgentDir, "config.yml"), baseConfig);
await Bun.write(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  acpcli:",
		`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
		"    api: openai-completions",
		"    apiKey: sk-test-acp-cli",
		"    models:",
		"      - id: mok",
		"        name: mok",
		"        contextWindow: 8192",
		"        maxTokens: 1024",
		"",
	].join("\n"),
);

const extensionPath = path.join(tmpDir, "flag-extension.ts");
await Bun.write(
	extensionPath,
	'export default function (pi) {\n\tpi.registerFlag("acp-cli-probe", { type: "boolean" });\n}\n',
);

afterAll(async () => {
	modelServer.stop(true);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

const ALLOWED_ENV = new Set([
	"PATH",
	"HOME",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"TERM",
	"NO_COLOR",
]);

/** Inherited provider keys would count as usable models, so pass only what the CLI needs to start. */
function cliEnv(agent: string): Record<string, string> {
	const env = workerEnvFromParent({
		HOME: tmpDir,
		PI_CODING_AGENT_DIR: agent,
		XDG_CONFIG_HOME: path.join(tmpDir, "config"),
		XDG_STATE_HOME: path.join(tmpDir, "state"),
		XDG_DATA_HOME: path.join(tmpDir, "data"),
		XDG_CACHE_HOME: path.join(tmpDir, "cache"),
		TERM: "xterm-256color",
		NO_COLOR: "1",
	});
	for (const key of Object.keys(env)) if (!ALLOWED_ENV.has(key)) delete env[key];
	return env;
}

interface Frame {
	id?: number | string | null;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

test("a flag and its value passed as one argument stop `proto acp` before the handshake", async () => {
	const child = Bun.spawn([process.execPath, cliEntry, "acp", "--model acpcli/mok"], {
		cwd: workDir,
		env: cliEnv(agentDir),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await Promise.race([child.exited, Bun.sleep(30_000).then(() => -1)]);
	if (exitCode === -1) child.kill("SIGKILL");

	expect(exitCode).toBe(1);
	expect(await stdout).toBe("");
	const report = await stderr;
	expect(report).toContain("unknown flag: --model acpcli/mok");
	expect(report).toContain('"--model"');
	expect(report).toContain('"acpcli/mok"');
}, 60_000);

test("an unknown long flag fails session/new while an extension's flag is accepted", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			cliEntry,
			"acp",
			"--model",
			"acpcli/mok",
			"--extension",
			extensionPath,
			"--acp-cli-probe",
			"--no-sesion",
		],
		{ cwd: workDir, env: cliEnv(agentDir), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const stderr = new Response(child.stderr).text();
	const decoder = new TextDecoder();
	const lines = readLines(child.stdout);
	// Every stdout line must parse: the transport has no room for anything but JSON-RPC.
	const responseTo = async (id: number): Promise<Frame> => {
		while (true) {
			const line = await lines.next();
			if (line.done) throw new Error(`stdout closed before response ${id}; stderr:\n${await stderr}`);
			const frame = JSON.parse(decoder.decode(line.value)) as Frame;
			if (frame.id === id && frame.method === undefined) return frame;
		}
	};
	try {
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
		);
		child.stdin.flush();
		expect((await responseTo(1)).result).toBeDefined();

		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workDir, mcpServers: [] } })}\n`,
		);
		child.stdin.flush();
		const created = await responseTo(2);

		expect(created.result).toBeUndefined();
		const error = JSON.stringify(created.error);
		expect(error).toContain("--no-sesion");
		expect(error).not.toContain("--acp-cli-probe");
	} finally {
		child.kill("SIGKILL");
	}
	expect(await stderr).toContain("unknown flag: --no-sesion");
}, 60_000);

const ESC = "\x1b";
const CTRL_C = "\x03";
const ALT_SCREEN_ENTER = "\x1b[?1049h";

/** Runs terminal auth in an 80x24 PTY, the way a client presents it, and presses `key` once the step shows. */
async function runTerminalAuth(agent: string, key: string): Promise<number> {
	let output = "";
	const decoder = new TextDecoder();
	const shown = Promise.withResolvers<void>();
	const child = Bun.spawn([process.execPath, cliEntry, "acp", "--acp-terminal-auth"], {
		cwd: workDir,
		env: cliEnv(agent),
		terminal: {
			cols: 80,
			rows: 24,
			data(_terminal, data) {
				output += decoder.decode(data, { stream: true });
				// The sign-in step is fullscreen: it is up once the alternate screen opens.
				if (output.includes(ALT_SCREEN_ENTER)) shown.resolve();
			},
		},
	});
	try {
		const started = await Promise.race([
			shown.promise.then(() => true),
			child.exited.then(() => false),
			Bun.sleep(45_000).then(() => false),
		]);
		if (!started) throw new Error(`terminal auth never showed the sign-in step:\n${Bun.stripANSI(output)}`);
		child.terminal?.write(key);
		const exitCode = await Promise.race([child.exited, Bun.sleep(20_000).then(() => -1)]);
		if (exitCode === -1)
			throw new Error(`terminal auth did not exit after the step ended:\n${Bun.stripANSI(output)}`);
		return exitCode;
	} finally {
		child.kill("SIGKILL");
	}
}

async function sessionFiles(agent: string): Promise<string[]> {
	try {
		return (await fs.readdir(path.join(agent, "sessions"), { recursive: true })).filter(name =>
			name.endsWith(".jsonl"),
		);
	} catch {
		return [];
	}
}

test.skipIf(process.platform === "win32")(
	"terminal auth exits 0 when the sign-in step ends with a usable model, and keeps no session",
	async () => {
		const before = await sessionFiles(agentDir);
		expect(await runTerminalAuth(agentDir, ESC)).toBe(0);
		expect(await sessionFiles(agentDir)).toEqual(before);
	},
	90_000,
);

test.skipIf(process.platform === "win32")(
	"terminal auth fails when the sign-in step ends without any usable model",
	async () => {
		expect(await runTerminalAuth(emptyAgentDir, ESC)).toBe(1);
	},
	90_000,
);

test.skipIf(process.platform === "win32")(
	"cancelling the sign-in step fails terminal auth even when credentials exist",
	async () => {
		expect(await runTerminalAuth(agentDir, CTRL_C)).toBe(1);
	},
	90_000,
);
