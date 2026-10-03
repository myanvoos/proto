import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { InteractiveMode } from "./interactive-mode";
import { initTheme } from "./theme/theme";

describe("extension shutdown request", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeEach(async () => {
		await initTheme();
		await Settings.init({ inMemory: true });
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
	});

	it("shuts an idle session down without waiting for terminal input", async () => {
		const shutdown = Promise.withResolvers<void>();
		vi.spyOn(mode, "shutdown").mockImplementation(async () => shutdown.resolve());

		mode.requestShutdown();

		await shutdown.promise;
		expect(mode.shutdownRequested).toBe(true);
	});

	it("leaves a foreground submission that is still being prepared to finish first", async () => {
		const shutdown = vi.spyOn(mode, "shutdown").mockImplementation(async () => {});
		const submission = mode.startPendingSubmission({ text: "hello" });

		mode.shutdownRequested = true;
		await mode.checkShutdownRequested();
		expect(shutdown).not.toHaveBeenCalled();

		mode.finishPendingSubmission(submission);
		await mode.checkShutdownRequested();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
