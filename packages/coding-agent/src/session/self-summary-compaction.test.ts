/**
 * Every compaction summary is written by something that only saw a serialized transcript — the
 * observational-memory extension, or a remote compactor. The session's own model supplements
 * that summary with working knowledge from the full transcript, without delegating to observers.
 * The note is appended to whichever summary was produced,
 * and a failed note never fails the compaction.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { appendSelfSummary, convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction";
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
	let nextNote: MockResponse;
	let queuedNotes: MockResponse[];

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		requests = [];
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	interface SeedOptions {
		smolRole?: boolean;
		sessionNoteFails?: boolean;
		selfSummary?: boolean;
		native?: "openai" | "anthropic";
		contextWindow?: number;
	}

	function seedSession(options: SeedOptions = {}): SessionManager {
		const bundled = getBundledModel(
			options.native ?? "anthropic",
			options.native === "openai" ? "gpt-5" : SESSION_MODEL_ID,
		) as Model;
		const sessionModel = { ...bundled, contextWindow: options.contextWindow ?? bundled.contextWindow };
		nextNote = { content: [SELF_NOTE] };
		queuedNotes = [];
		const sessionMock = createMockModel({
			handler: (context: Context): MockResponse =>
				options.sessionNoteFails && isSessionRequest(context.systemPrompt ?? [])
					? { throw: "session note request failed" }
					: (queuedNotes.shift() ?? nextNote),
		});
		const smolMock = createMockModel({ handler: (): MockResponse => nextNote });
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
			extensionRunner: extensionCompactor(options.native),
		});

		appendWork(sessionManager);
		return sessionManager;
	}

	function appendWork(sessionManager: SessionManager): void {
		const sessionModel = session.agent.state.model!;
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
	}

	/**
	 * The built-in observational-memory extension answers `session_before_compact` with its own
	 * compaction. Only the two members the session consults are stubbed; the cast is confined here
	 * so the test states the hook contract rather than reconstructing the whole runner.
	 */
	function extensionCompactor(native?: "openai" | "anthropic"): ExtensionRunner {
		const preserveData =
			native === "openai"
				? {
						openaiRemoteCompaction: {
							provider: "openai",
							replacementHistory: [{ type: "compaction", encrypted_content: "native-history" }],
						},
					}
				: native === "anthropic"
					? { anthropicCompaction: { provider: "anthropic", content: "native-history" } }
					: undefined;
		const stub = {
			hasHandlers: (event: string) => event === "session_before_compact",
			emit: async () => ({
				compaction: {
					summary: EXTENSION_SUMMARY,
					shortSummary: "extension compactor",
					firstKeptEntryId: "",
					tokensBefore: 1_000,
					details: { compactor: "test" },
					preserveData,
				},
			}),
		};
		return stub as unknown as ExtensionRunner;
	}

	function committedSummary(sessionManager: SessionManager): string {
		const entry = sessionManager.getBranch().findLast(candidate => candidate.type === "compaction");
		return entry?.type === "compaction" ? entry.summary : "";
	}

	function noteRequests(): RecordedRequest[] {
		return requests.filter(request => isSessionRequest(request.systemPrompt));
	}

	it("writes its own memory with the session model even when a smol role is configured", async () => {
		const sessionManager = seedSession({ smolRole: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).toContain("<self-summary>");
		expect(result.summary).toContain(SELF_NOTE);
		expect(committedSummary(sessionManager)).toContain(SELF_NOTE);
		const notes = noteRequests();
		expect(notes).toHaveLength(1);
		expect(notes[0].modelId).toBe(SESSION_MODEL_ID);

		const injected = session.agent.state.messages
			.map(message => textOf(convertMessageToLlm(message)))
			.find(text => text.includes("<summary>"));
		expect(injected).toContain(SELF_NOTE);
	});

	it("does not silently substitute an observer when the session model cannot write its memory", async () => {
		seedSession({ smolRole: true, sessionNoteFails: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).not.toContain("<self-summary>");
		expect(noteRequests().map(request => request.modelId)).toEqual([SESSION_MODEL_ID]);
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

	it("persists the structural summary when self-authored memory fails", async () => {
		const sessionManager = seedSession({ sessionNoteFails: true });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).toContain(EXTENSION_SUMMARY);
		expect(result.summary).not.toContain("<self-summary>");
		expect(committedSummary(sessionManager)).toContain(EXTENSION_SUMMARY);
	});

	it.each(["correction", "failure", "disabled", "empty"] as const)(
		"keeps earlier memory verbatim through another compaction (%s)",
		async outcome => {
			const sessionManager = seedSession();
			await session.reload();
			const first = await session.compact();
			const originalMemory = first.summary.slice(first.summary.indexOf("<self-summary>"));

			appendWork(sessionManager);
			await session.reload();
			const correction =
				"Correction: flushing the last token fixes the streaming parser; parser.ts:88 is now verified.";
			nextNote =
				outcome === "failure" ? { throw: "note failed" } : { content: outcome === "empty" ? [] : [correction] };
			if (outcome === "disabled") session.settings.override("compaction.selfSummary", false);
			const second = await session.compact();

			expect(second.summary).toContain(originalMemory);
			expect(second.summary.split(SELF_NOTE)).toHaveLength(2);
			expect(committedSummary(sessionManager)).toContain(originalMemory);
			const replay = session.agent.state.messages.map(message => textOf(convertMessageToLlm(message))).join("\n");
			expect(replay).toContain(originalMemory);
			if (outcome === "correction") {
				expect(second.summary.indexOf(correction)).toBeGreaterThan(second.summary.indexOf(originalMemory));
				expect(replay).toContain(correction);
			} else {
				expect(second.summary).not.toContain(correction);
			}
		},
	);

	it("consolidates the newly appended entry with earlier memory when their total crosses 30%", async () => {
		const sessionManager = seedSession({ contextWindow: 10_000 });
		const prior = appendSelfSummary(EXTENSION_SUMMARY, "earlier technique and evidence. ".repeat(350));
		sessionManager.appendCompaction(prior, "prior memory", "", 40_000);
		appendWork(sessionManager);
		await session.reload();
		const replacement = "Earlier technique: qualify evidence. New exception: after shutdown, use the backup feed.";
		queuedNotes = [
			{ content: ["New exception: after shutdown, use the backup feed. ".repeat(300)] },
			{ content: [replacement] },
		];
		await session.compact();
		expect(noteRequests()).toHaveLength(2);
		const consolidationInput = noteRequests()[1].messages.map(textOf).join("\n");
		expect(consolidationInput).toContain("earlier technique and evidence");
		expect(consolidationInput).toContain("New exception: after shutdown, use the backup feed.");
		expect(committedSummary(sessionManager)).toContain(replacement);
		expect(committedSummary(sessionManager).match(/<self-summary>/g)).toHaveLength(1);
	});

	it.each(["empty", "truncated", "aborted", "oversized", "failed"] as const)(
		"does not commit a %s safety consolidation over the earlier memory",
		async outcome => {
			const sessionManager = seedSession({ selfSummary: false, contextWindow: 10_000 });
			const prior = appendSelfSummary(EXTENSION_SUMMARY, "earlier technique and evidence. ".repeat(800));
			sessionManager.appendCompaction(prior, "prior memory", "", 40_000);
			appendWork(sessionManager);
			await session.reload();
			session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			const originalEntries = sessionManager.getBranch().filter(entry => entry.type === "compaction").length;
			nextNote =
				outcome === "failed"
					? { throw: "consolidation unavailable" }
					: outcome === "truncated" || outcome === "aborted"
						? { content: ["Partial memory"], stopReason: outcome === "aborted" ? "aborted" : "length" }
						: { content: outcome === "empty" ? [] : ["still oversized memory. ".repeat(2_000)] };

			await expect(session.compact()).rejects.toThrow();
			expect(noteRequests()).toHaveLength(1);
			expect(committedSummary(sessionManager)).toBe(prior);
			expect(sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(originalEntries);
			expect(session.agent.state.messages.map(message => textOf(convertMessageToLlm(message))).join("\n")).toContain(
				"earlier technique and evidence",
			);
		},
	);

	it.each(["openai", "anthropic"] as const)(
		"leaves %s native compaction to the provider without extra self-memory requests",
		async native => {
			const sessionManager = seedSession({ native });
			await session.reload();
			await session.compact();
			appendWork(sessionManager);
			await session.reload();
			const result = await session.compact();

			expect(result.summary).toBe(EXTENSION_SUMMARY);
			expect(noteRequests()).toHaveLength(0);
		},
	);

	it("skips the extra request when self-written summaries are turned off", async () => {
		seedSession({ selfSummary: false });
		await session.reload();

		const result = await session.compact();

		expect(result.summary).not.toContain("<self-summary>");
		expect(noteRequests()).toHaveLength(0);
	});
});
