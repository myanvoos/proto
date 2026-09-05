import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Server } from "bun";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

interface CompletionServer {
	server: Server<undefined>;
	requests: Array<{ prompt: string; body: unknown }>;
	release: () => void;
}

function startCompletionServer(holdFirst = false): CompletionServer {
	const requests: Array<{ prompt: string; body: unknown }> = [];
	const first = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { messages?: Array<{ content?: Array<{ text?: string }> }> };
			const prompt = body.messages?.at(-1)?.content?.[0]?.text ?? "";
			requests.push({ prompt, body });
			const requestNumber = requests.length;
			if (holdFirst && requestNumber === 1) await first.promise;
			const answer = `sample-${requestNumber}`;
			const sse = [
				`data: ${JSON.stringify({ id: "spec", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ id: "spec", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				"data: [DONE]\n\n",
			].join("");
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return {
		server,
		requests,
		release: () => first.resolve(),
	};
}

const kernelOwners = new Set<string>();

function makeSession(cwd: string, baseUrl: string, settings: Map<string, unknown>): ToolSession {
	const kernelOwner = `spec-owner:${cwd}`;
	kernelOwners.add(kernelOwner);
	const model = buildModel({
		provider: "openai",
		id: "spec-test",
		name: "spec-test",
		api: "openai-completions",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 256,
	});
	return {
		cwd,
		settings: {
			get: (key: string) => settings.get(key),
			getShellConfig: () => ({ env: {} }),
		},
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "spec-key",
			resolver: () => "spec-key",
		},
		getActiveModelString: () => "openai/spec-test",
		getModelString: () => "openai/spec-test",
		getSessionId: () => `spec-test:${cwd}`,
		getEvalSessionId: () => `spec-eval:${cwd}`,
		getEvalKernelOwnerId: () => kernelOwner,
		getSessionFile: () => null,
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function outputText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function waitForRequests(requests: Array<unknown>, count: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (requests.length < count && Date.now() < deadline) await Bun.sleep(10);
	expect(requests.length).toBeGreaterThanOrEqual(count);
}

function settings(): Map<string, unknown> {
	return new Map<string, unknown>([
		["eval.py", true],
		["eval.js", true],
		["kernel.speculation.enabled", true],
		["kernel.assertPreflight.enabled", false],
		["python.kernelMode", "per-call"],
	]);
}

afterEach(async () => {
	for (const owner of kernelOwners) {
		await disposeKernelSessionsByOwner(owner);
		await disposeVmContextsByOwner(owner);
	}
	kernelOwners.clear();
});

test("Python BashTool claims two distinct literal completion occurrences from partial JSON", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-py-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		const bash = new BashTool(session);
		const partialCommand = `python <<'PY'\na = completion("same")\n`;
		const partialJson = JSON.stringify({ command: partialCommand }).slice(0, -1);
		await bash.observeStreamedInput("python-outer", partialJson);
		await waitForRequests(completion.requests, 1);
		const command = `${partialCommand}b = completion("same")\nprint(a, b)\nPY`;
		await bash.observeStreamedInput("python-outer", JSON.stringify({ command }));
		await waitForRequests(completion.requests, 2);
		completion.release();
		const result = await bash.execute("python-outer", { command });
		expect(outputText(result)).toContain("sample-1 sample-2");
		expect(completion.requests).toHaveLength(2);
		bash.cancelStreamedInput();
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("JavaScript BashTool claims literal completions through the worker bridge", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-js-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		const bash = new BashTool(session);
		const partialCommand = `node <<'JS'\nconst a = await completion("same");\n`;
		const partialJson = JSON.stringify({ command: partialCommand }).slice(0, -1);
		await bash.observeStreamedInput("js-outer", partialJson);
		await waitForRequests(completion.requests, 1);
		const command = `${partialCommand}const b = await completion("same");\nconsole.log(a, b);\nJS`;
		await bash.observeStreamedInput("js-outer", JSON.stringify({ command }));
		await waitForRequests(completion.requests, 2);
		completion.release();
		const result = await bash.execute("js-outer", { command });
		expect(outputText(result)).toContain("sample-1 sample-2");
		expect(completion.requests).toHaveLength(2);
		bash.cancelStreamedInput();
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("late cwd invalidates a pending future instead of claiming it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-late-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		const bash = new BashTool(session);
		const command = `python <<'PY'\na = completion("late")\nprint(a)\nPY`;
		const partialJson = JSON.stringify({ command }).slice(0, -1);
		await bash.observeStreamedInput("late-outer", partialJson);
		await waitForRequests(completion.requests, 1);
		await bash.observeStreamedInput("late-outer", JSON.stringify({ command, cwd: dir }));
		const resultPromise = bash.execute("late-outer", { command, cwd: dir });
		await waitForRequests(completion.requests, 2);
		completion.release();
		const result = await resultPromise;
		expect(outputText(result)).toContain("sample-2");
		expect(completion.requests).toHaveLength(2);
		bash.cancelStreamedInput();
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("cancelling a streamed call disposes its future before final execution", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-cancel-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		const bash = new BashTool(session);
		const command = `python <<'PY'\na = completion("cancel")\nprint(a)\nPY`;
		const partialJson = JSON.stringify({ command }).slice(0, -1);
		await bash.observeStreamedInput("cancel-outer", partialJson);
		await waitForRequests(completion.requests, 1);
		bash.cancelStreamedInput("cancel-outer");
		const resultPromise = bash.execute("cancel-outer", { command });
		await waitForRequests(completion.requests, 2);
		completion.release();
		const result = await resultPromise;
		expect(outputText(result)).toContain("sample-2");
		expect(completion.requests).toHaveLength(2);
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("revisions cap early launches at two for one outer call", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-cap-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		const bash = new BashTool(session);
		const command = `python <<'PY'\na = completion("cap")\nprint(a)\nPY`;
		await bash.observeStreamedInput("cap-outer", JSON.stringify({ command }).slice(0, -1));
		await waitForRequests(completion.requests, 1);
		await bash.observeStreamedInput("cap-outer", JSON.stringify({ command, cwd: dir }));
		await waitForRequests(completion.requests, 2);
		await bash.observeStreamedInput("cap-outer", JSON.stringify({ command, cwd: dir, env: { LATE: "1" } }));
		await bash.observeStreamedInput("cap-outer", JSON.stringify({ command, cwd: dir, env: { LATE: "2" } }));
		expect(completion.requests).toHaveLength(2);
		bash.cancelStreamedInput("cap-outer");
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("aborting final execution aborts its speculative request", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-spec-abort-"));
	const completion = startCompletionServer(true);
	try {
		const session = makeSession(dir, `http://127.0.0.1:${completion.server.port}/v1`, settings());
		let fetchAborted = 0;
		session.fetch = async (input, init) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					fetchAborted++;
				},
				{ once: true },
			);
			return await fetch(input, init);
		};
		const bash = new BashTool(session);
		const command = `python <<'PY'\na = completion("abort")\nprint(a)\nPY`;
		await bash.observeStreamedInput("abort-outer", JSON.stringify({ command }).slice(0, -1));
		await waitForRequests(completion.requests, 1);
		const controller = new AbortController();
		const execution = bash.execute("abort-outer", { command }, controller.signal).catch(error => error);
		controller.abort();
		completion.release();
		const error = await execution;
		expect(error).toBeInstanceOf(Error);
		const deadline = Date.now() + 5_000;
		while (fetchAborted === 0 && Date.now() < deadline) await Bun.sleep(10);
		expect(fetchAborted).toBeGreaterThan(0);
		bash.cancelStreamedInput();
	} finally {
		completion.release();
		await completion.server.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);
