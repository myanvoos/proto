import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AgentRef } from "../../../registry/agent-registry";
import { AgentRegistry } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";
import { SessionManager } from "../../../session/session-manager";
import { SessionObserverRegistry } from "../../session-observer-registry";
import { initThemeSync } from "../../theme/theme";
import { AgentFleetOverlayComponent } from "../agent-fleet";
import { AgentsViewComponent, type AgentsViewDeps } from "./agents-view-mode";

const ANSI = /\x1b\[[0-9;]*m/g;

let listAllSpy: { mockRestore(): void } | undefined;
const mounted: Array<{ dispose(): void }> = [];

beforeEach(() => {
	initThemeSync();
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	for (const view of mounted.splice(0)) view.dispose();
	listAllSpy?.mockRestore();
	listAllSpy = undefined;
});

function fakeTui(rows = 40): TUI {
	return { terminal: { rows } } as unknown as TUI;
}

function sessionInfo(path: string, id: string, firstMessage: string, title?: string): SessionInfo {
	const now = new Date();
	return {
		path,
		id,
		cwd: "/tmp/proto-identity",
		...(title === undefined ? {} : { title }),
		created: now,
		modified: now,
		messageCount: 2,
		size: 512,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

function agentRef(path: string, id: string, displayName: string, agent = "worker"): AgentRef {
	const now = Date.now();
	return {
		id,
		displayName,
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile: path,
		createdAt: now,
		lastActivity: now,
		history: { agent },
	};
}

function renderPlain(view: { render(width: number): readonly string[] }, width = 120): string {
	return view.render(width).join("\n").replace(ANSI, "");
}

function agentsDeps(registry: AgentRegistry): AgentsViewDeps {
	return {
		ui: fakeTui(),
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		cwd: "/tmp/proto-identity",
		version: "test",
		modelName: "test-model",
		providerName: "test-provider",
		requestRender: () => {},
		close: () => {},
		openSession: async () => true,
		focusAgent: async () => {},
		newSession: () => {},
		renameCurrentSession: async () => {},
		deleteCurrentSession: async () => {},
		promptAfterResume: async () => {},
		showError: () => {},
		showStatus: () => {},
		registry,
	};
}

async function waitForRow(view: { render(width: number): readonly string[] }, text: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (renderPlain(view).includes(text)) return;
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for rendered row containing ${text}`);
}

describe("subagent identity rendering", () => {
	test("AgentsView renders the task and stable id instead of a generic worker label", async () => {
		const genericPath = "/tmp/proto-identity/worker-123.jsonl";
		const namedPath = "/tmp/proto-identity/worker-456.jsonl";
		const generic = agentRef(genericPath, "worker-123", "worker");
		const named = agentRef(namedPath, "worker-456", "AuditLabel");
		const registry = new AgentRegistry();
		registry.register(generic);
		registry.register(named);
		listAllSpy = spyOn(SessionManager, "listAll").mockResolvedValue([
			sessionInfo(genericPath, "generic-session", "Fix parser edge cases"),
			sessionInfo(namedPath, "named-session", "Audit the API boundary"),
		]);

		const view = new AgentsViewComponent(agentsDeps(registry));
		mounted.push(view);
		await waitForRow(view, "Fix parser edge cases");

		const output = renderPlain(view);
		expect(output).toContain("Fix parser edge cases");
		expect(output).toContain("worker-123");
		expect(output).toContain("AuditLabel");
		expect(output).toContain("worker-456");
		expect(output).not.toContain("worker ·");
	});

	test("Agent Fleet keeps the persisted label beside its immutable worker id", () => {
		const parentFile = "/tmp/proto-identity/session.jsonl";
		const childPath = "/tmp/proto-identity/session/worker-789.jsonl";
		const registry = new AgentRegistry();
		registry.register(agentRef(childPath, "worker-789", "ReviewLabel"));
		const fleet = new AgentFleetOverlayComponent({
			observers: new SessionObserverRegistry(),
			fleetKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry,
			sessionFile: parentFile,
			ui: fakeTui(),
		});
		mounted.push(fleet);

		const output = renderPlain(fleet);
		expect(output).toContain("worker-789");
		expect(output).toContain("ReviewLabel");
	});
});
