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
import type { ChecklistPhase } from "../tools/checklist";
import { InteractiveMode } from "./interactive-mode";
import { initTheme, theme } from "./theme/theme";

describe("InteractiveMode sticky checklist panel", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@omp-checklist-panel-");
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
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
		tempDir.removeSync();
	});

	it("labels progress in the header and closes the tree instead of trailing a bare tail", () => {
		const phases: ChecklistPhase[] = [
			{
				name: "Setup",
				tasks: [
					{ content: "task a", status: "completed" },
					{ content: "task b", status: "completed" },
				],
			},
			{
				name: "Build",
				tasks: [
					{ content: "task c", status: "in_progress" },
					{ content: "task d", status: "pending" },
				],
			},
		];
		mode.setChecklist(phases);

		const rows = mode.checklistContainer
			.render(80)
			.map(row => Bun.stripANSI(row).trim())
			.filter(row => row.length > 0);
		expect(rows[0]).toBe("Checklist · 2/4 done");
		expect(rows[1]).toStartWith(`${theme.tree.last} `);
		expect(rows.at(-1)).toMatch(/task d$/);
	});
});
