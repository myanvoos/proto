import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";

/**
 * Defends the contract that `agent()` calls inside an eval cell surface as a
 */
describe("eval renderer: agent() progress below the cell block", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function render(statusEvents: EvalStatusEvent[], status: "running" | "complete" = "running"): string[] {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [
				{
					index: 0,
					title: "Investigate",
					code: "results = parallel([...])",
					language: "python",
					output: "",
					status,
					statusEvents,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: status === "running", spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n")).split("\n");
	}

	function splitAtAgentTree(lines: string[]): number {
		return lines.findIndex(line => line.startsWith(theme.tree.branch) || line.startsWith(theme.tree.last));
	}

	it("draws a running subagent below the cell block with its current tool and intent", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "worker",
			status: "running",
			currentTool: "read",
			currentToolArgs: "config.ts",
			lastIntent: "Reading config",
			taskPreview: "investigate the bug",
			toolCount: 4,
			contextTokens: 5000,
			contextWindow: 200000,
			cost: 0.03,
			durationMs: 800,
			model: "p/model",
		};

		const lines = render([event]);
		const split = splitAtAgentTree(lines);
		expect(split).toBeGreaterThan(0);

		const below = lines.slice(split).join("\n");
		const inside = lines.slice(0, split).join("\n");
		expect(below).toContain("0-Scout");
		expect(below).toContain("read");
		expect(below).toContain("Reading config");
		expect(inside).not.toContain("0-Scout");
		expect(inside).not.toContain("Reading config");
	});

	it("keeps full stats on a completed subagent below the cell block", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "worker",
			status: "completed",
			toolCount: 7,
			contextTokens: 8000,
			contextWindow: 200000,
			cost: 0.06,
			durationMs: 1500,
			model: "p/model",
		};

		const lines = render([event], "complete");
		const split = splitAtAgentTree(lines);
		expect(split).toBeGreaterThanOrEqual(0);
		const below = lines.slice(split).join("\n");

		// Cost stat survives the completed snapshot.
		expect(below).toContain("$0.06");
	});

	it("renders one line per subagent for a parallel fan-out", () => {
		const events: EvalStatusEvent[] = [
			{ op: "agent", id: "0-Alpha", agent: "worker", status: "running", lastIntent: "scanning" },
			{ op: "agent", id: "1-Beta", agent: "worker", status: "completed", toolCount: 3, durationMs: 900 },
			{ op: "agent", id: "2-Gamma", agent: "worker", status: "running", currentTool: "search" },
		];

		const lines = render(events);
		const below = lines.slice(splitAtAgentTree(lines)).join("\n");
		expect(below).toContain("0-Alpha");
		expect(below).toContain("1-Beta");
		expect(below).toContain("2-Gamma");
	});

	it("still folds non-agent status events into the cell block status rows", () => {
		const events: EvalStatusEvent[] = [
			{ op: "read", path: "/tmp/file.ts", chars: 1200 },
			{ op: "agent", id: "0-Scout", agent: "worker", status: "running", lastIntent: "thinking" },
		];

		const lines = render(events);
		const split = splitAtAgentTree(lines);
		const inside = lines.slice(0, split).join("\n");
		const below = lines.slice(split).join("\n");

		expect(inside).toContain("read");
		expect(inside).toContain("file.ts");
		expect(inside).not.toContain("0-Scout");
		expect(below).toContain("0-Scout");
	});
});
