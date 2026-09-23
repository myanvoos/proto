import { afterEach, expect, it, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
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

// Two empty error attempts in the same millisecond share a persistence key and compare equal by content; the terminal
// "Retry budget exhausted" turn — the only record of why the run stopped — was deduplicated away.
it("persists the terminal retry-budget error even when it collides with the attempt error's timestamp", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (streamModel, context, options) => {
			mock.push({ throw: "overloaded_error: provider returned error 503" });
			return mock.stream(streamModel, context, options);
		},
	});
	const sessionManager = SessionManager.inMemory();
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 0, "retry.maxRetries": 1 }),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
	});
	spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

	await session.prompt("go");
	await session.waitForIdle();

	const errors = sessionManager
		.getBranch()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message.errorMessage] : [],
		);
	expect(errors).toEqual([
		"overloaded_error: provider returned error 503",
		"Retry budget exhausted after 1 retry: overloaded_error: provider returned error 503",
	]);
});
