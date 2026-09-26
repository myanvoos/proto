import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { daemonClientForProject } from "../launch/client";
import { ArtifactManager } from "../session/artifacts";
import type { ToolSession } from "../tools";
import { type DelegationGrant, disposeSessionDelegations, runEvalDelegation } from "./delegation";

function fixture(cwd: string) {
	const callbacks = new Set<() => void>();
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const artifacts = new ArtifactManager(path.join(cwd, "artifacts"));
	let calls = 0;
	let active = 0;
	let disposed = false;
	const tool = {
		name: "calculate",
		label: "calculate",
		description: "Deterministic delegated fixture",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, args: unknown, signal?: AbortSignal) {
			calls++;
			const input = args as { op: string; value?: number };
			if (input.op === "hold") {
				active++;
				const pending = Promise.withResolvers<void>();
				const abort = () => pending.reject(new Error("calculation cancelled"));
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				started.resolve();
				try {
					await pending.promise;
				} finally {
					active--;
					signal?.removeEventListener("abort", abort);
					stopped.resolve();
				}
			}
			return { content: [{ type: "text" as const, text: String((input.value ?? 0) ** 2) }] };
		},
	};
	const session = {
		cwd,
		settings: { get: () => true },
		getSessionId: () => `session-${path.basename(cwd)}`,
		getToolByName: (name: string) =>
			name === "calculate" ? tool : name === "alias" ? { ...tool, name: "bash" } : undefined,
		getArtifactManager: () => artifacts,
		getArtifactsDir: () => artifacts.dir,
		allocateOutputArtifact: (kind: string) => artifacts.allocatePath(kind),
		localProtocolOptions: { getArtifactsDir: () => artifacts.dir },
		isDisposed: () => disposed,
		registerDisposeCallback: (callback: () => void) => {
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
	} as unknown as ToolSession;
	return {
		session,
		started: started.promise,
		stopped: stopped.promise,
		get calls() {
			return calls;
		},
		get active() {
			return active;
		},
		async dispose() {
			disposed = true;
			for (const callback of [...callbacks]) callback();
			await disposeSessionDelegations(session);
		},
	};
}

async function create(
	session: ToolSession,
	options: Record<string, unknown> = {},
	allowed: DelegationGrant[] = [{ tool: "calculate", operations: ["square"] }],
) {
	const result = await runEvalDelegation(
		{ op: "delegation_create", grants: allowed, expose: true, ...options },
		{ session },
	);
	if (!("clients" in result) || !result.env) throw new Error("Expected exposed lease launch info");
	const config = (await Bun.file(result.env.PROTO_SESSION_CAPABILITY).json()) as {
		version: number;
		url: string;
		token: string;
	};
	return { ...result, config };
}

async function request(config: { url: string; token: string }, name: string, args: unknown, id = crypto.randomUUID()) {
	const response = await fetch(`${config.url}/call`, {
		method: "POST",
		headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
		body: JSON.stringify({ id, name, args }),
	});
	return { status: response.status, body: (await response.json()) as { ok: boolean; code?: string; value?: unknown } };
}

async function processOutput(session: ToolSession, name: string) {
	const client = await daemonClientForProject(session.cwd);
	const exited = await client.request({ op: "wait", name, for: "exit", timeoutMs: 10_000 });
	if (exited.op !== "wait") throw new Error("Expected process wait");
	const logs = await client.request({ op: "logs", name, lines: 100, head: true, follow: false, timeoutMs: 100 });
	if (logs.op !== "logs") throw new Error("Expected process logs");
	if (exited.timedOut) throw new Error(`Process ${name} did not exit; output: ${logs.text}`);
	return { exitCode: exited.daemon.exitCode, text: logs.text };
}

async function shutdown(session: ToolSession) {
	const client = await daemonClientForProject(session.cwd);
	await client.request({ op: "shutdown" });
	client.close();
}

// Client paths are private, runtime-staged assets; subprocess imports cannot use a build-time module specifier.
const allowed: DelegationGrant[] = [
	{ tool: "calculate", operations: ["square"] },
	{ tool: "__runtime__", operations: ["artifact_publish", "artifact_read", "artifact_resolve"] },
];

