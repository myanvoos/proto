import { StatusLineComponent } from "../../modes/components/status-line";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import type { GalleryFixture, GalleryFixtureState } from "./types";

const GAUGE_WINDOW = 200_000;

const GAUGE_CASES: Record<GalleryFixtureState, { tokens: number; note: string }> = {
	streaming: { tokens: 6_000, note: "3% used — fresh session" },
	progress: { tokens: 124_000, note: "62% used — warning zone" },
	success: { tokens: 194_000, note: "97% used — past compaction threshold" },
	error: { tokens: 240_000, note: "120% used — overflow: the gauge clamps, the percent reports raw" },
};

function fakeGaugeSession(tokens: number): AgentSession {
	const model = { id: "test-model", contextWindow: GAUGE_WINDOW };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: undefined,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "gallery",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getContextUsage: () => ({ tokens, contextWindow: GAUGE_WINDOW, percent: (tokens / GAUGE_WINDOW) * 100 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function renderFootlineVariant(tokens: number, width: number): string {
	const component = new StatusLineComponent(fakeGaugeSession(tokens));
	component.updateSettings({
		leftSegments: ["model", "mode", "path", "git", "context_pct"],
		rightSegments: ["session_name"],
	});
	try {
		return component.renderQuietLine(width, { previewTitle: "gallery" }) ?? "";
	} finally {
		component.dispose();
	}
}

function renderContextGaugeState(state: GalleryFixtureState, width: number): readonly string[] {
	const { tokens, note } = GAUGE_CASES[state];
	return [theme.fg("dim", `  ${note}`), renderFootlineVariant(tokens, width)];
}

export const statusLineFixtures: Record<string, GalleryFixture> = {
	context_gauge: {
		label: "Context Gauge",
		renderState: renderContextGaugeState,
		args: { note: "composer footline context gauge preview" },
		result: { content: [{ type: "text", text: "Rendered footline context gauges." }] },
	},
};
