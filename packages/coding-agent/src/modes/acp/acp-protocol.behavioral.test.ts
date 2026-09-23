import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { workerEnvFromParent } from "../../subprocess/worker-client";

const cliEntry = path.resolve(import.meta.dir, "..", "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-protocol-"));
const agentDir = path.join(tmpDir, "agent");
const workDir = path.join(tmpDir, "work");
const notADir = path.join(tmpDir, "regular-file.txt");
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(workDir, { recursive: true });
await fs.writeFile(notADir, "not a directory\n");

// Local stand-ins for a provider that rejects credentials, one that answers 200
// with something that is not a stream, and one that streams a real completion.
const unauthorized = Bun.serve({
	port: 0,
	fetch: () =>
		new Response(JSON.stringify({ error: { message: "Invalid API key provided", code: "invalid_api_key" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		}),
});
const notAStream = Bun.serve({
	port: 0,
	fetch: () => new Response("<html>not json at all</html>", { status: 200, headers: { "content-type": "text/html" } }),
});
function streamedCompletion(model: string, text: string): Response {
	const chunk = {
		id: "w7",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
	};
	const done = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
	};
	const body = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const streaming = Bun.serve({
	port: 0,
	fetch: request => {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ data: [{ id: "mok", object: "model" }] }), {
				headers: { "content-type": "application/json" },
			});
		}
		return streamedCompletion("mok", "W7-OK");
	},
});

// Fails until the transport layers give up once (6 fetch attempts per request, one replay-safe provider
// retry), then serves a normal completion: enough to make session recovery run a visible retry without
// waiting on a real outage.
let flakyAttempts = 0;
const FLAKY_FAILURES = Number(process.env.W7_FLAKY_FAILURES ?? 12);
const flaky = Bun.serve({
	port: 0,
	fetch: request => {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ data: [{ id: "mflaky", object: "model" }] }), {
				headers: { "content-type": "application/json" },
			});
		}
		flakyAttempts += 1;
		if (flakyAttempts <= FLAKY_FAILURES) {
			return new Response(JSON.stringify({ error: { message: "internal boom", type: "server_error" } }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		}
		return streamedCompletion("mflaky", "W7-RECOVERED");
	},
});

function providerYaml(name: string, model: string, port: number | undefined): string {
	return [
		`  ${name}:`,
		`    baseUrl: http://127.0.0.1:${port ?? 0}/v1`,
		"    api: openai-completions",
		"    apiKey: sk-test-acp-protocol",
		"    models:",
		`      - id: ${model}`,
		`        name: ${model}`,
		"        input: [text]",
		"        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}",
		"        contextWindow: 8192",
		"        maxTokens: 1024",
	].join("\n");
}

await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		providerYaml("w7auth", "m401", unauthorized.port),
		providerYaml("w7html", "mhtml", notAStream.port),
		providerYaml("w7ok", "mok", streaming.port),
		providerYaml("w7flaky", "mflaky", flaky.port),
		"",
	].join("\n"),
);
// Retries are a session-level policy with its own budget; this suite is about
// what ACP reports once a turn is over, so let the first failure be final.
await fs.writeFile(path.join(agentDir, "config.yml"), "setupVersion: 4\nretry:\n  enabled: false\n");

// A second profile that keeps recovery on, for the one case that is about retries.
const retryAgentDir = path.join(tmpDir, "agent-retry");
await fs.mkdir(retryAgentDir, { recursive: true });
await fs.copyFile(path.join(agentDir, "models.yml"), path.join(retryAgentDir, "models.yml"));
await fs.writeFile(
	path.join(retryAgentDir, "config.yml"),
	"setupVersion: 4\nretry:\n  enabled: true\n  maxRetries: 3\n  baseDelayMs: 100\n",
);

interface Frame {
	id?: number | string | null;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
	params?: Record<string, unknown>;
}

class AcpServer {
	#child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly frames: Frame[] = [];
	readonly lines: string[] = [];
	stderr = "";

	constructor(args: string[] = [], agentDirOverride = agentDir) {
		this.#child = Bun.spawn({
			cmd: [process.execPath, cliEntry, "acp", ...args],
			cwd: workDir,
			env: workerEnvFromParent({
				HOME: tmpDir,
				PI_CODING_AGENT_DIR: agentDirOverride,
				NO_COLOR: "1",
			}),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as Bun.Subprocess<"pipe", "pipe", "pipe">;
		void this.#pumpStdout();
		void this.#pumpStderr();
	}