for (const language of ["python", "javascript"] as const) {
	test(`${language} normal scripts launch through Fleet with only allowed capabilities, no ambient credentials, and redacted client logs`, async () => {
		await using dir = await TempDir.create("@delegation-script-");
		const f = fixture(dir.path());
		try {
			const lease = await create(f.session, {}, allowed);
			const source =
				language === "python"
					? `import json, os
from proto_session import from_env, CapabilityError
c = from_env()
v = c.call("calculate", {"op":"square", "value":7})
denied = []
for name, args in [("calculate", {"op":"erase"}), ("bash", {}), ("__runtime__", {"op":"delegation_create"}), ("__completion__", {"prompt":"do not run"})]:
    try: c.call(name, args)
    except CapabilityError as error: denied.append(error.code)
r = c.publish_artifact({"value": int(v)})
b = c.publish_artifact(bytes([0, 255, 1]))
print(json.dumps({"value":v,"denied":denied,"artifact":c.read_artifact(r, encoding="json")["data"],"binary":c.read_artifact(b, encoding="base64")["data"],"env":sorted(os.environ),"client":repr(c)}))
`
					: `const { fromEnv } = await import(process.env.PROTO_SESSION_CLIENT_JS);
const c = await fromEnv();
const value = await c.call("calculate", {op:"square",value:7});
const denied=[];
for(const [name,args] of [["calculate",{op:"erase"}],["bash",{}],["__runtime__",{op:"delegation_create"}],["__completion__",{prompt:"do not run"}]]) { try { await c.call(name,args); } catch(e) { denied.push(e.code); } }
const ref=await c.publishArtifact({value:Number(value)});
const binary=await c.publishArtifact(new Uint8Array([0,255,1]));
console.log(JSON.stringify({value,denied,artifact:(await c.readArtifact(ref,{encoding:"json"})).data,binary:(await c.readArtifact(binary,{encoding:"base64"})).data,env:Object.keys(process.env).sort(),client:c}));
`;
			const script = dir.join(language === "python" ? "ordinary.py" : "ordinary.mjs");
			await Bun.write(script, source);
			const launched = await runEvalDelegation(
				{
					op: "delegation_launch",
					id: lease.lease.id,
					name: "ordinary",
					application: Bun.which(language === "python" ? "python3" : "node")!,
					args: [script],
				},
				{ session: f.session },
			);
			expect("process" in launched && launched.process.owner).toBe(f.session.getSessionId!()!);
			const result = await processOutput(f.session, "ordinary");
			expect(result.exitCode).toBe(0);
			const printed = JSON.parse(result.text.trim()) as {
				value: string;
				denied: string[];
				artifact: unknown;
				binary: string;
				env: string[];
			};
			expect(printed.value).toBe("49");
			expect(printed.denied).toEqual(["denied", "denied", "denied", "denied"]);
			expect(printed.artifact).toEqual({ value: 49 });
			expect(printed.binary).toBe("AP8B");
			expect(printed.env).not.toContain("HOME");
			expect(printed.env.filter(key => /(?:API_KEY|AUTH_TOKEN|TOOL_BRIDGE|PROTO_WORKER)/.test(key))).toEqual([]);
			expect(result.text).not.toContain(lease.config.token);
			expect(f.calls).toBe(1);
			const client = await daemonClientForProject(f.session.cwd);
			const description = await client.request({ op: "describe", name: "ordinary" });
			expect(JSON.stringify(description)).not.toContain(lease.config.token);
			const info = await runEvalDelegation({ op: "delegation_list" }, { session: f.session });
			expect(JSON.stringify(info)).not.toContain(lease.config.token);
			expect((await fs.stat(lease.env!.PROTO_SESSION_CAPABILITY)).mode & 0o777).toBe(0o600);
		} finally {
			await f.dispose();
			await shutdown(f.session);
		}
	}, 20_000);
}

