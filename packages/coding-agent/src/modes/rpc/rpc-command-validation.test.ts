import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A malformed frame used to reach the handler and die inside it ("undefined is not an object
// (evaluating 'text.trimStart')"), so this drives the real RPC transport end to end.
const cliEntry = path.resolve(import.meta.dir, "..", "..", "cli.ts");

const modelServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () =>
		new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		}),
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-rpc-validation-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  okp:",
		`    baseUrl: http://127.0.0.1:${modelServer.port}/v1`,
		"    apiKey: test-key",
		"    api: openai-completions",
		"    models:",
		"      - id: mok",
		'        name: "mok"',
		"        contextWindow: 16384",
		"        maxTokens: 1024",
		"",
	].join("\n"),
);

afterAll(async () => {
	modelServer.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

interface RpcResponseFrame {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	error?: string;
}

async function runRpc(frames: unknown[]): Promise<RpcResponseFrame[]> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, "--mode", "rpc", "--model", "okp/mok", "--no-session", "--no-extensions"],
		cwd,
		stdin: new TextEncoder().encode(frames.map(frame => `${JSON.stringify(frame)}\n`).join("")),
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
	const stdout = await new Response(child.stdout).text();
	await child.exited;
	return stdout
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as RpcResponseFrame)
		.filter(frame => frame.type === "response");
}

test("a command with a missing or mistyped field is named, not crashed on", async () => {
	const responses = await runRpc([
		{ id: "missing-message", type: "prompt" },
		{ id: "wrong-message", type: "prompt", message: 123 },
		{ id: "wrong-images", type: "prompt", message: "hi", images: "nope" },
		{ id: "missing-enabled", type: "set_fast_mode" },
		{ id: "missing-provider", type: "login" },
		{ id: "unknown", type: "no_such_command" },
		"not an object",
		{ id: "valid", type: "get_state" },
	]);
	const byId = new Map(responses.filter(frame => frame.id !== undefined).map(frame => [frame.id, frame]));

	expect(byId.get("missing-message")).toMatchObject({
		command: "prompt",
		success: false,
		error: 'Invalid "prompt" command: missing required field "message" (expected string)',
	});
	expect(byId.get("wrong-message")?.error).toBe('Invalid "prompt" command: "message" must be a string, got number');
	expect(byId.get("wrong-images")?.error).toBe('Invalid "prompt" command: "images" must be an array, got string');
	expect(byId.get("missing-enabled")?.error).toBe(
		'Invalid "set_fast_mode" command: missing required field "enabled" (expected boolean)',
	);
	expect(byId.get("missing-provider")?.error).toBe(
		'Invalid "login" command: missing required field "providerId" (expected string)',
	);
	// An unrecognised type keeps its own, already exemplary, message.
	expect(byId.get("unknown")?.error).toBe("Unknown command: no_such_command");
	// A frame that is not an object at all is reported instead of throwing inside the dispatcher.
	expect(responses.some(frame => frame.error === "Invalid RPC command: expected a JSON object, got string")).toBe(
		true,
	);
	// No response may leak an internal TypeError.
	for (const frame of responses) expect(frame.error ?? "").not.toContain("is not an object (evaluating");
	// A well-formed command in the same stream still succeeds.
	expect(byId.get("valid")).toMatchObject({ command: "get_state", success: true });
});

test("a well-formed prompt is unaffected by validation", async () => {
	const responses = await runRpc([{ id: "p", type: "prompt", message: "hello rpc" }]);
	expect(responses.find(frame => frame.id === "p")).toMatchObject({ command: "prompt", success: true });
});