	async #pumpStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of this.#child.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line) continue;
				this.lines.push(line);
				this.frames.push(JSON.parse(line) as Frame);
			}
		}
	}

	async #pumpStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#child.stderr) this.stderr += decoder.decode(chunk, { stream: true });
	}

	send(message: Record<string, unknown> | string): void {
		const line = typeof message === "string" ? message : JSON.stringify(message);
		this.#child.stdin.write(`${line}\n`);
		this.#child.stdin.flush();
	}

	async response(id: number, timeoutMs = 60_000): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const frame = this.frames.find(candidate => candidate.id === id);
			if (frame) return frame;
			await Bun.sleep(50);
		}
		throw new Error(`no response for id ${id}; frames:\n${this.lines.join("\n")}\nstderr:\n${this.stderr}`);
	}

	notifications(sessionUpdate: string): Frame[] {
		return this.frames.filter(
			frame =>
				frame.method === "session/update" &&
				(frame.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === sessionUpdate,
		);
	}

	async initialize(protocolVersion: unknown = 1, id = 1): Promise<Frame> {
		this.send({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion, clientCapabilities: {} } });
		return await this.response(id);
	}

	async newSession(id = 2, cwd = workDir): Promise<string> {
		this.send({ jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } });
		const frame = await this.response(id);
		if (!frame.result) throw new Error(`session/new failed: ${JSON.stringify(frame)}`);
		return frame.result.sessionId as string;
	}

	async prompt(sessionId: string, text: string, id = 3): Promise<Frame> {
		this.send({
			jsonrpc: "2.0",
			id,
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text }] },
		});
		return await this.response(id, 120_000);
	}

	async close(): Promise<number> {
		this.#child.stdin.end();
		const exitCode = await Promise.race([this.#child.exited, Bun.sleep(15_000).then(() => -1)]);
		if (exitCode === -1) this.#child.kill("SIGKILL");
		return exitCode;
	}

	kill(): void {
		this.#child.kill("SIGKILL");
	}
}

test("a provider that rejects credentials fails session/prompt instead of answering as the assistant", async () => {
	const server = new AcpServer(["--model", "w7auth/m401"]);
	try {
		await server.initialize();
		const sessionId = await server.newSession();
		const frame = await server.prompt(sessionId, "hello");
		expect(frame.result).toBeUndefined();
		expect(frame.error?.code).toBe(-32000);
		expect(frame.error?.message).toContain("Invalid API key");
		// The failure must not be dressed up as model output.
		expect(server.notifications("agent_message_chunk")).toEqual([]);
	} finally {
		server.kill();
	}
}, 180_000);

test("a 200 response that is not a stream fails session/prompt with an internal error", async () => {
	const server = new AcpServer(["--model", "w7html/mhtml"]);
	try {
		await server.initialize();
		const sessionId = await server.newSession();
		const frame = await server.prompt(sessionId, "hello");
		expect(frame.result).toBeUndefined();
		expect(frame.error?.code).toBe(-32603);
		expect(frame.error?.message).toContain("not a stream");
		expect(server.notifications("agent_message_chunk")).toEqual([]);
	} finally {
		server.kill();
	}
}, 180_000);

test("a healthy provider still streams text and ends the turn successfully", async () => {
	const server = new AcpServer(["--model", "w7ok/mok"]);
	try {
		await server.initialize();
		const sessionId = await server.newSession();
		const frame = await server.prompt(sessionId, "hello");
		expect(frame.error).toBeUndefined();
		expect(frame.result?.stopReason).toBe("end_turn");
		const chunks = server.notifications("agent_message_chunk");
		expect(chunks.length).toBeGreaterThan(0);
		expect(JSON.stringify(chunks)).toContain("W7-OK");
	} finally {
		server.kill();
	}
}, 180_000);

test("recovery progress reaches the client instead of leaving the turn silent", async () => {
	const server = new AcpServer(["--model", "w7flaky/mflaky"], retryAgentDir);
	try {
		await server.initialize();
		const sessionId = await server.newSession();
		const frame = await server.prompt(sessionId, "hello");
		expect(frame.error).toBeUndefined();
		expect(frame.result?.stopReason).toBe("end_turn");
		const thoughts = JSON.stringify(server.notifications("agent_thought_chunk"));
		expect(thoughts).toContain("Provider error (retry 1/");
		// The retried turn still produces the model's answer.
		expect(JSON.stringify(server.notifications("agent_message_chunk"))).toContain("W7-RECOVERED");
		// The retry narration is agent status, never model output.
		expect(JSON.stringify(server.notifications("agent_message_chunk"))).not.toContain("Provider error");
	} finally {
		server.kill();
	}
}, 180_000);

test("a malformed line is answered with a parse error and the server keeps serving", async () => {
	const server = new AcpServer();
	try {
		await server.initialize();
		server.send("{ this is not json");
		const parseError = await server.response(null as unknown as number, 15_000);
		expect(parseError.error?.code).toBe(-32700);
		expect(parseError.error?.message).toBe("Parse error");
		// Still alive: the next well-formed request is served normally.
		const sessionId = await server.newSession(2);
		expect(sessionId.length).toBeGreaterThan(0);
	} finally {
		server.kill();
	}
}, 180_000);

test("a line that is not a JSON-RPC message is answered with an invalid request error", async () => {
	const server = new AcpServer();
	try {
		await server.initialize();
		server.send('["not", "an", "object"]');
		const invalid = await server.response(null as unknown as number, 15_000);
		expect(invalid.error?.code).toBe(-32600);
		expect(await server.newSession(2)).toBeTruthy();
	} finally {
		server.kill();
	}
}, 180_000);

test("protocol hygiene: initialization, params, cwd, methods and sessions use the right error codes", async () => {
	const server = new AcpServer();
	try {
		server.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: workDir } });
		const beforeInit = await server.response(1);
		expect(beforeInit.error?.code).toBe(-32002);
		expect(beforeInit.error?.message).toBe("Server not initialized");

		const badVersion = await server.initialize("abc", 2);
		expect(badVersion.error?.code).toBe(-32602);

		const negotiated = await server.initialize(999, 3);
		// Spec negotiation: answer with the newest version both sides speak.
		expect(negotiated.result?.protocolVersion).toBe(1);
		expect(server.stderr).toContain("client requested protocol version 999");

		server.send({ jsonrpc: "2.0", id: 4, method: "session/new" });
		const missingParams = await server.response(4);
		expect(missingParams.error?.code).toBe(-32602);
		expect(missingParams.error?.message).toContain("params object");

		server.send({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/nope/missing" } });
		const missingDir = await server.response(5);
		expect(missingDir.error?.code).toBe(-32602);
		expect(missingDir.error?.message).toContain("does not exist");

		server.send({ jsonrpc: "2.0", id: 6, method: "session/new", params: { cwd: notADir } });
		const fileCwd = await server.response(6);
		expect(fileCwd.error?.code).toBe(-32602);
		expect(fileCwd.error?.message).toContain("not a directory");

		server.send({ jsonrpc: "2.0", id: 7, method: "session/new", params: { cwd: "relative/path" } });
		const relative = await server.response(7);
		expect(relative.error?.code).toBe(-32602);
		expect(relative.error?.message).toContain("absolute");

		server.send({ jsonrpc: "2.0", id: 8, method: "no/such_method", params: {} });
		const unknownMethod = await server.response(8);
		expect(unknownMethod.error?.code).toBe(-32601);

		server.send({
			jsonrpc: "2.0",
			id: 9,
			method: "session/prompt",
			params: { sessionId: "does-not-exist", prompt: [] },
		});
		const unknownSession = await server.response(9);
		expect(unknownSession.error?.code).toBe(-32602);
		expect(unknownSession.error?.message).toContain("unknown session");

		const sessionId = await server.newSession(10);
		server.send({
			jsonrpc: "2.0",
			id: 11,
			method: "session/set_config_option",
			params: { sessionId, configId: "model", value: "no/such-model" },
		});
		const unknownModel = await server.response(11);
		expect(unknownModel.error?.code).toBe(-32602);
		expect(unknownModel.error?.message).toContain("unknown model");
	} finally {
		server.kill();
	}
}, 180_000);

afterAll(async () => {
	flaky.stop(true);
	unauthorized.stop(true);
	notAStream.stop(true);
	streaming.stop(true);
	await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});
