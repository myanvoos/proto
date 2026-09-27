import { afterEach, expect, test, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { listVmKernelSessions } from "../eval/js/context-manager";
import { SessionManager } from "../session/session-manager";
import type { ToolSession } from "./index";
import { RecallTool } from "./recall";

function text(result: AgentToolResult): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function fixture(
	run: (tool: RecallTool, session: ToolSession, manager: SessionManager) => Promise<void>,
): Promise<void> {
	await using dir = await TempDir.create("@recall-test-");
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const session: ToolSession = {
		cwd: dir.path(),
		hasUI: false,
		settings: Settings.isolated({ modelRoles: { smol: "recall-test/small", tiny: "recall-test/tiny" } }),
		sessionManager: manager,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getSessionId: () => manager.getSessionId(),
		allocateOutputArtifact: kind => manager.allocateArtifactPath(kind),
	};
	manager.appendMessage({ role: "user", content: "Use exponential backoff for retry storms.", timestamp: 1 });
	await manager.ensureOnDisk();
	try {
		await run(new RecallTool(session), session, manager);
	} finally {
		await manager.close();
	}
}

afterEach(() => vi.restoreAllMocks());

test("native recall searches history and only expands another branch when scope is all", async () => {
	await fixture(async (tool, _session, manager) => {
		const root = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "Discarded branch says fixed delay.", timestamp: 2 });
		manager.branch(root);
		manager.appendMessage({ role: "user", content: "Current branch caps the delay.", timestamp: 3 });
		expect(text(await tool.execute("search", { query: "backoff" }))).toContain("exponential backoff");
		expect(text(await tool.execute("lineage", { query: "#1" }))).toContain("outside active lineage");
		expect(text(await tool.execute("all", { query: "#1", scope: "all" }))).toContain("fixed delay");
		expect(text(await tool.execute("page", { query: "#2:text:0:1" }))).toContain("caps the delay");
	});
});

test("query functions see full scoped entries with stable citations, not lexical matches or clipped previews", async () => {
	await fixture(async (tool, _session, manager) => {
		const root = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
		manager.branch(root);
		manager.appendMessage({ role: "user", content: `${"x".repeat(4000)} evidence at the end`, timestamp: 3 });
		const code =
			"({query, entries}) => ({query, ids: entries.map(e => e.index), suffix: entries.at(-1).message.content.slice(-19)})";
		const result = await tool.execute("scoped", { query: "semantically unrelated wording", code });
		expect(result.isError, text(result)).not.toBe(true);
		expect(JSON.parse(text(result))).toEqual({
			query: "semantically unrelated wording",
			ids: [0, 2],
			suffix: "evidence at the end",
		});
		const all = await tool.execute("all", {
			query: "branches",
			code: "({entries}) => entries.map(e => e.index)",
			scope: "all",
		});
		expect(JSON.parse(text(all))).toEqual([0, 1, 2]);
		manager.resetLeaf();
		const empty = await tool.execute("empty-lineage", {
			query: "branches",
			code: "({entries}) => entries.map(e => e.index)",
		});
		expect(JSON.parse(text(empty))).toEqual([]);
	});
}, 20_000);

test("transcript map reduce calls tiny and smol through the kernel and returns cited evidence", async () => {
	await fixture(async (tool, session, manager) => {
		manager.appendMessage({ role: "user", content: "Cap the delay at five seconds.", timestamp: 2 });
		const bothStarted = Promise.withResolvers<void>();
		let started = 0;
		const models = ["tiny", "small"].map(
			id =>
				({
					provider: "recall-test",
					id,
					name: id,
					api: "openai-completions",
					input: ["text"],
					reasoning: false,
				}) as Model,
		);
		session.modelRegistry = {
			getAvailable: () => models,
			getApiKey: async () => "test-only-key",
			resolver: () => async () => "test-only-key",
		} as unknown as ToolSession["modelRegistry"];
		const call = vi.spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async (model, context) => {
			if (model.id === "tiny") {
				if (++started === 2) bothStarted.resolve();
				await bothStarted.promise;
			}
			const content = context.messages[0]?.content;
			const payload =
				typeof content === "string"
					? content
					: (content
							?.filter(p => p.type === "text")
							.map(p => p.text)
							.join("") ?? "");
			const input = JSON.parse(payload);
			const answer = model.id === "tiny" ? `#${input.entry.index}: ${input.entry.summary}` : input.notes.join("\n");
			return {
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;
		});
		const result = await tool.execute("map-reduce", {
			query: "Why did retries change?",
			code: `async ({query, entries}) => {
				const notes = await parallel(entries.map(entry => () => completion(JSON.stringify({query, entry}), {model: 'tiny'})), {concurrency: 2});
				return await completion(JSON.stringify({query, notes}), {model: 'smol'});
			}`,
		});
		expect(result.isError, text(result)).not.toBe(true);
		expect(text(result)).toContain("#0: Use exponential backoff for retry storms.");
		expect(text(result)).toContain("#1: Cap the delay at five seconds.");
		expect(call.mock.calls.map(args => args[0].id)).toEqual(["tiny", "tiny", "small"]);
	});
}, 20_000);

