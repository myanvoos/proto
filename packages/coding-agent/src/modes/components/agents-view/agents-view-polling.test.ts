import { expect, test, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AgentRegistry } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";
import { SessionManager } from "../../../session/session-manager";
import { initThemeSync } from "../../theme/theme";
import { AgentsViewComponent } from "./agents-view-mode";

initThemeSync();

function fakeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/tmp/proto-polling/session.jsonl",
		id: "polling",
		cwd: "/tmp/proto-polling",
		created: new Date(1000),
		modified: new Date(1000),
		messageCount: 2,
		size: 128,
		firstMessage: "polling session",
		allMessagesText: "polling session",
		...overrides,
	};
}

function fakeUi(): TUI {
	return { terminal: { rows: 40 } } as unknown as TUI;
}

test("mounted agents view polls marker-only liveness changes into a new section", async () => {
	vi.useFakeTimers();
	let view: AgentsViewComponent | undefined;
	let listedSessions = [fakeSession()];
	const listSpy = vi.spyOn(SessionManager, "listAll").mockImplementation(async () => listedSessions);
	let renderRequests = 0;
	const firstRender = Promise.withResolvers<void>();
	const deps = {
		ui: fakeUi(),
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		cwd: "/tmp/proto-polling",
		version: "test",
		modelName: undefined,
		providerName: undefined,
		requestRender: () => {
			renderRequests++;
			firstRender.resolve();
		},
		close: () => {},
		openSession: async () => false,
		focusAgent: async () => {},
		newSession: () => {},
		renameCurrentSession: async () => {},
		deleteCurrentSession: async () => {},
		promptAfterResume: async () => {},
		showError: () => {},
		showStatus: () => {},
		registry: new AgentRegistry(),
		hideSubagents: true,
	};

	try {
		view = new AgentsViewComponent(deps);
		await firstRender.promise;
		const before = view.render(100).join("\n");
		expect(before).toContain("Inactive");
		expect(before).not.toContain("Running");

		const beforePollRequests = renderRequests;
		const pollRender = Promise.withResolvers<void>();

		deps.requestRender = () => {
			renderRequests++;
			pollRender.resolve();
		};
		listedSessions = [fakeSession({ liveOpen: true, liveStreaming: true })];
		vi.advanceTimersByTime(1000);
		await pollRender.promise;

		expect(renderRequests).toBeGreaterThan(beforePollRequests);
		expect(view.render(100).join("\n")).toContain("Running");
		expect(listSpy).toHaveBeenCalledTimes(2);
	} finally {
		view?.dispose();
		listSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("uses preloaded sessions for its first refresh before polling", async () => {
	vi.useFakeTimers();
	let view: AgentsViewComponent | undefined;
	const listSpy = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
	let renderRequests = 0;
	const firstRender = Promise.withResolvers<void>();
	const deps = {
		ui: fakeUi(),
		keybindings: { getKeys: () => [] },
		currentSessionFile: null,
		initialSessions: [fakeSession({ title: "preloaded session" })],
		cwd: "/tmp/proto-polling",
		version: "test",
		modelName: undefined,
		providerName: undefined,
		requestRender: () => {
			renderRequests++;
			firstRender.resolve();
		},
		close: () => {},
		openSession: async () => false,
		focusAgent: async () => {},
		newSession: () => {},
		renameCurrentSession: async () => {},
		deleteCurrentSession: async () => {},
		promptAfterResume: async () => {},
		showError: () => {},
		showStatus: () => {},
		registry: new AgentRegistry(),
		hideSubagents: true,
	};

	try {
		view = new AgentsViewComponent(deps);
		await firstRender.promise;
		expect(view.render(100).join("\n")).toContain("preloaded session");
		expect(listSpy).not.toHaveBeenCalled();

		const pollRender = Promise.withResolvers<void>();
		deps.requestRender = () => {
			renderRequests++;
			pollRender.resolve();
		};
		vi.advanceTimersByTime(1000);
		await pollRender.promise;
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(renderRequests).toBeGreaterThan(1);
	} finally {
		view?.dispose();
		listSpy.mockRestore();
		vi.useRealTimers();
	}
});
