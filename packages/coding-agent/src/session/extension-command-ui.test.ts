import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { bindPreparedExtensions } from "../extensibility/extensions/loader";
import { ExtensionRunner } from "../extensibility/extensions/runner";
import type { ExtensionFactory, ExtensionUIContext } from "../extensibility/extensions/types";
import { initializeExtensions } from "../modes/runtime-init";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

test("manual child commands borrow caller dialogs and notifications without granting autonomous worker UI", async () => {
	const auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const registry = new ModelRegistry(auth);
	const rootManager = SessionManager.inMemory();
	rootManager.appendMessage({ role: "user", content: "Root history must remain unchanged", timestamp: 1 });
	const rootBefore = rootManager.getEntries();
	const childManager = SessionManager.inMemory();
	const observed: Array<{ id: string; hasUI: boolean; mode: string; answer: boolean }> = [];
	const background: Array<{ id: string; hasUI: boolean }> = [];
	const extension: ExtensionFactory = api => {
		api.registerCommand("manual-ui", {
			scope: "node",
			handler: async (_args, ctx) => {
				const answer = await ctx.ui.confirm("Selected node", ctx.sessionManager.getSessionId());
				observed.push({ id: ctx.sessionManager.getSessionId(), hasUI: ctx.hasUI, mode: ctx.mode, answer });
				ctx.ui.notify(`manual:${ctx.sessionManager.getSessionId()}`, "info");
				api.appendEntry("manual-ui-result", { answer, sessionId: ctx.sessionManager.getSessionId() });
			},
		});
		api.on("agent_start", async (_event, ctx) => {
			background.push({ id: ctx.sessionManager.getSessionId(), hasUI: ctx.hasUI });
			ctx.ui.notify("autonomous worker notification", "info");
		});
	};
	const loaded = await bindPreparedExtensions(
		[{ path: "manual-ui-fixture", resolvedPath: "manual-ui-fixture", factory: extension, error: null }],
		process.cwd(),
	);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		process.cwd(),
		childManager,
		registry,
		settings,
	);
	const root = new AgentSession({
		agent: new Agent(),
		sessionManager: rootManager,
		modelRegistry: registry,
		settings,
	});
	const child = new AgentSession({
		agent: new Agent(),
		sessionManager: childManager,
		modelRegistry: registry,
		settings,
		extensionRunner: runner,
	});
	const decision = Promise.withResolvers<boolean>();
	const dialogOpened = Promise.withResolvers<void>();
	const notifications: string[] = [];
	const dialogs: string[] = [];
	const callerUI: ExtensionUIContext = {
		...runner.getUIContext(),
		notify: message => {
			notifications.push(message);
		},
		confirm: async (_title, message) => {
			dialogs.push(message);
			dialogOpened.resolve();
			return decision.promise;
		},
	};
	await initializeExtensions(child, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
	});
	const command = child.prompt("/manual-ui", { extensionCommandUI: callerUI });
	try {
		await dialogOpened.promise;
		expect(dialogs).toEqual([child.sessionId]);
		await runner.emit({ type: "agent_start" });
		expect(background).toEqual([{ id: child.sessionId, hasUI: false }]);
		expect(notifications).toEqual([]);
		decision.resolve(true);
		await command;
		expect(notifications).toEqual([`manual:${child.sessionId}`]);
		expect(observed).toEqual([{ id: child.sessionId, hasUI: true, mode: "tui", answer: true }]);
		await child.prompt("/manual-ui");
		expect(observed.at(-1)).toEqual({ id: child.sessionId, hasUI: false, mode: "print", answer: false });
		expect(dialogs).toEqual([child.sessionId]);
		expect(notifications).toEqual([`manual:${child.sessionId}`]);
		expect(childManager.getCustomEntries("manual-ui-result").map(entry => entry.data)).toEqual([
			{ answer: true, sessionId: child.sessionId },
			{ answer: false, sessionId: child.sessionId },
		]);
		expect(rootManager.getEntries()).toEqual(rootBefore);
	} finally {
		decision.resolve(false);
		await command.catch(() => undefined);
		await child.dispose();
		await root.dispose();
		auth.close();
	}
});
