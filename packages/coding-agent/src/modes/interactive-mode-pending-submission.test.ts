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

describe("pending submission", () => {
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

	it("keeps input typed after Enter when the submission is accepted", () => {
		mode.editor.setText("typed after enter");
		mode.startPendingSubmission({ text: "submitted" }, { clearEditor: false });
		expect(mode.editor.getText()).toBe("typed after enter");
	});

	it("restores the cancelled draft ahead of input typed since", () => {
		mode.startPendingSubmission({ text: "submitted draft" });
		mode.editor.setText("typed later");

		expect(mode.cancelPendingSubmission()).toBe(true);

		expect(mode.editor.getText()).toBe("submitted draft\ntyped later");
	});
});
