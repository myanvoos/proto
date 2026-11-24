import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { type AnyMessage, RpcConnection } from "@oh-my-pi/pi-utils/acp";
import { AuthStorage } from "../../session/auth-storage";
import { workerEnvFromParent } from "../../subprocess/worker-client";

const cliEntry = path.resolve(import.meta.dir, "..", "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-errors-auth-"));
const agentDir = path.join(tmpDir, "agent");
const workDir = path.join(tmpDir, "work");
await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(workDir, { recursive: true });

const REJECTED_KEY = "sk-acp-rejected";
const ACCEPTED_KEY = "sk-acp-accepted";

// A provider that answers 401 to every key but one, like an account whose key was revoked and then replaced.
const provider = Bun.serve({
	port: 0,
	fetch: request => {
		if (request.method !== "POST") return Response.json({ data: [] });
		if (request.headers.get("authorization") !== `Bearer ${ACCEPTED_KEY}`) {
			return Response.json(
				{ error: { message: "Invalid credential", type: "authentication_error" } },
				{ status: 401 },
			);
		}
		const chunk = {
			id: "acp-auth",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "mvault",
			choices: [{ index: 0, delta: { role: "assistant", content: "KEY-ACCEPTED" }, finish_reason: null }],
		};
		const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});

// Neither provider has a key in models.yml: `vault` gets one from the credential store, `nokey` has none anywhere.
function providerYaml(name: string, model: string): string {
	return [
		`  ${name}:`,
		`    baseUrl: http://127.0.0.1:${provider.port}/v1`,
		"    api: openai-completions",
		"    auth: oauth",
		"    models:",
		`      - id: ${model}`,
		`        name: ${model}`,
		"        input: [text]",
		"        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}",
		"        contextWindow: 8192",
		"        maxTokens: 1024",
	].join("\n");
}
await Bun.write(
	path.join(agentDir, "models.yml"),
	["providers:", providerYaml("vault", "mvault"), providerYaml("nokey", "mnokey"), ""].join("\n"),
);
await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 4\nretry:\n  enabled: false\n");

// The agent's own credential store, written from here the way `proto login` in another terminal would.
const credentials = await AuthStorage.create(path.join(agentDir, "agent.db"));

interface Frame {
	id?: number | string | null;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

class AcpServer {
	#child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#frames: Frame[] = [];
	#nextId = 1;
	#stderr = "";

	constructor(args: string[], cwd = workDir) {
		this.#child = Bun.spawn({
			cmd: [process.execPath, cliEntry, "acp", ...args],
			cwd,
			env: workerEnvFromParent({ HOME: tmpDir, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as Bun.Subprocess<"pipe", "pipe", "pipe">;
		void this.#pumpStdout();
		void this.#pumpStderr();
	}

	async #pumpStdout(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const line of readLines(this.#child.stdout)) {
			const text = decoder.decode(line).trim();
			if (text) this.#frames.push(JSON.parse(text) as Frame);
		}
	}

	async #pumpStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#child.stderr) this.#stderr += decoder.decode(chunk, { stream: true });
	}

	async request(method: string, params?: unknown): Promise<Frame> {
		const id = this.#nextId++;
		this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		this.#child.stdin.flush();
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const frame = this.#frames.find(candidate => candidate.id === id && candidate.method === undefined);
			if (frame) return frame;
			await Bun.sleep(25);
		}
		throw new Error(`no response to ${method}; stderr:\n${this.#stderr}`);
	}

	async initialize(clientCapabilities: Record<string, unknown> = {}): Promise<Frame> {
		return await this.request("initialize", { protocolVersion: 1, clientCapabilities });
	}

	async newSession(): Promise<string> {
		const frame = await this.request("session/new", { cwd: workDir, mcpServers: [] });
		if (typeof frame.result?.sessionId !== "string") throw new Error(`session/new failed: ${JSON.stringify(frame)}`);
		return frame.result.sessionId;
	}

	async prompt(sessionId: string, text: string): Promise<Frame> {
		return await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	}

	kill(): void {
		this.#child.kill("SIGKILL");
	}
}

