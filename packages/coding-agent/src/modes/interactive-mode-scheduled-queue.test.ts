import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { executeBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { InteractiveMode } from "./interactive-mode";
import { initTheme } from "./theme/theme";

describe("/queue with a delay", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@omp-scheduled-queue-");
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
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.scheduledQueue.dispose();
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
		tempDir.removeSync();
	});

	function pendingRows(): string[] {
		return mode.pendingMessagesContainer
			.render(100)
			.map(row => Bun.stripANSI(row).trim())
			.filter(row => row.length > 0);
	}

	it("shows a countdown row for a delayed message and drops it once cancelled", async () => {
		expect(await executeBuiltinSlashCommand("/queue 3h run the benchmarks", { ctx: mode })).toBe(true);

		const rows = pendingRows();
		expect(rows[0]).toBe("Scheduled · 1");
		expect(rows[1]).toMatch(/^1\. in 3h \(\d{1,2}:\d{2}(?:\s?[AaPp][Mm])?\) run the benchmarks$/);
		expect(mode.scheduledQueue.list()).toHaveLength(1);

		expect(await executeBuiltinSlashCommand("/queue --cancel 1", { ctx: mode })).toBe(true);
		expect(mode.scheduledQueue.list()).toHaveLength(0);
		expect(pendingRows()).toEqual([]);
	});
});
