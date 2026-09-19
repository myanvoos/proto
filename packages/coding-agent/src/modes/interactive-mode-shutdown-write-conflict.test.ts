import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { InteractiveMode } from "./interactive-mode";
import { initTheme } from "./theme/theme";

describe("InteractiveMode failed teardown escape", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let quitSpy: Mock<typeof postmortem.quit>;
	let quitCalled: PromiseWithResolvers<void>;
	let exitSpy: Mock<typeof postmortem.exitProcess>;
	let showErrorSpy: Mock<typeof InteractiveMode.prototype.showError>;
	let disposeSpy: Mock<typeof session.dispose>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-shutdown-conflict-");
		await Settings.init({ inMemory: true });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};

		quitCalled = Promise.withResolvers<void>();
		quitSpy = vi.spyOn(postmortem, "quit").mockImplementation(async code => {
			if (code === 130) quitCalled.resolve();
		});
		exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		showErrorSpy = vi.spyOn(mode, "showError").mockImplementation(() => {});
		// Model a write conflict after AgentSession has entered its disposal state.
		// The real session dispose promise is memoized at this point, so retrying
		// the teardown must not invoke it again.
		disposeSpy = vi.spyOn(session, "dispose").mockImplementation(async () => {
			session.beginDispose();
			throw new Error("Session file changed before rewrite");
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
		tempDir.removeSync();
	});

	it("arms the escape after a dispose-stage write conflict", async () => {
		await mode.shutdown();

		const message = showErrorSpy.mock.calls.map(call => String(call[0])).join("\n");
		expect(message).toContain("Could not close session");
		expect(message).toContain("Press Ctrl+C again");
		expect(mode.isShuttingDown).toBe(false);
		expect(mode.teardownFailed).toBe(true);
		expect(quitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("exits with 130 on a later Ctrl-C without retrying teardown", async () => {
		await mode.shutdown();
		mode.lastSigintTime = 0;

		mode.handleCtrlC();
		await quitCalled.promise;

		expect(quitSpy).toHaveBeenCalledWith(130);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("does not rerun memoized teardown on a direct shutdown retry", async () => {
		await mode.shutdown();
		await mode.shutdown();

		expect(quitSpy).toHaveBeenCalledWith(130);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to the native exit when guarded quit rejects", async () => {
		await mode.shutdown();
		quitSpy.mockRejectedValueOnce(new Error("process.exit is guarded"));

		await mode.shutdown();

		expect(quitSpy).toHaveBeenCalledWith(130);
		expect(exitSpy).toHaveBeenCalledWith(130);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
