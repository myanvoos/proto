import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentProtocolHandler } from "./agent-protocol";
import { registerArtifactsDir } from "./registry-helpers";
import type { InternalUrl } from "./types";

test("nested worker output remains recoverable after its live registration is gone", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-recovery-"));
	const unregister = registerArtifactsDir(root);
	try {
		const nested = path.join(root, "parent-worker");
		await fs.mkdir(nested);
		const id = "nested-worker-recovery";
		await Bun.write(path.join(nested, `${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n`);
		const output = path.join(nested, `${id}.md`);
		await Bun.write(output, JSON.stringify({ result: "persisted final output" }));
		const handler = new AgentProtocolHandler();
		const url = Object.assign(new URL(`agent://${id}`), { rawHost: id }) satisfies InternalUrl;
		const resource = await handler.resolve(url);
		expect(resource.sourcePath).toBe(output);
		expect(JSON.parse(resource.content)).toEqual({ result: "persisted final output" });
		url.searchParams.set("q", ".result");
		expect(JSON.parse((await handler.resolve(url)).content)).toBe("persisted final output");
	} finally {
		unregister();
		await fs.rm(root, { recursive: true, force: true });
	}
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

function agentUrl(id: string): InternalUrl {
	return Object.assign(new URL(`agent://${id}`), { rawHost: id }) satisfies InternalUrl;
}

async function writeWorkerSession(root: string, id: string): Promise<string> {
	const file = path.join(root, `${id}.jsonl`);
	const now = new Date().toISOString();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = { api: "openai-responses", provider: "openai", model: "test", usage };
	const messages = [
		{ role: "user", content: "start", timestamp: 1 },
		{
			...assistant,
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "yield", arguments: {} }],
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "yield",
			content: [{ type: "text", text: "Section recorded." }],
			details: { data: { found: "SECTION-MARKER" }, status: "success", type: ["findings"] },
			isError: false,
			timestamp: 2,
		},
		{
			...assistant,
			role: "assistant",
			content: [{ type: "text", text: "LATEST-TEXT-MARKER" }],
			stopReason: "stop",
			timestamp: 3,
		},
	];
	const entries = messages.map((message, index) =>
		JSON.stringify({
			type: "message",
			id: `e${index}`,
			parentId: index ? `e${index - 1}` : null,
			timestamp: now,
			message,
		}),
	);
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: root });
	await Bun.write(file, `${[header, ...entries].join("\n")}\n`);
	return file;
}

test("a registered agent without published output resolves to its progress", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-progress-"));
	try {
		const id = "running-worker";
		const sessionFile = await writeWorkerSession(root, id);
		AgentRegistry.global().register({ id, label: id, kind: "sub", session: null, sessionFile, status: "running" });

		const resource = await new AgentProtocolHandler().resolve(agentUrl(id));

		expect(resource.content).toContain("# running-worker (running)");
		expect(resource.content).toContain("## Yield [findings]");
		expect(resource.content).toContain("SECTION-MARKER");
		expect(resource.content).toContain("LATEST-TEXT-MARKER");
		const extraction = agentUrl(id);
		extraction.searchParams.set("q", ".found");
		await expect(new AgentProtocolHandler().resolve(extraction)).rejects.toThrow("not published yet");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a published output is flagged as the previous run while the agent streams a newer turn", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-superseded-"));
	const unregister = registerArtifactsDir(root);
	try {
		const id = "busy-worker";
		const sessionFile = await writeWorkerSession(root, id);
		await Bun.write(path.join(root, `${id}.md`), "OLD-RESULT");
		const registry = AgentRegistry.global();
		registry.register({ id, label: id, kind: "sub", session: null, sessionFile, status: "idle" });
		expect((await new AgentProtocolHandler().resolve(agentUrl(id))).content).toBe("OLD-RESULT");

		registry.setStatus(id, "running");
		const resource = await new AgentProtocolHandler().resolve(agentUrl(id));
		expect(resource.content).toContain("PREVIOUS run");
		expect(resource.content.endsWith("OLD-RESULT")).toBe(true);
	} finally {
		unregister();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("unknown ids suggest a few close matches instead of every output", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-missing-"));
	const unregister = registerArtifactsDir(root);
	try {
		for (let index = 0; index < 20; index++) await Bun.write(path.join(root, `worker-${index}.md`), "done");
		await Bun.write(path.join(root, "unrelated-output.md"), "done");

		const error = await new AgentProtocolHandler().resolve(agentUrl("workr-1")).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toStartWith("Not found: workr-1\nDid you mean: ");
		expect(message.split("Did you mean: ")[1]!.split(", ")).toHaveLength(5);
		expect(message).not.toContain("unrelated-output");
	} finally {
		unregister();
		await fs.rm(root, { recursive: true, force: true });
	}
});
