import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { emptyUsageStatistics } from "../../../session/session-entries";
import { initThemeSync } from "../../theme/theme";
import { StatusLineComponent } from "./component";

await Settings.init({ inMemory: true });
initThemeSync();

afterEach(() => {
	vi.restoreAllMocks();
});

const usageStatistics = emptyUsageStatistics();

function sessionWithMessages(options: {
	messages: AgentSession["messages"];
	isStreaming?: boolean;
	sessionName?: string;
	cwd?: string;
}): AgentSession {
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const state = { model, thinkingLevel: "off" } as Record<string, unknown>;
	Object.defineProperty(state, "messages", {
		configurable: true,
		get: () => options.messages,
	});
	return {
		messages: options.messages,
		state,
		model,
		isStreaming: options.isStreaming ?? false,
		sessionManager: {
			getUsageStatistics: () => usageStatistics,
			getSessionName: () => options.sessionName,
			getCwd: options.cwd === undefined ? undefined : () => options.cwd,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		settings: undefined,
	} as unknown as AgentSession;
}

describe("StatusLineComponent token rate", () => {
	test("does not read message history while token rate is hidden, and updates on settings changes", () => {
		const messages = [
			{
				role: "assistant",
				timestamp: 1_000,
				usage: { output: 100 },
				duration: 1_000,
			},
		] as AgentSession["messages"];
		let readMessages = false;
		const session = sessionWithMessages({ messages });
		Object.defineProperty(session.state, "messages", {
			configurable: true,
			get: () => {
				readMessages = true;
				throw new Error("message history should not be read");
			},
		});
		const component = new StatusLineComponent(session);
		try {
			component.updateSettings({ leftSegments: ["model"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("Test Model");
			expect(readMessages).toBe(false);

			Object.defineProperty(session.state, "messages", {
				configurable: true,
				get: () => messages,
			});
			component.updateSettings({ leftSegments: ["token_rate"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("100.0 tok/s");

			readMessages = false;
			Object.defineProperty(session.state, "messages", {
				configurable: true,
				get: () => {
					readMessages = true;
					throw new Error("message history should not be read");
				},
			});
			component.updateSettings({ leftSegments: ["model"], rightSegments: [] });
			expect(component.renderQuietLine(120)).toContain("Test Model");
			expect(readMessages).toBe(false);
		} finally {
			component.dispose();
		}
	});

	test("keeps the streaming rate current when enabled", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		const assistant = {
			role: "assistant",
			timestamp: 9_000,
			usage: { output: 100 },
		};
		const messages = [assistant] as AgentSession["messages"];
		const session = sessionWithMessages({ messages, isStreaming: true });
		const component = new StatusLineComponent(session);
		try {
			component.updateSettings({ leftSegments: [], rightSegments: ["token_rate"] });
			expect(component.renderQuietLine(120)).toContain("100.0 tok/s");

			now.mockReturnValue(11_000);
			expect(component.renderQuietLine(120)).toContain("50.0 tok/s");
		} finally {
			component.dispose();
		}
	});
});

describe("StatusLineComponent quiet line shedding", () => {
	// 61-column path + 28-column title: at 120 columns the line overflows by less than the title's slack.
	const cwd = "/srv/projects/status-line-fixtures/quiet-line/clock-and-title";
	const sessionName = "Fixing the flaky test matrix";

	function runningComponent(): StatusLineComponent {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		const component = new StatusLineComponent(sessionWithMessages({ messages: [], sessionName, cwd }));
		component.updateSettings({
			leftSegments: ["model", "time_spent", "path"],
			rightSegments: ["session_name"],
			segmentOptions: { path: { maxLength: 80 } },
		});
		component.markActivityStart();
		now.mockReturnValue(57_000);
		return component;
	}

	test("keeps the run clock at 120 columns by truncating the session title instead", () => {
		const component = runningComponent();
		try {
			const line = Bun.stripANSI(component.renderQuietLine(120) ?? "");
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
			expect(line).toContain("0:47");
			expect(line).toContain("Test Model");
			expect(line).toContain("Fixing the flaky");
			expect(line).not.toContain(sessionName);
		} finally {
			component.dispose();
		}
	});

	test("drops the run clock before the model segment once the title cannot absorb the overflow", () => {
		const component = runningComponent();
		try {
			const line = Bun.stripANSI(component.renderQuietLine(84) ?? "");
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(84);
			expect(line).not.toContain("0:47");
			expect(line).toContain("Test Model");
		} finally {
			component.dispose();
		}
	});
});

// Regression: the run clock reported every finished turn with a success check, so a hard failure
// and an interrupted turn both read "✓ 0:50" — the status line contradicted the transcript.
describe("StatusLineComponent run clock outcome", () => {
	function clockReadout(outcome: "ok" | "error" | "aborted"): string {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		const component = new StatusLineComponent(sessionWithMessages({ messages: [], cwd: "/srv/run-clock" }));
		try {
			component.updateSettings({ leftSegments: ["path"], rightSegments: [] });
			component.markActivityStart();
			now.mockReturnValue(60_000);
			component.markActivityEnd(outcome);
			return Bun.stripANSI(component.renderQuietLine(120) ?? "");
		} finally {
			component.dispose();
		}
	}

	test("a completed turn keeps the success check", () => {
		const line = clockReadout("ok");
		expect(line).toContain("✓ 0:50");
	});

	test("a failed turn is not reported as a success", () => {
		const line = clockReadout("error");
		expect(line).toContain("✗ 0:50");
		expect(line).not.toContain("✓");
	});

	test("an interrupted turn is marked as interrupted, matching the transcript", () => {
		const line = clockReadout("aborted");
		expect(line).toContain("∎ 0:50");
		expect(line).not.toContain("✓");
	});

	test("the outcome belongs to the turn that set it, and a reset clears the readout", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		const component = new StatusLineComponent(sessionWithMessages({ messages: [], cwd: "/srv/run-clock" }));
		try {
			component.updateSettings({ leftSegments: ["path"], rightSegments: [] });
			component.markActivityStart();
			now.mockReturnValue(20_000);
			component.markActivityEnd("error");
			expect(component.getRunClock().lastRunOutcome).toBe("error");

			component.markActivityStart();
			now.mockReturnValue(25_000);
			component.markActivityEnd();
			expect(component.getRunClock().lastRunOutcome).toBe("ok");
			expect(Bun.stripANSI(component.renderQuietLine(120) ?? "")).toContain("✓ 0:05");

			component.resetActiveTime();
			expect(component.getRunClock().lastRunOutcome).toBe("ok");
			expect(Bun.stripANSI(component.renderQuietLine(120) ?? "")).not.toContain("✓");
		} finally {
			component.dispose();
		}
	});
});

describe("StatusLineComponent usage segment", () => {
	async function renderUsage(provider: string, reports: unknown[], modelId?: string): Promise<string> {
		const session = sessionWithMessages({ messages: [] });
		const model = { ...session.model, provider, ...(modelId ? { id: modelId } : {}) };
		Object.assign(session, { model, fetchUsageReports: async () => reports });
		Object.assign(session.state, { model });
		const component = new StatusLineComponent(session);
		try {
			component.updateSettings({ leftSegments: [], rightSegments: ["usage"] });
			vi.useFakeTimers();
			try {
				component.refreshUsageInBackground();
				vi.advanceTimersByTime(0);
			} finally {
				vi.useRealTimers();
			}
			// setImmediate runs once the refresh's promise chain has drained.
			const drained = Promise.withResolvers<void>();
			setImmediate(drained.resolve);
			await drained.promise;
			return Bun.stripANSI(component.renderQuietLine(200) ?? "");
		} finally {
			component.dispose();
		}
	}

	test("labels untiered windows with the plan tier and classifies weekly windows by duration", async () => {
		const content = await renderUsage("zai", [
			{
				provider: "zai",
				metadata: { planType: "pro" },
				limits: [
					{ scope: { windowId: "5h" }, window: { durationMs: 5 * 3_600_000 }, amount: { usedFraction: 0.21 } },
					{ scope: { windowId: "1w" }, window: { durationMs: 7 * 86_400_000 }, amount: { usedFraction: 0.05 } },
				],
			},
		]);

		expect(content).toContain("pro");
		expect(content).toContain("5h 21%");
		expect(content).toContain("7d 5%");
	});

	test("shows the monthly bucket only for monthly-subscription providers", async () => {
		const monthlyOnly = (provider: string) => [
			{
				provider,
				limits: [{ id: "credits:monthly", scope: { windowId: "monthly" }, amount: { usedFraction: 0.429 } }],
			},
		];

		expect(await renderUsage("alibaba-token-plan", monthlyOnly("alibaba-token-plan"))).toContain("mo 42%");
		expect(await renderUsage("github-copilot", monthlyOnly("github-copilot"))).not.toContain("mo");
	});

	test("scopes Antigravity windows to the active model's backend counter", async () => {
		const counter = (counterKey: string, usedFraction: number) => ({
			id: `google-antigravity:${counterKey}:default:5h`,
			scope: { windowId: "5h" },
			window: { durationMs: 5 * 3_600_000 },
			amount: { usedFraction },
		});
		// Limits arrive sorted by pressure, so the exhausted Gemini counter comes first.
		const reports = [{ provider: "google-antigravity", limits: [counter("google", 0.9), counter("anthropic", 0.1)] }];

		expect(await renderUsage("google-antigravity", reports, "claude-opus-4-6")).toContain("5h 10%");
		expect(await renderUsage("google-antigravity", reports, "gemini-3-pro")).toContain("5h 90%");
	});
});
