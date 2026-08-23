import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const stripAnsi = (text: string): string => stripVTControlCharacters(text);

/** A session with a session name, a cost, and a context reading, all fixed. */
function makeSession(): AgentSession {
	return {
		messages: [],
		model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 12_000,
				output: 3_400,
				cacheRead: 48_000,
				cacheWrite: 1_200,
				totalTokens: 64_600,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 2,
				cost: 0.42,
			}),
			getSessionName: () => "parser-rewrite",
			getCwd: () => "/tmp",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

/** The footline as plain text, styling removed. */
function footline(settings: Record<string, unknown>, width = 120): string {
	const statusLine = new StatusLineComponent(makeSession());
	statusLine.updateSettings(settings as never);
	const line = statusLine.renderQuietLine(width);
	if (!line) throw new Error("no footline rendered");
	return stripAnsi(line);
}

/** The gauge's own glyph: the one part of the line that is unmistakably the gauge. */
const GAUGE = "▰";

describe("a gauge configured on the left", () => {
	it("renders after the session name in the default preset", () => {
		const line = footline({ preset: "default" });

		expect(line).toContain(GAUGE);
		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
	});

	it("renders after every standing segment, not just the session name", () => {
		const line = footline({ preset: "default" });

		for (const standing of ["gpt-5", "parser-rewrite"]) {
			expect(line.indexOf(standing), standing).toBeLessThan(line.indexOf(GAUGE));
		}
	});

	it("is the last segment on the line", () => {
		const line = footline({ preset: "default" }).trimEnd();
		const afterGauge = line.slice(line.indexOf(GAUGE));

		expect(afterGauge).not.toContain("·");
	});

	it("holds for any left-configured gauge, whatever else is on the right", () => {
		const line = footline({
			preset: "custom",
			leftSegments: ["model", "context_pct"],
			rightSegments: ["session_name"],
		});

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
	});
});

describe("a gauge configured on the right", () => {
	it("keeps the position it was given, even before the session name", () => {
		const line = footline({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: ["context_pct", "session_name"],
		});

		expect(line.indexOf(GAUGE)).toBeLessThan(line.indexOf("parser-rewrite"));
	});
});

describe("the presets that already read correctly", () => {
	it("minimal still ends with the gauge", () => {
		const line = footline({ preset: "minimal" }).trimEnd();

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
		expect(line.slice(line.indexOf(GAUGE))).not.toContain("·");
	});

	it("compact keeps cost before the gauge and the session name before both", () => {
		const line = footline({ preset: "compact" });

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf("$0.42"));
		expect(line.indexOf("$0.42")).toBeLessThan(line.indexOf(GAUGE));
	});

	it("default and minimal agree on where the gauge goes", () => {
		const isLast = (line: string) => !line.trimEnd().slice(line.indexOf(GAUGE)).includes("·");

		expect(isLast(footline({ preset: "default" }))).toBe(true);
		expect(isLast(footline({ preset: "minimal" }))).toBe(true);
	});
});