for (const reason of ["revoke", "expiry"] as const) {
	test(`saved credentials in ordinary subprocesses fail after ${reason}, even when a different valid lease launches the verifier`, async () => {
		await using dir = await TempDir.create("@delegation-stale-");
		const f = fixture(dir.path());
		try {
			const old = await create(f.session, { ttlMs: reason === "expiry" ? 40 : 60_000 });
			const stale = dir.join("saved.json");
			await fs.writeFile(stale, JSON.stringify(old.config), { mode: 0o600 });
			if (reason === "revoke")
				await runEvalDelegation({ op: "delegation_revoke", id: old.lease.id }, { session: f.session });
			else await Bun.sleep(Math.max(1, old.lease.expiresAt - Date.now() + 20));
			const fresh = await create(f.session);
			const language = reason === "revoke" ? "python" : "javascript";
			const source =
				language === "python"
					? `import json,sys
from proto_session import SessionClient,CapabilityError
c=SessionClient(json.load(open(sys.argv[1])))
try: c.call("calculate", {"op":"square","value":9})
except CapabilityError as e: print(e.code)
else: raise RuntimeError("revoked capability ran")
`
					: `import {readFile} from "node:fs/promises";
const {SessionClient}=await import(process.env.PROTO_SESSION_CLIENT_JS);
const c=new SessionClient(JSON.parse(await readFile(process.argv[2],"utf8")));
try { await c.call("calculate",{op:"square",value:9}); throw new Error("expired capability ran"); } catch(e) { if(!e.code) throw e; console.log(e.code); }
`;
			const script = dir.join(language === "python" ? "stale.py" : "stale.mjs");
			await Bun.write(script, source);
			await runEvalDelegation(
				{
					op: "delegation_launch",
					id: fresh.lease.id,
					name: "stale",
					application: Bun.which(language === "python" ? "python3" : "node")!,
					args: [script, stale],
				},
				{ session: f.session },
			);
			const output = await processOutput(f.session, "stale");
			expect(output.exitCode).toBe(0);
			expect(output.text.trim()).toBe("forbidden");
			expect(output.text).not.toContain(old.config.token);
			expect(f.calls).toBe(0);
			expect(await Bun.file(old.env!.PROTO_SESSION_CAPABILITY).exists()).toBe(false);
		} finally {
			await f.dispose();
			await shutdown(f.session);
		}
	}, 20_000);
}

test("JS AbortSignal cancellation drains a delegated call and releases its admission slot", async () => {
	await using dir = await TempDir.create("@delegation-cancel-");
	const f = fixture(dir.path());
	try {
		const lease = await create(f.session, { maxConcurrent: 1 }, [
			{ tool: "calculate", operations: ["hold", "square"] },
		]);
		const script = dir.join("cancel.mjs");
		await Bun.write(
			script,
			`const {fromEnv}=await import(process.env.PROTO_SESSION_CLIENT_JS);
const c=await fromEnv(); const controller=new AbortController();
process.stdin.once("data",()=>{controller.abort();process.stdin.destroy();});
try { await c.call("calculate",{op:"hold"},{signal:controller.signal}); } catch(e) { console.log(e.code); }
console.log(await c.call("calculate",{op:"square",value:3}));
`,
		);
		await runEvalDelegation(
			{
				op: "delegation_launch",
				id: lease.lease.id,
				name: "cancel",
				application: Bun.which("node")!,
				args: [script],
			},
			{ session: f.session },
		);
		await f.started;
		const client = await daemonClientForProject(f.session.cwd);
		await client.request({ op: "send", name: "cancel", data: "cancel\n" });
		const output = await processOutput(f.session, "cancel");
		expect(output.exitCode).toBe(0);
		expect(output.text.trim().split(/\r?\n/)).toEqual(["cancelled", "9"]);
		expect(f.active).toBe(0);
		const listed = await runEvalDelegation({ op: "delegation_list" }, { session: f.session });
		expect("leases" in listed && listed.leases[0].inFlight).toBe(0);
	} finally {
		await f.dispose();
		await shutdown(f.session);
	}
}, 20_000);

test("a lease and its launched process outlive the kernel cell that created them", async () => {
	await using dir = await TempDir.create("@delegation-cell-end-");
	const f = fixture(dir.path());
	try {
		// Bridge calls carry the creating cell's signal, which aborts once the cell finishes.
		const cell = new AbortController();
		const created = await runEvalDelegation(
			{ op: "delegation_create", grants: [{ tool: "calculate", operations: ["square"] }] },
			{ session: f.session, signal: cell.signal },
		);
		if (!("clients" in created)) throw new Error("Expected a created lease");
		const script = dir.join("after-cell.py");
		await Bun.write(
			script,
			`import time
from proto_session import from_env
time.sleep(0.5)
print(from_env().call("calculate", {"op":"square", "value":5}))
`,
		);
		await runEvalDelegation(
			{
				op: "delegation_launch",
				id: created.lease.id,
				name: "after-cell",
				application: Bun.which("python3")!,
				args: [script],
			},
			{ session: f.session, signal: cell.signal },
		);
		cell.abort(new Error("cell finished"));
		const output = await processOutput(f.session, "after-cell");
		expect(output).toEqual({ exitCode: 0, text: expect.stringContaining("25") });
		const listed = await runEvalDelegation({ op: "delegation_list" }, { session: f.session });
		expect("leases" in listed && listed.leases.map(lease => lease.state)).toEqual(["active"]);
	} finally {
		await f.dispose();
		await shutdown(f.session);
	}
}, 20_000);

