import { beforeEach, expect, test } from "bun:test";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Component } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import { captureSessionCommandTarget, type SessionCommandTarget } from "../../session/command-target";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { SelectorController } from "./selector-controller";

beforeEach(() => initThemeSync());

function setup(contextTokens = 0) {
	const settings = Settings.isolated();
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
	const completed = Promise.withResolvers<void>();
	const compactStarted = Promise.withResolvers<SessionCommandTarget | undefined>();
	const compactFinished = Promise.withResolvers<void>();
	const compact = Promise.withResolvers<CompactionOutcome>();
	const handleCompactCommand: InteractiveModeContext["handleCompactCommand"] = async (
		_instructions,
		_mode,
		beforeFlush,
		target,
	) => {
		compactStarted.resolve(target);
		const outcome = await compact.promise;
		await beforeFlush?.(outcome);
		compactFinished.resolve();
		return outcome;
	};
	let sessionId = "focused-session";
	const makeSession = (label: string): AgentSession =>
		({
			model: undefined,
			modelRegistry: {} as ModelRegistry, // Scoped models do not access the registry.
			scopedModels: [{ model }],
			sessionManager: {
				getSessionId: () => (label === "focused" ? sessionId : label),
				getLeafId: () => null,
			},
			get sessionId() {
				return label === "focused" ? sessionId : label;
			},
			getContextUsage: () => ({ tokens: contextTokens }),
			getRoleModelCycle: () => ({ models: [{ role: "default", model }], currentIndex: 0 }),
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: async () => {
				switched.push(`${label}:temporary`);
			},
			applyRoleModel: async () => {
				switched.push(`${label}:role`);
			},
			setModel: async () => {
				switched.push(`${label}:default`);
				return { switched: true };
			},
		}) as unknown as AgentSession;
	let menu: Component | undefined;
	let mounts = 0;
	let hides = 0;
	const errors: string[] = [];
	const editor = {} as Component;
	const focused = makeSession("focused");
	const other = makeSession("other");
	const ctx = {
		session: makeSession("main"),
		viewSession: focused,
		focusedAgentId: "Side-1",
		settings,
		editor,
		editorContainer: { children: [editor] },
		keybindings: { getKeys: () => ["alt+m"] },
		statusLine: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		showModelCycleTrack: () => {
			completed.resolve();
		},
		showStatus: () => {
			completed.resolve();
		},
		showError: (error: string) => {
			errors.push(error);
			completed.resolve();
		},
		handleCompactCommand,
		ui: {
			terminal: { rows: 24 },
			showOverlay: (component: Component) => {
				menu = component;
				mounts++;
				return {
					hide: () => {
						hides++;
					},
				};
			},
			setFocus: () => {},
			requestRender: () => {},
		},
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		settings,
		switched,
		errors,
		focused,
		other,
		completed,
		compactStarted,
		compactFinished,
		compact,
		controller: new SelectorController(ctx),
		get menu() {
			return menu;
		},
		get mounts() {
			return mounts;
		},
		get hides() {
			return hides;
		},
		changeSessionIdentity() {
			sessionId = "replacement-session";
		},
	};
}

test("the model picker switches the focused agent, not the main session behind it", async () => {
	const state = setup();
	state.controller.showModelSelector({ temporaryOnly: true });
	state.controller.showModelSelector({ temporaryOnly: true });
	expect(state.mounts).toBe(1);
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual(["focused:temporary"]);
	expect(state.errors).toEqual([]);
});

test("a model picker opened on A refuses to mutate A or B after focus moves to B", async () => {
	const state = setup();
	state.controller.showModelSelector({ temporaryOnly: true });
	Object.assign(state.ctx, { viewSession: state.other });
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual([]);
	expect(state.hides).toBe(1);
});

test("a model picker refuses a replaced session behind the same AgentSession object", async () => {
	const state = setup();
	state.controller.showModelSelector({ temporaryOnly: true });
	state.changeSessionIdentity();
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual([]);
});

test("a quick-role picker refuses a focus change instead of applying the role to B", async () => {
	const state = setup();
	state.controller.showModelSelector({ temporaryOnly: true });
	state.menu?.handleInput?.("@");
	Object.assign(state.ctx, { viewSession: state.other });
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual([]);
});

test("the model hub assigns the focused agent default without changing the root", async () => {
	const state = setup();
	state.controller.showModelSelector();
	state.menu?.handleInput?.("\r");
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual(["focused:default"]);
	expect(state.errors).toEqual([]);
	state.menu?.handleInput?.("\x1b");
	state.menu?.handleInput?.("\x1b");
});

test("a model hub opened on A refuses its default assignment after focus moves to B", async () => {
	const state = setup();
	state.controller.showModelSelector();
	state.menu?.handleInput?.("\r");
	Object.assign(state.ctx, { viewSession: state.other });
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual([]);
	expect(state.settings.getModelRole("default")).toBeUndefined();
	expect(state.hides).toBe(1);
});

test("a model hub rechecks focus after waiting for the default-role mutation lock", async () => {
	const state = setup();
	state.controller.showModelSelector();
	state.menu?.handleInput?.("\r");
	state.menu?.handleInput?.("\r");
	Object.assign(state.ctx, { viewSession: state.other });
	await state.completed.promise;
	expect(state.switched).toEqual([]);
	expect(state.settings.getModelRole("default")).toBeUndefined();
});

test("a quick-role selection still applies its model to the captured focused session", async () => {
	const state = setup();
	state.controller.showModelSelector({ temporaryOnly: true });
	state.menu?.handleInput?.("@");
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual(["focused:role"]);
	expect(state.errors).toEqual([]);
});

test("a model hub refuses a replaced session even while its AgentSession remains focused", async () => {
	const state = setup();
	state.controller.showModelSelector();
	state.menu?.handleInput?.("\r");
	state.changeSessionIdentity();
	state.menu?.handleInput?.("\r");
	await state.completed.promise;
	expect(state.switched).toEqual([]);
	expect(state.settings.getModelRole("default")).toBeUndefined();
});

test("an explicitly captured stale command target cannot open a model selector on another session", () => {
	const state = setup();
	const target = captureSessionCommandTarget(state.focused);
	Object.assign(state.ctx, { viewSession: state.other });
	state.controller.showModelSelector({ temporaryOnly: true }, target);
	expect(state.mounts).toBe(0);
	expect(state.switched).toEqual([]);
});

test("over-context model selection compacts the captured child and switches it once", async () => {
	const state = setup(130_000);
	state.controller.showModelSelector({ temporaryOnly: true });
	state.menu?.handleInput?.("\r");
	const target = await state.compactStarted.promise;
	expect(target?.session).toBe(state.focused);
	expect(state.switched).toEqual([]);
	state.compact.resolve("ok");
	await state.compactFinished.promise;
	await state.completed.promise;
	expect(state.switched).toEqual(["focused:temporary"]);
	expect(state.errors).toEqual([]);
});

test("a delayed compaction cannot switch A or B after focus changes", async () => {
	const state = setup(130_000);
	state.controller.showModelSelector({ temporaryOnly: true });
	state.menu?.handleInput?.("\r");
	await state.compactStarted.promise;
	Object.assign(state.ctx, { viewSession: state.other });
	state.compact.resolve("ok");
	await state.compactFinished.promise;
	await state.completed.promise;
	expect(state.switched).toEqual([]);
});