afterAll(async () => {
	provider.stop(true);
	credentials.close();
	await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

test("a rejected key fails the turn as provider_auth, and agent auth refuses it until the key changes", async () => {
	await credentials.set("vault", { type: "api_key", key: REJECTED_KEY });
	const server = new AcpServer(["--model", "vault/mvault"]);
	try {
		await server.initialize();
		const sessionId = await server.newSession();
		const rejected = await server.prompt(sessionId, "hello");
		// No advertised method can replace the key, so this must not invite an authenticate-and-retry loop.
		expect(rejected.error?.code).toBe(-32603);
		expect(rejected.error?.message).toContain("vault/mvault");
		expect(rejected.error?.data).toMatchObject({
			reason: "provider_auth",
			provider: "vault",
			model: "vault/mvault",
			httpStatus: 401,
		});
		// The same key fails the same way, so agent auth must not report success for it.
		const refused = await server.request("authenticate", { methodId: "agent" });
		expect(refused.result).toBeUndefined();
		expect(refused.error?.data).toMatchObject({ reason: "provider_auth", provider: "vault", httpStatus: 401 });

		await credentials.set("vault", { type: "api_key", key: ACCEPTED_KEY });
		expect((await server.request("authenticate", { methodId: "agent" })).result).toEqual({});
		const recovered = await server.prompt(sessionId, "hello again");
		expect(recovered.error).toBeUndefined();
		expect(recovered.result?.stopReason).toBe("end_turn");
	} finally {
		server.kill();
	}
}, 180_000);

test("a rejected key is auth_required when the client can run the terminal login", async () => {
	await credentials.set("vault", { type: "api_key", key: REJECTED_KEY });
	const server = new AcpServer(["--model", "vault/mvault"]);
	try {
		const initialized = await server.initialize({ auth: { terminal: true } });
		const methods = (initialized.result?.authMethods as Array<{ id: string }> | undefined)?.map(method => method.id);
		expect(methods).toContain("terminal");
		const rejected = await server.prompt(await server.newSession(), "hello");
		expect(rejected.error?.code).toBe(-32000);
		expect(rejected.error?.data).toMatchObject({ reason: "provider_auth", provider: "vault", httpStatus: 401 });
	} finally {
		server.kill();
	}
}, 180_000);

test("authenticate before any session checks the model a new session would use and leaves no session behind", async () => {
	await credentials.set("vault", { type: "api_key", key: ACCEPTED_KEY });
	const cases = [
		{ model: "nokey/mnokey", error: { reason: "provider_auth", provider: "nokey", model: "nokey/mnokey" } },
		{ model: "vault/mvault", error: undefined },
	];
	for (const { model, error } of cases) {
		const probeCwd = await fs.mkdtemp(path.join(tmpDir, "probe-"));
		const server = new AcpServer(["--model", model], probeCwd);
		try {
			await server.initialize();
			const authenticated = await server.request("authenticate", { methodId: "agent" });
			if (error) {
				expect(authenticated.error?.code).toBe(-32603);
				expect(authenticated.error?.data).toEqual(error);
			} else {
				expect(authenticated.result).toEqual({});
			}
			const listed = await server.request("session/list", { cwd: probeCwd });
			expect(listed.result?.sessions).toEqual([]);
		} finally {
			server.kill();
		}
	}
}, 180_000);

test("initialize advertises steering under a namespaced capability and keeps fork for thread-forking clients", async () => {
	const server = new AcpServer(["--model", "vault/mvault"]);
	try {
		const capabilities = (await server.initialize()).result?.agentCapabilities as
			| { _meta?: Record<string, unknown>; sessionCapabilities?: Record<string, unknown> }
			| undefined;
		expect(capabilities?._meta?.["proto/steering"]).toEqual({ supported: true });
		// T3 Code offers thread forking only when this unstable capability is present.
		expect(capabilities?.sessionCapabilities?.fork).toEqual({});
	} finally {
		server.kill();
	}
}, 180_000);

test("missing sessions, unsupported values and unknown methods use ACP's error codes", async () => {
	const server = new AcpServer(["--model", "vault/mvault"]);
	try {
		await server.initialize();
		for (const method of ["session/load", "session/resume"]) {
			const missing = await server.request(method, { sessionId: "no-such-session", cwd: workDir, mcpServers: [] });
			expect(missing.error?.code).toBe(-32002);
			expect(missing.error?.data).toEqual({ sessionId: "no-such-session" });
		}
		const sessionId = await server.newSession();
		expect((await server.request("session/set_mode", { sessionId, modeId: "plan" })).error?.code).toBe(-32602);
		const configMode = await server.request("session/set_config_option", {
			sessionId,
			configId: "mode",
			value: "plan",
		});
		expect(configMode.error?.code).toBe(-32602);
		expect((await server.request("session/list", { cursor: "not-a-cursor" })).error?.code).toBe(-32602);
		const unknownMethod = await server.request("no/such_method", {});
		expect(unknownMethod.error).toMatchObject({ code: -32601, message: "Method not found: no/such_method" });
	} finally {
		server.kill();
	}
}, 180_000);

test("a failure that is not a protocol error carries its first line in the error message", async () => {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const details = "No API key found for vault.\n\nUse /login, set an API key environment variable, or create agent.db";
	const connection = new RpcConnection({ readable: inbound.readable, writable: outbound.writable }, () => {
		throw new Error(details);
	});
	const writer = inbound.writable.getWriter();
	const reader = outbound.readable.getReader();
	await writer.write({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} });
	expect((await reader.read()).value).toEqual({
		jsonrpc: "2.0",
		id: 1,
		error: { code: -32603, message: "Internal error: No API key found for vault.", data: { details } },
	});
	await writer.close();
	await connection.closed;
});
