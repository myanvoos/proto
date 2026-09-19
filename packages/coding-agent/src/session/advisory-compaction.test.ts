/**
 * Extensions request compaction on their own token schedule; the session owns when compaction is
 * worth rewriting — and therefore re-paying for — the cached prompt prefix. Before this gate the
 * built-in observational-memory extension compacted every session at its own fixed token count,
 * regardless of how much of the model's context window was actually in use.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

describe("advisory compaction requests", () => {
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession(overrides: Record<string, unknown>): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(overrides),
			modelRegistry: new ModelRegistry(authStorage!),
		});
	}

	it("declines while the session is far below its own compaction threshold", () => {
		createSession({ "compaction.enabled": true });

		expect(session.advisoryCompactionAllowed()).toBe(false);
	});

	it("defers to the requester when the session is not managing compaction itself", () => {
		createSession({ "compaction.enabled": false });

		expect(session.advisoryCompactionAllowed()).toBe(true);
	});

	it("defers to the requester when no compaction method is configured", () => {
		createSession({ "compaction.enabled": true, "compaction.methodOrder": [] });

		expect(session.advisoryCompactionAllowed()).toBe(true);
	});
});
