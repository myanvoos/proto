/**
 * Every compaction summary is written by something that only saw a serialized transcript: the
 * built-in summarizer, or an extension replaying its own observational memory. The session's own
 * model still holds the live context, so its note is appended to whichever summary was produced —
 * without replacing it, and without being able to fail the compaction.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const SESSION_PROMPT = ["SESSION-SYSTEM-PROMPT-MARKER", "Follow repo conventions."];
const SELF_NOTE = "I ruled out the streaming parser: it drops the final token. parser.ts:88 is applied but unverified.";
const SUMMARIZER_TEXT = "## Goal\nFinish the parser rewrite";
const EXTENSION_SUMMARY = "[Session Goal]\n- extension compactor summary";

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => ("text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

function isSessionRequest(systemPrompt: readonly string[]): boolean {
	return systemPrompt[0] === SESSION_PROMPT[0];
}

describe("self-written compaction summary", () => {
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;
	let requests: Array<{ systemPrompt: readonly string[]; messages: Message[] }>;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		requests = [];
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	interface SeedOptions {
		extensionCompactor?: boolean;
		selfSummary?: boolean;
		failSelfSummary?: boolean;
	}

	function seedSession(options: SeedOptions = {}): SessionManager {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const mock = createMockModel({
			handler: (context: Context): MockResponse => {
				if (!isSessionRequest(context.systemPrompt ?? [])) return { content: [SUMMARIZER_TEXT] };
				if (options.failSelfSummary) return { throw: "self-summary request failed" };
				return { content: [SELF_NOTE] };
			},
		});
		const streamFn: typeof mock.stream = (requestModel, context: Context, streamOptions) => {
			requests.push({ systemPrompt: context.systemPrompt ?? [], messages: context.messages });
			return mock.stream(requestModel, context, streamOptions);
		};

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [...SESSION_PROMPT], tools: [], messages: [] },
				streamFn,
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.selfSummary": options.selfSummary ?? true,
			}),
			modelRegistry: new ModelRegistry(authStorage!),
			sideStreamFn: streamFn,
			extensionRunner: options.extensionCompactor ? extensionCompactor() : undefined,
		});

		const bulk = "parser token stream analysis. ".repeat(600);
		for (let turn = 0; turn < 12; turn++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${turn}: investigate parser bug\n${bulk}` }],
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `analysis ${turn}\n${bulk}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 12_000 * (turn + 1),
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12_000 * (turn + 1) + 50,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}
		return sessionManager;
	}

	/**
	 * The built-in observational-memory extension answers `session_before_compact` with its own
	 * compaction. Only the two members the session consults are stubbed; the cast is confined here
	 * so the test states the hook contract rather than reconstructing the whole runner.
	 */
	function extensionCompactor(): ExtensionRunner {
		const stub = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async () => ({
				compaction: {
					summary: EXTENSION_SUMMARY,
					shortSummary: "extension compactor",
					firstKeptEntryId: "",
					tokensBefore: 1_000,
					details: { compactor: "test" },
				},
			}),
		};
		return stub as unknown as ExtensionRunner;
	}

	function committedSummary(sessionManager: SessionManager): string {
		const entry = sessionManager.getBranch().find(candidate => candidate.type === "compaction");
		return entry?.type === "compaction" ? entry.summary : "";
	}

	it("commits the session model's own note alongside the summarizer's summary", async () => {
		const sessionManager = seedSession();
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(SUMMARIZER_TEXT);
		expect(result.summary).toContain("<self-summary>");
		expect(result.summary).toContain(SELF_NOTE);
		expect(committedSummary(sessionManager)).toContain(SELF_NOTE);

		const injected = session.agent.state.messages
			.map(message => textOf(convertMessageToLlm(message)))
			.find(text => text.includes("<summary>"));
		expect(injected).toContain(SELF_NOTE);
	});

	it("asks for the note under the session's own system prompt, replaying the folded transcript", async () => {
		seedSession();
		await session.reload();

		await session.compact();

		const noteRequest = requests.find(request => isSessionRequest(request.systemPrompt));
		expect(noteRequest).toBeDefined();
		// Identical system prompt plus a replay of the live messages is what keeps the request on the
		// session's warm cache prefix; a summarizer persona and a flattened transcript would not.
		expect(noteRequest?.systemPrompt).toEqual(SESSION_PROMPT);
		expect(noteRequest?.messages.length).toBeGreaterThan(2);
		expect(textOf(noteRequest?.messages[0])).toContain("turn 0: investigate parser bug");
	});

	it("appends to an extension compactor's summary instead of replacing it", async () => {
		const sessionManager = seedSession({ extensionCompactor: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).toContain(SELF_NOTE);
		expect(committedSummary(sessionManager)).toContain(EXTENSION_SUMMARY);
	});

	it("commits the compaction unchanged when the note request fails", async () => {
		const sessionManager = seedSession({ failSelfSummary: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(SUMMARIZER_TEXT);
		expect(result.summary).not.toContain("<self-summary>");
		expect(committedSummary(sessionManager)).toContain(SUMMARIZER_TEXT);
	});

	it("skips the extra request when self-written summaries are turned off", async () => {
		seedSession({ selfSummary: false });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).not.toContain("<self-summary>");
		expect(requests.some(request => isSessionRequest(request.systemPrompt))).toBe(false);
	});
});