test("model failures and caller cancellation fail recall without retrying the provider", async () => {
	await fixture(async (tool, session) => {
		const selected = {
			provider: "recall-test",
			id: "tiny",
			api: "openai-completions",
			input: ["text"],
			reasoning: false,
		} as Model;
		session.modelRegistry = {
			getAvailable: () => [selected],
			getApiKey: async () => "test-only-key",
			resolver: () => async () => "test-only-key",
		} as unknown as ToolSession["modelRegistry"];
		const abort = new AbortController();
		let cancel = false;
		let providerSignal: AbortSignal | undefined;
		const request = vi
			.spyOn(agentCore, "instrumentedCompleteSimple")
			.mockImplementation(async (_model, _context, options) => {
				providerSignal = options?.signal;
				if (cancel) {
					abort.abort();
					throw new DOMException("cancelled request", "AbortError");
				}
				throw new Error("provider unavailable");
			});
		const params = { query: "retries", code: "async ({query}) => completion(query, {model: 'tiny'})" };
		const failed = await tool.execute("provider-failure", params);
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("provider unavailable");
		cancel = true;
		const cancelled = await tool.execute("cancel", params, abort.signal);
		expect(cancelled.isError).toBe(true);
		expect(text(cancelled)).toContain("Recall query cancelled");
		expect(providerSignal?.aborted).toBe(true);
		expect(request).toHaveBeenCalledTimes(2);
	});
}, 20_000);

test("code failures surface as errors and subsequent queries use a fresh kernel", async () => {
	await fixture(async tool => {
		const failed = await tool.execute("fail", {
			query: "test",
			code: '() => { globalThis.leaked = true; throw new Error("query failure"); }',
		});
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("query failure");
		const next = await tool.execute("fresh", { query: "test", code: "() => typeof globalThis.leaked" });
		expect(next.isError, text(next)).not.toBe(true);
		expect(text(next).trim()).toBe("undefined");
		const invalid = await tool.execute("invalid", { query: "test", code: "42" });
		expect(invalid.isError).toBe(true);
		expect(text(invalid)).toContain("function expression");
	});
}, 20_000);

test("deadline kills a non-cooperative query without leaving its kernel alive", async () => {
	await fixture(async tool => {
		const before = new Set(listVmKernelSessions().map(kernel => kernel.sessionId));
		// A real worker must be force-killed; host fake timers cannot advance its process clock.
		const result = await tool.execute("timeout", {
			query: "test",
			code: "async () => { await Promise.resolve(); while (true) {} }",
			timeout: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.timeout).toMatchObject({ cause: "deadline", scope: "cell" });
		expect(listVmKernelSessions().filter(kernel => !before.has(kernel.sessionId))).toEqual([]);
	});
}, 15_000);

test("invalid query combinations and read-only agents cannot silently execute code", async () => {
	await fixture(async (tool, session) => {
		await expect(tool.execute("no-query", { code: "() => 1" })).rejects.toThrow("requires a non-empty query");
		await expect(tool.execute("mixed", { query: "q", code: "() => 1", page: 1 })).rejects.toThrow(
			"cannot be combined",
		);
		await expect(tool.execute("timeout-only", { timeout: 1 })).rejects.toThrow("requires code");
		session.restrictToolNames = true;
		session.isToolActive = () => false;
		await expect(tool.execute("restricted", { query: "q", code: "() => 1" })).rejects.toThrow(
			"requires bash execution permission",
		);
		expect(text(await tool.execute("ordinary", { query: "backoff" }))).toContain("exponential backoff");
	});
});
