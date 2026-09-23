import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import type { AgentSessionEvent } from "./agent-session-events";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

// A headless caller awaits prompt() + waitForIdle() and then unsubscribes. Successful retry recovery rewrites the
// persisted attempt error before it publishes auto_retry_end, so an idle report that ignored in-flight event handlers
// let the caller detach before the recovery event arrived.
it("waitForIdle waits for retry recovery to publish auto_retry_end", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const mock = createMockModel({
		responses: [
			{ throw: "overloaded_error: provider returned error 503" },
			{ content: ["Recovered after retry."], stopReason: "stop" },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory();
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
	});
	const rewriteStarted = Promise.withResolvers<void>();
	const resumeRewrite = Promise.withResolvers<void>();
	const rewriteEntries = sessionManager.rewriteEntries.bind(sessionManager);
	vi.spyOn(sessionManager, "rewriteEntries").mockImplementation(async () => {
		rewriteStarted.resolve();
		await resumeRewrite.promise;
		await rewriteEntries();
	});
	const retryEnds: Extract<AgentSessionEvent, { type: "auto_retry_end" }>[] = [];
	const unsubscribe = session.subscribe(event => {
		if (event.type === "auto_retry_end") retryEnds.push(event);
	});
	let idle = false;
	const completion = (async () => {
		await session?.prompt("Recover from the transient failure.");
		await session?.waitForIdle();
		idle = true;
		unsubscribe();
	})();

	try {
		await Promise.race([rewriteStarted.promise, completion]);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(idle).toBe(false);
	} finally {
		resumeRewrite.resolve();
		await completion;
	}
	expect(retryEnds).toHaveLength(1);
	expect(retryEnds[0]).toMatchObject({ success: true });
});
