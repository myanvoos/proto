/**
 * Every compaction summary is written by something that only saw a serialized transcript — the
 * observational-memory extension, or a remote compactor. The handoff note is written from that
 * transcript by the same memory-role models that power the observation agent (@smol, then @tiny),
 * falling back to the session's own model. The note is appended to whichever summary was produced,
 * and a failed note never fails the compaction.
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
const EXTENSION_SUMMARY = "[Session Goal]\n- extension compactor summary";
const SMOL_MODEL_ID = "claude-haiku-4-5";
const SESSION_MODEL_ID = "claude-sonnet-4-5";

interface RecordedRequest {
	modelId: string;
	systemPrompt: readonly string[];
	messages: Message[];
}

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
	let requests: RecordedRequest[];

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
		smolRole?: boolean;
		smolFails?: boolean;
		sessionNoteFails?: boolean;
		selfSummary?: boolean;
	}

	function seedSession(options: SeedOptions = {}): SessionManager {
		const sessionModel = getBundledModel("anthropic", SESSION_MODEL_ID) as Model;
		const noteRequest: MockResponse = { content: [SELF_NOTE] };
		const sessionMock = createMockModel({
			handler: (context: Context): MockResponse =>
				options.sessionNoteFails && isSessionRequest(context.systemPrompt ?? [])
					? { throw: "session note request failed" }
					: noteRequest,
		});
		const smolMock = createMockModel({
			handler: (): MockResponse => (options.smolFails ? { throw: "memory-role request failed" } : noteRequest),
		});
		const streamFn: typeof sessionMock.stream = (requestModel, context: Context, streamOptions) => {
			requests.push({
				modelId: requestModel.id,
				systemPrompt: context.systemPrompt ?? [],
				messages: context.messages,
			});
			const mock = requestModel.id === SMOL_MODEL_ID ? smolMock : sessionMock;
			return mock.stream(requestModel, context, streamOptions);
		};

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: sessionModel, systemPrompt: [...SESSION_PROMPT], tools: [], messages: [] },
				streamFn,
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.selfSummary": options.selfSummary ?? true,
				...(options.smolRole ? { "modelRoles.smol": `anthropic/${SMOL_MODEL_ID}` } : {}),
			}),
			modelRegistry: new ModelRegistry(authStorage!),
			sideStreamFn: streamFn,
			extensionRunner: extensionCompactor(),
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
				api: sessionModel.api,
				provider: sessionModel.provider,
				model: sessionModel.id,
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

	function noteRequests(): RecordedRequest[] {
		return requests.filter(request => isSessionRequest(request.systemPrompt));
	}

	it("writes the note with the smol memory-role model before touching the session model", async () => {
		const sessionManager = seedSession({ smolRole: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).toContain("<self-summary>");
		expect(result.summary).toContain(SELF_NOTE);
		expect(committedSummary(sessionManager)).toContain(SELF_NOTE);
		const notes = noteRequests();
		expect(notes).toHaveLength(1);
		expect(notes[0].modelId).toBe(SMOL_MODEL_ID);

		const injected = session.agent.state.messages
			.map(message => textOf(convertMessageToLlm(message)))
			.find(text => text.includes("<summary>"));
		expect(injected).toContain(SELF_NOTE);
	});

	it("falls back to the session model when the memory-role model fails", async () => {
		seedSession({ smolRole: true, smolFails: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(SELF_NOTE);
		const notes = noteRequests();
		expect(notes.map(request => request.modelId)).toEqual([SMOL_MODEL_ID, SESSION_MODEL_ID]);
	});

	it("asks for the note under the session's own system prompt, replaying the folded transcript", async () => {
		seedSession({ smolRole: true });
		await session.reload();

		await session.compact();

		const noteRequest = noteRequests()[0];
		expect(noteRequest).toBeDefined();
		// Identical system prompt plus a replay of the live messages is what keeps the request on the
		// session's warm cache prefix; a summarizer persona and a flattened transcript would not.
		expect(noteRequest.systemPrompt).toEqual(SESSION_PROMPT);
		expect(noteRequest.messages.length).toBeGreaterThan(2);
		expect(textOf(noteRequest.messages[0])).toContain("turn 0: investigate parser bug");
	});

	it("appends to an extension compactor's summary instead of replacing it", async () => {
		const sessionManager = seedSession();
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).toContain(SELF_NOTE);
		expect(committedSummary(sessionManager)).toContain(EXTENSION_SUMMARY);
	});

	it("commits the compaction unchanged when every note candidate fails", async () => {
		const sessionManager = seedSession({ smolRole: true, smolFails: true, sessionNoteFails: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).not.toContain("<self-summary>");
		expect(committedSummary(sessionManager)).toContain(EXTENSION_SUMMARY);
	});

	it("skips the extra request when self-written summaries are turned off", async () => {
		seedSession({ selfSummary: false });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).not.toContain("<self-summary>");
		expect(noteRequests()).toHaveLength(0);
	});
});
