/**
 * Compaction paraphrases everything except what the user actually said: with the observational
 * memory engine as the only summary engine, every folded user message must reach the
 * post-compaction context verbatim through its `[User Messages]` section, with oversized pastes
 * reduced to a head plus the `#N` recall pointer that recovers them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import vendorMemoryExtension, { PRE_COMPACTION_OUTPUT_TYPE } from "../vendor/pi-blackhole/index.js";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const SESSION_PROMPT = ["SESSION-SYSTEM-PROMPT-MARKER", "Follow repo conventions."];
const SELF_NOTE = "Self note marker for the handoff written by the session model.";
const PASTE = "PASTE_PAYLOAD_LINE\n".repeat(400);
const PASTE_PREFIX = "please port this module:\n";
const BULK_ANALYSIS = "parser token stream analysis. ".repeat(600);

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => ("text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

function isSessionRequest(systemPrompt: readonly string[]): boolean {
	return systemPrompt[0] === SESSION_PROMPT[0];
}

type MemoryHandler = (event: unknown, ctx: unknown) => unknown;

interface MemoryExtension {
	/** Every handler the extension registered, by event type. */
	handlers: Map<string, MemoryHandler[]>;
	/** Custom entry types the extension can draw — the transcript projects only these. */
	renderers: Set<string>;
	/** Session the extension's `appendEntry` writes to; set once the session exists. */
	appendTo(sessionManager: SessionManager): void;
}

/**
 * Runs the real vendored observational-memory extension factory against a recording `pi` stub, so
 * the session-level tests exercise the production hooks rather than a summary stub.
 */
async function loadMemoryExtension(): Promise<MemoryExtension> {
	const handlers = new Map<string, MemoryHandler[]>();
	const renderers = new Set<string>();
	let target: SessionManager | undefined;
	const pi = new Proxy(
		{
			on: (type: string, handler: MemoryHandler) => {
				handlers.set(type, [...(handlers.get(type) ?? []), handler]);
			},
			registerMessageRenderer: (customType: string) => {
				renderers.add(customType);
			},
			appendEntry: (customType: string, data: unknown) => {
				target?.appendCustomEntry(customType, data);
			},
		},
		{
			get(recorded, prop) {
				if (prop in recorded) return recorded[prop as keyof typeof recorded];
				return () => undefined;
			},
		},
	);
	await vendorMemoryExtension(pi as never);
	if (!handlers.get("session_before_compact")?.[0]) {
		throw new Error("observational memory did not register session_before_compact");
	}
	return {
		handlers,
		renderers,
		appendTo(sessionManager: SessionManager) {
			target = sessionManager;
		},
	};
}

