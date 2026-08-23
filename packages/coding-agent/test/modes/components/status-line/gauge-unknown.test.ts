import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const stripAnsi = (text: string): string => stripVTControlCharacters(text);

interface UsageShape {
	tokens: number;
	contextWindow: number;
}

function sessionWith(usage: UsageShape | undefined) {
	return {
		messages: [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "hi" }] }],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => usage,
		state: {
			messages: [],
			model: { contextWindow: 128000 },
		},
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
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		// Compaction off: the gauge denominates against the raw model window, so the
		// percentages below are the arithmetic and nothing else.
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/** The rendered footline, ANSI stripped: what a reader actually sees. */
function line(usage: UsageShape | undefined): string {
	const statusLine = new StatusLineComponent(sessionWith(usage));
	const rendered = statusLine.renderQuietLine(200);
	return rendered === null ? "" : stripAnsi(rendered);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("a gauge never states a number it does not have", () => {
	it("says the count is unknown when the session has no anchor", () => {
		expect(line(undefined)).toContain("? left");
	});

	it("never claims a full context while the count is unknown", () => {
		const rendered = line(undefined);
		expect(rendered).not.toContain("100% left");
		expect(rendered).not.toContain("0% left");
	});

	it("keeps the unknown out of the breakdown other surfaces read", () => {
		const statusLine = new StatusLineComponent(sessionWith(undefined));
		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: null, contextWindow: 128000 });
	});

	// Zero is a real answer and must stay one: an unused session has spent no tokens,
	// and reporting that as unknown would be the same defect pointed the other way.
	it("still reports a real zero as a full context", () => {
		expect(line({ tokens: 0, contextWindow: 128000 })).toContain("100% left");
	});

	for (const [tokens, expected] of [
		[0, "100% left"],
		[12800, "90% left"],
		[64000, "50% left"],
		[128000, "0% left"],
	] as const) {
		it(`reports ${tokens} of 128000 tokens as ${expected}`, () => {
			expect(line({ tokens, contextWindow: 128000 })).toContain(expected);
		});
	}

	it("reports the anchored count once it arrives, replacing the unknown", () => {
		const statusLine = new StatusLineComponent(sessionWith(undefined));
		expect(stripAnsi(statusLine.renderQuietLine(200) ?? "")).toContain("? left");

		// A new component for the anchored session rather than mutating the first: the
		// breakdown is memoized against message identity on purpose, and this case is
		// about what a reader sees after the next response, not about cache eviction.
		const anchored = new StatusLineComponent(sessionWith({ tokens: 64000, contextWindow: 128000 }));
		expect(stripAnsi(anchored.renderQuietLine(200) ?? "")).toContain("50% left");
	});
});