test("revocation cancels the active tool and terminates only its verified Fleet process", async () => {
	await using dir = await TempDir.create("@delegation-revoke-process-");
	const f = fixture(dir.path());
	try {
		const lease = await create(f.session, {}, [{ tool: "calculate", operations: ["hold"] }]);
		const script = dir.join("hold.py");
		await Bun.write(
			script,
			`from proto_session import from_env
from_env().call("calculate", {"op":"hold"})
`,
		);
		const launched = await runEvalDelegation(
			{
				op: "delegation_launch",
				id: lease.lease.id,
				name: "held",
				application: Bun.which("python3")!,
				args: [script],
			},
			{ session: f.session },
		);
		await f.started;
		const client = await daemonClientForProject(f.session.cwd);
		await expect(
			client.request({ op: "stop", name: "held", expectedId: "not-the-launched-process", timeoutMs: 100 }),
		).rejects.toThrow("identity changed");
		expect(f.active).toBe(1);
		await runEvalDelegation({ op: "delegation_revoke", id: lease.lease.id }, { session: f.session });
		await f.stopped;
		const state = await client.request({ op: "describe", name: "held" });
		expect(state.op === "describe" && state.daemon.id).toBe("process" in launched && launched.process.id);
		expect(state.op === "describe" && ["exited", "failed"].includes(state.daemon.state)).toBe(true);
		expect(f.active).toBe(0);
		expect(await Bun.file(lease.env!.PROTO_SESSION_CAPABILITY).exists()).toBe(false);
	} finally {
		await f.dispose();
		await shutdown(f.session);
	}
}, 20_000);

test("request/concurrency limits deny before execution and cancellation cannot cross a lease", async () => {
	await using dir = await TempDir.create("@delegation-limits-");
	const f = fixture(dir.path());
	try {
		const lease = await create(f.session, { maxConcurrent: 1, maxRequests: 2 }, [
			{ tool: "calculate", operations: ["hold", "square"] },
		]);
		const foreign = await create(f.session);
		const id = crypto.randomUUID();
		const held = request(lease.config, "calculate", { op: "hold" }, id);
		await f.started;
		expect((await request(lease.config, "calculate", { op: "square", value: 2 })).status).toBe(429);
		const cancel = (config: { url: string; token: string }) =>
			fetch(`${config.url}/cancel`, {
				method: "POST",
				headers: { authorization: `Bearer ${config.token}` },
				body: JSON.stringify({ id }),
			});
		expect(await (await cancel(foreign.config)).json()).toEqual({ ok: true, value: { cancelled: false } });
		expect(f.active).toBe(1);
		await cancel(lease.config);
		expect((await held).body.code).toBe("cancelled");
		expect((await request(lease.config, "calculate", { op: "square", value: 4 })).body.value).toBe("16");
		expect((await request(lease.config, "calculate", { op: "square", value: 5 })).status).toBe(429);
		expect(f.calls).toBe(2);
	} finally {
		await f.dispose();
	}
});

test("narrow grants reject execution aliases, internal escalation, path publication, and unknown policy fields", async () => {
	await using dir = await TempDir.create("@delegation-policy-");
	const f = fixture(dir.path());
	try {
		for (const grant of [
			{ tool: "bash" },
			{ tool: "alias" },
			{ tool: "__agent__" },
			{ tool: "__runtime__", operations: ["delegation_create"] },
			{ tool: "__runtime__", operations: ["events_start"] },
		]) {
			await expect(create(f.session, {}, [grant])).rejects.toThrow();
		}
		for (const options of [
			{ ttlMs: Infinity },
			{ ttlMs: -1 },
			{ maxConcurrent: 0 },
			{ maxRequests: 10001 },
			{ owner: "other" },
			{ escalation: true },
		]) {
			await expect(create(f.session, options)).rejects.toThrow();
		}
		const lease = await create(f.session, {}, allowed);
		expect(
			(await request(lease.config, "__runtime__", { op: "artifact_publish", kind: "text", path: "secrets" })).body
				.code,
		).toBe("denied");
		await expect(
			runEvalDelegation(
				{
					op: "delegation_launch",
					id: lease.lease.id,
					name: "invalid",
					application: "python3",
					env: { NODE_OPTIONS: "--require=evil" },
				},
				{ session: f.session },
			),
		).rejects.toThrow("Reserved");
		expect(f.calls).toBe(0);
		const other = fixture(dir.join("other"));
		await expect(
			runEvalDelegation({ op: "delegation_revoke", id: lease.lease.id }, { session: other.session }),
		).rejects.toThrow("this session");
		await other.dispose();
	} finally {
		await f.dispose();
	}
});