describe("user message retention across compaction", () => {
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;
	let agentDir: TempDir;
	let previousAgentDir: string | undefined;

	beforeAll(async () => {
		agentDir = await TempDir.create("proto-om-test-");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir.path();
	});

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	afterAll(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await agentDir.remove();
	});

	function seedSession(memory: MemoryExtension): SessionManager {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const mock = createMockModel({
			handler: (context: Context): MockResponse => {
				if (!isSessionRequest(context.systemPrompt ?? [])) return { content: ["unused summarizer reply"] };
				return { content: [SELF_NOTE] };
			},
		});
		const streamFn: typeof mock.stream = (requestModel, context: Context, streamOptions) =>
			mock.stream(requestModel, context, streamOptions);

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
				"compaction.selfSummary": true,
			}),
			modelRegistry: new ModelRegistry(authStorage!),
			sideStreamFn: streamFn,
			extensionRunner: {
				hasHandlers: (event: string) => (memory.handlers.get(event)?.length ?? 0) > 0,
				renderableCustomTypes: () => memory.renderers,
				getMessageRenderer: (customType: string) =>
					memory.renderers.has(customType) ? () => undefined : undefined,
				emit: async (event: { type: string }) => {
					const ctx = {
						cwd: process.cwd(),
						hasUI: false,
						ui: { notify() {} },
						model: { provider: model.provider, id: model.id, api: model.api },
						modelRegistry: session.modelRegistry,
						sessionManager,
					};
					let result: unknown;
					for (const handler of memory.handlers.get(event.type) ?? []) {
						result = (await handler(event, ctx)) ?? result;
					}
					return result;
				},
			} as unknown as ExtensionRunner,
		});

		const appendUser = (text: string) => {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
		};
		const appendAssistant = (turn: number, text: string) => {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `${text}\n${BULK_ANALYSIS}` }],
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
		};

		memory.appendTo(sessionManager);
		appendUser("first ask: fix the parser regression");
		appendAssistant(0, "analysis of turn zero");
		appendUser(`${PASTE_PREFIX}${PASTE}`);
		appendAssistant(1, "analysis of the pasted module");
		appendUser("follow-up: which entry point regressed?");
		appendAssistant(2, "analysis of turn two");
		return sessionManager;
	}

	function committedSummary(sessionManager: SessionManager): string {
		const entry = sessionManager.getBranch().find(candidate => candidate.type === "compaction");
		return entry?.type === "compaction" ? entry.summary : "";
	}

	function injectedSummary(): string {
		return (
			session.agent.state.messages
				.map(message => textOf(convertMessageToLlm(message)))
				.find(text => text.includes("<summary>")) ?? ""
		);
	}

	it("retains folded user messages verbatim and elides the paste with a recall pointer", async () => {
		const memory = await loadMemoryExtension();
		const sessionManager = seedSession(memory);
		await session.reload();

		const result = await session.compact();
		const summary = committedSummary(sessionManager);
		const elidedText = `${PASTE_PREFIX}${PASTE}`.trim();

		expect(summary).toContain("[User Messages]");
		expect(summary).toContain("- [#0] first ask: fix the parser regression");
		expect(summary).toContain("- [#2] please port this module:");
		expect(summary).toContain(`[paste: ${elidedText.length} chars / ${elidedText.split("\n").length} lines elided`);
		expect(summary).toContain("recall #2 for the full text");
		// wrapLongLines may break the note across lines; collapse whitespace before matching.
		expect(summary.replace(/\s+/g, " ")).toContain(
			"Large pasted user content is elided in [User Messages] with its size and its `#N` entry pointer",
		);
		// The retention section elides the paste entirely; the pre-existing brief transcript keeps
		// only its capped head, and the full payload never re-enters the context.
		const sectionStart = summary.indexOf("[User Messages]");
		const userSection = summary.slice(sectionStart, summary.indexOf("\n\n---", sectionStart));
		expect(userSection).not.toContain("PASTE_PAYLOAD_LINE");
		expect(summary).not.toContain(PASTE.slice(0, 500));
		expect(summary).toContain("<self-summary>");
		expect(summary).toContain(SELF_NOTE);
		expect(result.summary).toBe(summary);

		const injected = injectedSummary();
		expect(injected).toContain("- [#0] first ask: fix the parser regression");
		const injectedSectionStart = injected.indexOf("[User Messages]");
		const injectedUserSection = injected.slice(
			injectedSectionStart,
			injected.indexOf("\n\n---", injectedSectionStart),
		);
		expect(injectedUserSection).not.toContain("PASTE_PAYLOAD_LINE");
		expect(injected).not.toContain(PASTE.slice(0, 500));
	});

	it("emits a pointer that resolves against the session history", async () => {
		const memory = await loadMemoryExtension();
		const sessionManager = seedSession(memory);
		await session.reload();
		await session.compact();

		const summary = committedSummary(sessionManager);
		const pointer = summary.match(/- \[#(\d+)\] please port this module/)?.[1];
		if (!pointer) throw new Error("paste entry has no recall pointer in the committed summary");

		// Entry #N counts message entries from the session start; the paste is the third message
		// entry (user, assistant, user), so the pointer must resolve to index 2.
		expect(pointer).toBe("2");
		const messageEntries = sessionManager.getBranch().filter(entry => entry.type === "message" && "message" in entry);
		const pasteEntry = messageEntries.at(Number(pointer));
		if (!pasteEntry) throw new Error("recall pointer did not resolve to a message entry");
		expect(textOf(convertMessageToLlm(pasteEntry.message))).toContain("please port this module");
	});

	it("keeps the newest dropped answer on screen as a display-only copy", async () => {
		const memory = await loadMemoryExtension();
		const sessionManager = seedSession(memory);
		await session.reload();

		await session.compact();

		const copy = sessionManager
			.getBranch()
			.find(entry => entry.type === "custom" && entry.customType === PRE_COMPACTION_OUTPUT_TYPE);
		expect(copy?.type).toBe("custom");
		const data = (copy as { data: { text: string; sourceEntryId: string; truncated: boolean } }).data;
		// The newest answer the cut dropped — turn two survives in the retained tail, so the copy is
		// the turn before it, and it names the entry it came from.
		expect(data.text).toContain("analysis of the pasted module");
		// These turns run past the copy's 16 KiB cap, so the copy is bounded and says so.
		expect(data.truncated).toBe(true);
		expect(Buffer.byteLength(data.text, "utf8")).toBeLessThanOrEqual(16 * 1024);
		const source = sessionManager.getBranch().find(entry => entry.id === data.sourceEntryId);
		expect(source?.type).toBe("message");

		// Display only: the copy reaches the transcript but never the provider context.
		const transcript = session.buildTranscriptSessionContext().messages;
		const shown = transcript.find(
			message => message.role === "custom" && message.customType === PRE_COMPACTION_OUTPUT_TYPE,
		);
		expect(shown).toBeDefined();
		expect((shown as { details: { text: string } }).details.text).toBe(data.text);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === PRE_COMPACTION_OUTPUT_TYPE,
			),
		).toBe(false);
	});
});
