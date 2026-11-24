import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { createMockModel, type MockHandler, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type {
	AgentSideConnection,
	CreateElicitationResponse,
	PromptResponse,
	SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import { AcpAgent, createAcpExtensionUiContext } from "./acp-agent";

const PROVIDER = "acp-turn-fixture";

type Wire = { kind: "update"; notification: SessionNotification } | { kind: "answer"; label: string };

interface Harness {
	acp: AcpAgent;
	session: AgentSession;
	sessionId: string;
	provider: MockModel;
	wire: Wire[];
	prompt(text: string, label?: string): Promise<PromptResponse>;
	updates(kind?: string): SessionNotification["update"][];
	dispose(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.dispose();
});

/**
 * Replies in order. A call made after its turn was aborted fails as aborted without using a reply, as a real
 * provider rejects an aborted request.
 */
function scripted(replies: MockHandler[]): MockHandler {
	const queue = [...replies];
	return (context, options): MockResponse | Promise<MockResponse> => {
		if (options?.signal?.aborted) return { stopReason: "aborted", errorMessage: "Request was aborted" };
		const next = queue.shift();
		if (!next) throw new Error("No scripted reply left");
		return typeof next === "function" ? next(context, options) : next;
	};
}

async function createHarness(options: { responses: MockHandler[]; tools?: CustomTool[] }): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-turn-"));
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey(PROVIDER, "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"checklist.enabled": false,
		"retry.enabled": false,
	});
	const provider = createMockModel({ handler: scripted(options.responses) });
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage: auth,
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml"), { settings }),
		sessionManager: SessionManager.inMemory(dir),
		// Calls go through `streamFn`; the unroutable base URL keeps any side request (a title) off the network.
		model: buildModel({
			id: "deterministic",
			name: "Deterministic ACP turn model",
			api: "openai-completions",
			provider: PROVIDER,
			baseUrl: "http://127.0.0.1:9",
			reasoning: false,
			input: ["text"],
			contextWindow: 32_000,
			maxTokens: 2_048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		streamFn: provider.stream,
		toolNames: [],
		customTools: options.tools ?? [],
		enableMCP: false,
		enableIrc: false,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	const wire: Wire[] = [];
	const connection = {
		signal: new AbortController().signal,
		sessionUpdate: async (notification: SessionNotification) => {
			wire.push({ kind: "update", notification: structuredClone(notification) });
		},
		extNotification: async () => {},
	} as unknown as AgentSideConnection;
	const acp = new AcpAgent(connection, async () => session);
	await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await acp.newSession({ cwd: dir, mcpServers: [] });
	const harness: Harness = {
		acp,
		session,
		sessionId,
		provider,
		wire,
		prompt: (text, label = text) =>
			acp.prompt({ sessionId, prompt: [{ type: "text", text }] }).finally(() => {
				wire.push({ kind: "answer", label });
			}),
		updates: kind =>
			wire.flatMap(entry =>
				entry.kind === "update" && (kind === undefined || entry.notification.update.sessionUpdate === kind)
					? [entry.notification.update]
					: [],
			),
		dispose: async () => {
			await acp.dispose();
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
	harnesses.push(harness);
	return harness;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

function messageText(harness: Harness): string {
	return harness
		.updates("agent_message_chunk")
		.map(update =>
			update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "",
		)
		.join("");
}

const TURN_CONTENT = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

function answerIndex(harness: Harness, label: string): number {
	return harness.wire.findIndex(entry => entry.kind === "answer" && entry.label === label);
}

function toolCall(name: string): MockHandler {
	return { content: [{ type: "toolCall", id: `call-${name}`, name, arguments: {} }] };
}

/** A tool that runs until its abort signal fires. */
const waitingTool: CustomTool = {
	name: "wait_for_abort",
	label: "Wait for abort",
	description: "Runs until the turn is cancelled.",
	parameters: type({}),
	execute: async (_id, _params, _update, _ctx, signal) => {
		const aborted = Promise.withResolvers<void>();
		if (signal?.aborted) aborted.resolve();
		signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
		throw new Error("wait_for_abort was cancelled");
	},
};

test("a prompt interrupts a run no prompt owns instead of answering busy", async () => {
	const harness = await createHarness({
		responses: [{ delayMs: 30_000, content: ["background reply"] }, { content: ["client reply"] }],
	});
	// An extension's background turn: the session runs it, but no ACP prompt owns it.
	const background = harness.session.prompt("background work", { streamingBehavior: "steer" });
	await waitFor(() => harness.provider.calls.length === 1 && harness.session.isStreaming, "the background run");

	expect(await harness.prompt("client prompt")).toMatchObject({ stopReason: "end_turn" });
	expect(messageText(harness)).toBe("client reply");
	await background;
	expect(harness.session.isStreaming).toBe(false);
});

test("a turn stays open while the session continues past a failed run, and the newest run answers it", async () => {
	const release = Promise.withResolvers<void>();
	const harness = await createHarness({
		responses: [
			async () => {
				await release.promise;
				return { stopReason: "error", errorMessage: "upstream exploded" };
			},
			{ content: ["recovered"] },
			{ content: ["second answer"] },
		],
	});
	const first = harness.prompt("first");
	await waitFor(() => harness.provider.calls.length === 1, "the first model call");
	// Steering queued into the failing run continues the session after the failure's agent_end.
	expect(
		await harness.acp.extMethod("_session/steering", { sessionId: harness.sessionId, prompt: "also this" }),
	).toMatchObject({ outcome: "injected" });
	release.resolve();

	expect(await first).toMatchObject({ stopReason: "end_turn" });
	expect(harness.provider.calls.length).toBe(2);
	expect(messageText(harness)).toBe("recovered");
	expect(harness.session.isStreaming).toBe(false);
	// The session was idle when the turn was answered, so the next prompt runs instead of finding it busy.
	expect(await harness.prompt("second")).toMatchObject({ stopReason: "end_turn" });
	expect(messageText(harness)).toBe("recoveredsecond answer");
});

test("a failed run that nothing continues still answers with its error", async () => {
	const harness = await createHarness({
		responses: [{ stopReason: "error", errorMessage: "upstream exploded" }, { content: ["after the failure"] }],
	});
	await expect(harness.prompt("first")).rejects.toMatchObject({
		code: -32603,
		message: expect.stringContaining("upstream exploded"),
	});
	expect(await harness.prompt("second")).toMatchObject({ stopReason: "end_turn" });
});

test("session/cancel answers only after the work stopped, with the open tool call closed before the answer", async () => {
	const harness = await createHarness({
		responses: [toolCall("wait_for_abort"), { content: ["next turn"] }],
		tools: [waitingTool],
	});
	const answered = harness.prompt("run the tool", "cancelled turn").then(response => ({
		response,
		streamingAtAnswer: harness.session.isStreaming,
	}));
	await waitFor(() => harness.updates("tool_call").length === 1, "the tool call");

	await harness.acp.cancel({ sessionId: harness.sessionId });
	const { response, streamingAtAnswer } = await answered;
	expect(response.stopReason).toBe("cancelled");
	expect(streamingAtAnswer).toBe(false);

	const answer = answerIndex(harness, "cancelled turn");
	const closed = harness.wire.findIndex(
		entry =>
			entry.kind === "update" &&
			entry.notification.update.sessionUpdate === "tool_call_update" &&
			entry.notification.update.toolCallId === "call-wait_for_abort" &&
			(entry.notification.update.status === "failed" || entry.notification.update.status === "completed"),
	);
	expect(closed).toBeGreaterThanOrEqual(0);
	expect(closed).toBeLessThan(answer);
	await Bun.sleep(50);
	// Nothing about the cancelled turn follows its answer.
	expect(
		harness.wire
			.slice(answer + 1)
			.filter(entry => entry.kind === "update" && TURN_CONTENT.has(entry.notification.update.sessionUpdate)),
	).toEqual([]);

	expect(await harness.prompt("next")).toMatchObject({ stopReason: "end_turn" });
});

test("a cancel that overruns its budget keeps the session: the next prompt waits for the abort or fails explicitly", async () => {
	const release = Promise.withResolvers<void>();
	// Ignores its abort signal, so the session's abort waits for it.
	const stubbornTool: CustomTool = {
		name: "stubborn",
		label: "Stubborn",
		description: "Finishes only when released.",
		parameters: type({}),
		execute: async () => {
			await release.promise;
			return { content: [{ type: "text", text: "released" }] };
		},
	};
	const harness = await createHarness({
		responses: [toolCall("stubborn"), { content: ["after release"] }],
		tools: [stubbornTool],
	});
	harness.acp.setCancelCleanupTimeoutForTesting(100);
	const cancelled = harness.prompt("run the stubborn tool", "cancelled turn");
	await waitFor(() => harness.updates("tool_call").length === 1, "the tool call");

	await harness.acp.cancel({ sessionId: harness.sessionId });
	expect(await cancelled).toMatchObject({ stopReason: "cancelled" });
	// The client must not be left showing the still-running tool as live.
	const answer = answerIndex(harness, "cancelled turn");
	const closed = harness.wire.findIndex(
		entry =>
			entry.kind === "update" &&
			entry.notification.update.sessionUpdate === "tool_call_update" &&
			entry.notification.update.status === "failed",
	);
	expect(closed).toBeGreaterThanOrEqual(0);
	expect(closed).toBeLessThan(answer);

	// The session is still registered; a prompt that cannot start fails explicitly instead of "unknown session".
	await expect(harness.prompt("too early")).rejects.toMatchObject({
		code: -32603,
		data: { reason: "session_not_stopped" },
	});
	harness.acp.setCancelCleanupTimeoutForTesting(10_000);
	const next = harness.prompt("after release");
	release.resolve();
	expect(await next).toMatchObject({ stopReason: "end_turn" });
	expect(messageText(harness)).toBe("after release");
});

test("a prompt sent while a turn runs interrupts it: the running turn answers cancelled, the new one runs", async () => {
	const harness = await createHarness({
		responses: [toolCall("wait_for_abort"), { content: ["steered reply"] }],
		tools: [waitingTool],
	});
	const first = harness.prompt("first");
	await waitFor(() => harness.updates("tool_call").length === 1, "the tool call");
	const second = harness.prompt("second");
	expect(await first).toMatchObject({ stopReason: "cancelled" });
	expect(await second).toMatchObject({ stopReason: "end_turn" });
	expect(messageText(harness)).toBe("steered reply");
});

test("an abandoned elicitation withdraws its request from the client", async () => {
	const signals: (AbortSignal | undefined)[] = [];
	const pending = Promise.withResolvers<CreateElicitationResponse>();
	const connection = {
		unstable_createElicitation: (_params: unknown, options?: { signal?: AbortSignal }) => {
			signals.push(options?.signal);
			return pending.promise;
		},
	} as unknown as AgentSideConnection;
	const ui = createAcpExtensionUiContext(connection, () => "session", { elicitation: { form: {} } });
	const controller = new AbortController();
	const answer = ui.confirm("Publish?", "Publish the build?", { signal: controller.signal });
	expect(signals).toHaveLength(1);
	expect(signals[0]?.aborted).toBe(false);
	controller.abort();
	expect(await answer).toBe(false);
	// The connection sends `$/cancel_request` for an aborted request signal.
	expect(signals[0]?.aborted).toBe(true);
});