test("leases expose no environment by default and session disposal closes their listener", async () => {
	await using dir = await TempDir.create("@delegation-dispose-");
	const f = fixture(dir.path());
	try {
		const hidden = await runEvalDelegation(
			{ op: "delegation_create", grants: [{ tool: "calculate" }] },
			{ session: f.session },
		);
		expect("env" in hidden).toBe(false);
		const lease = await create(f.session);
		await f.dispose();
		await expect(request(lease.config, "calculate", { op: "square", value: 2 })).rejects.toThrow();
		expect(await Bun.file(lease.env!.PROTO_SESSION_CAPABILITY).exists()).toBe(false);
	} finally {
		await f.dispose();
	}
});

test("an uncooperative canceled tool cannot release its concurrency slot before actual settlement", async () => {
	await using dir = await TempDir.create("@delegation-drain-");
	const f = fixture(dir.path());
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let calls = 0;
	const stubborn = {
		name: "stubborn",
		label: "stubborn",
		description: "Ignores cancellation until cleanup finishes",
		parameters: { type: "object" as const, properties: {} },
		async execute() {
			calls++;
			started.resolve();
			await finish.promise;
			return { content: [{ type: "text" as const, text: "settled" }] };
		},
	};
	f.session.getToolByName = name => (name === "stubborn" ? stubborn : undefined);
	try {
		const lease = await create(f.session, { maxConcurrent: 1 }, [{ tool: "stubborn" }]);
		const id = crypto.randomUUID();
		const held = request(lease.config, "stubborn", {}, id);
		await started.promise;
		await fetch(`${lease.config.url}/cancel`, {
			method: "POST",
			headers: { authorization: `Bearer ${lease.config.token}` },
			body: JSON.stringify({ id }),
		});
		expect((await request(lease.config, "stubborn", {})).status).toBe(429);
		expect(calls).toBe(1);
		finish.resolve();
		expect((await held).body.code).toBe("cancelled");
		expect((await request(lease.config, "stubborn", {})).body.value).toBe("settled");
		expect(calls).toBe(2);
	} finally {
		finish.resolve();
		await f.dispose();
	}
});

test("revoking an old process generation leaves a replacement with the same Fleet name running", async () => {
	await using dir = await TempDir.create("@delegation-generation-");
	const f = fixture(dir.path());
	try {
		const original = await create(f.session);
		const replacement = await create(f.session, {}, [{ tool: "calculate", operations: ["hold"] }]);
		const oneShot = dir.join("once.py");
		const held = dir.join("held.py");
		await Bun.write(
			oneShot,
			`from proto_session import from_env
print(from_env().call("calculate", {"op":"square","value":2}))
`,
		);
		await Bun.write(
			held,
			`from proto_session import from_env
from_env().call("calculate", {"op":"hold"})
`,
		);
		await runEvalDelegation(
			{
				op: "delegation_launch",
				id: original.lease.id,
				name: "reused",
				application: Bun.which("python3")!,
				args: [oneShot],
			},
			{ session: f.session },
		);
		expect((await processOutput(f.session, "reused")).exitCode).toBe(0);
		const launched = await runEvalDelegation(
			{
				op: "delegation_launch",
				id: replacement.lease.id,
				name: "reused",
				application: Bun.which("python3")!,
				args: [held],
			},
			{ session: f.session },
		);
		await f.started;
		await runEvalDelegation({ op: "delegation_revoke", id: original.lease.id }, { session: f.session });
		const client = await daemonClientForProject(f.session.cwd);
		const live = await client.request({ op: "describe", name: "reused" });
		expect(live.op === "describe" && live.daemon.id).toBe("process" in launched && launched.process.id);
		expect(live.op === "describe" && ["running", "ready"].includes(live.daemon.state)).toBe(true);
		expect(f.active).toBe(1);
		await runEvalDelegation({ op: "delegation_revoke", id: replacement.lease.id }, { session: f.session });
		await f.stopped;
	} finally {
		await f.dispose();
		await shutdown(f.session);
	}
}, 20_000);

