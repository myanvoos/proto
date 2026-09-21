import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Component } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

beforeEach(() => {
	initThemeSync();
});

test("the model picker switches the focused agent, not the main session behind it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-model-target-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"), { settings });
	const model = buildModel({
		id: "focused-model",
		name: "Focused Model",
		api: "openai-completions",
		provider: "controlled-provider",
		baseUrl: "http://127.0.0.1:9",
		contextWindow: 128_000,
		maxTokens: 4_096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as never);
	const switched: string[] = [];
	const makeSession = (label: string): AgentSession =>
		({
			model: undefined,
			modelRegistry,
			scopedModels: [{ model }],
			getContextUsage: () => ({ tokens: 0 }),
			getRoleModelCycle: () => undefined,
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: async () => {
				switched.push(label);
			},
		}) as unknown as AgentSession;

	let picker: Component | undefined;
	const editor = {} as Component;
	const ctx = {
		session: makeSession("main"),
		viewSession: makeSession("focused"),
		focusedAgentId: "Side-1",
		settings,
		editor,
		editorContainer: { children: [editor] },
		keybindings: { getKeys: () => ["alt+m"] },
		statusLine: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		showStatus: () => {},
		showError: () => {},
		ui: {
			showOverlay: (component: Component) => {
				picker = component;
				return { hide: () => {} };
			},
			setFocus: () => {},
			requestRender: () => {},
		},
	} as unknown as InteractiveModeContext;

	try {
		new SelectorController(ctx).showModelSelector({ temporaryOnly: true });
		expect(picker).toBeDefined();
		// onActivate runs the async apply; await the microtask it schedules rather than a delay.
		picker?.handleInput?.("\r");
		await Promise.resolve();
		expect(switched).toEqual(["focused"]);
	} finally {
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