test("thin completion clients send multimodal artifacts to a real HTTP provider without acquiring tool authority or credentials", async () => {
	await using dir = await TempDir.create("@delegation-completion-");
	const f = fixture(dir.path());
	const bodies: Array<Record<string, unknown>> = [];
	const keys: Array<string | null> = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming) {
			const body = (await incoming.json()) as Record<string, unknown>;
			bodies.push(body);
			keys.push(incoming.headers.get("authorization"));
			const delta = body.tools
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "structured",
								type: "function",
								function: { name: "respond", arguments: '{"tool":"bash"}' },
							},
						],
					}
				: { role: "assistant", content: "one image" };
			const chunks = [
				{
					id: "response",
					object: "chat.completion.chunk",
					created: 1,
					model: "delegation-model",
					choices: [{ index: 0, delta, finish_reason: null }],
				},
				{
					id: "response",
					object: "chat.completion.chunk",
					created: 1,
					model: "delegation-model",
					choices: [{ index: 0, delta: {}, finish_reason: body.tools ? "tool_calls" : "stop" }],
					usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
				},
			];
			return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const selected = buildModel({
		id: "delegation-model",
		provider: "openai",
		name: "delegation-model",
		api: "openai-completions",
		reasoning: false,
		input: ["text", "image"],
		baseUrl: `http://127.0.0.1:${provider.port}/v1`,
		contextWindow: 8192,
		maxTokens: 512,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
	});
	f.session.modelRegistry = {
		getAvailable: () => [selected],
		getApiKey: async () => "credential-only-in-host",
		resolver: () => async () => "credential-only-in-host",
	} as unknown as ToolSession["modelRegistry"];
	try {
		const lease = await create(f.session, {}, [...allowed, { tool: "__completion__" }]);
		const script = dir.join("completion.mjs");
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
		await Bun.write(
			script,
			`const {fromEnv}=await import(process.env.PROTO_SESSION_CLIENT_JS);
const c=await fromEnv();
const image=await c.publishArtifact(Buffer.from(${JSON.stringify(png)},"base64"),{mimeType:"image/png"});
const text=await c.completion([{type:"text",text:"describe"},{type:"image",artifact:image}],{model:"openai/delegation-model"});
const structured=await c.completion("return data",{model:"openai/delegation-model",schema:{type:"object",properties:{tool:{type:"string"}},required:["tool"]}});
let denied; try { await c.call("__completion__",{prompt:"execute",tools:[{name:"bash"}]}); } catch(e) { denied=e.code; }
console.log(JSON.stringify({text,structured,denied}));
`,
		);
		await runEvalDelegation(
			{
				op: "delegation_launch",
				id: lease.lease.id,
				name: "completion",
				application: Bun.which("node")!,
				args: [script],
			},
			{ session: f.session },
		);
		const output = await processOutput(f.session, "completion");
		expect(output.exitCode).toBe(0);
		expect(JSON.parse(output.text.trim())).toEqual({
			text: "one image",
			structured: { tool: "bash" },
			denied: "denied",
		});
		expect(output.text).not.toContain("credential-only-in-host");
		expect(keys).toEqual(["Bearer credential-only-in-host", "Bearer credential-only-in-host"]);
		const messages = bodies[0].messages as Array<{ role: string; content: unknown }>;
		expect(messages.find(message => message.role === "user")?.content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
		]);
		expect((bodies[1].tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual([
			"respond",
		]);
		expect(f.calls).toBe(0);
	} finally {
		await f.dispose();
		await shutdown(f.session);
		await provider.stop(true);
	}
}, 20_000);

test("changing the session identity invalidates saved authority even without a lifecycle callback", async () => {
	await using dir = await TempDir.create("@delegation-owner-change-");
	const f = fixture(dir.path());
	try {
		const lease = await create(f.session);
		f.session.getSessionId = () => "a-new-session";
		const status = await request(lease.config, "calculate", { op: "square", value: 3 }).then(
			result => result.status,
			() => 0,
		);
		expect([0, 403]).toContain(status); // Disposal may close the socket before delivering its denial.
		await disposeSessionDelegations(f.session);
		expect(f.calls).toBe(0);
		expect(await Bun.file(lease.env!.PROTO_SESSION_CAPABILITY).exists()).toBe(false);
	} finally {
		await f.dispose();
	}
});
