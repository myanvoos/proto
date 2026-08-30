import { expect, test } from "bun:test";
import { generateDiffString } from "../edit/diff";
import type { EvalStatusEvent, EvalToolDetails } from "../eval/types";
import { initThemeSync, theme } from "../modes/theme/theme";
import { evalToolRenderer } from "./eval-render";
import { PREVIEW_LIMITS } from "./render-utils";

initThemeSync();

const WIDTH = 56;
const FILE = "/tmp/eval-render-test/x.py";

function strip(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function render(statusEvents: EvalStatusEvent[], options: { expanded: boolean; output?: string }): string[] {
	const details: EvalToolDetails = {
		language: "python",
		cells: [
			{
				index: 0,
				title: "cell",
				code: "pass",
				language: "python",
				output: options.output ?? "done",
				status: "complete",
				durationMs: 5,
				statusEvents,
			},
		],
	};
	const component = evalToolRenderer.renderResult(
		{ content: [{ type: "text", text: options.output ?? "done" }], details },
		{ expanded: options.expanded, isPartial: false },
		theme,
	);
	return component.render(WIDTH).map(strip);
}

function diffEvent(path: string, before: string, after: string): EvalStatusEvent {
	return { op: "edit", path, chars: after.length, sha: "0", diff: generateDiffString(before, after, 2).diff };
}

test("kernel diff rows that wrap keep continuation rows under the gutter", () => {
	const before = "a = 1\nb = 2\n";
	const after = `a = 1\nb = ${"x".repeat(80)}\n`;
	const lines = render([diffEvent(FILE, before, after)], { expanded: true });
	const first = lines.findIndex(line => /\+\s*│/.test(line));
	expect(first, "wrapped diff row is rendered").toBeGreaterThan(-1);
	const separatorColumn = lines[first]!.indexOf("│");
	const continuation = lines[first + 1]!;
	expect(continuation.indexOf("│"), "continuation row keeps the gutter column").toBe(separatorColumn);
	expect(continuation.slice(0, separatorColumn), "continuation gutter carries no line number").not.toMatch(/\d/);
});

test("non-last file events keep the tree rail beside their diff rows", () => {
	const lines = render(
		[diffEvent(FILE, "a = 1\n", "a = 2\n"), diffEvent(FILE.replace("x.py", "y.py"), "b = 1\n", "b = 2\n")],
		{ expanded: true },
	);
	const firstHeader = lines.findIndex(line => line.includes("x.py"));
	const secondHeader = lines.findIndex(line => line.includes("y.py"));
	expect(firstHeader).toBeGreaterThan(-1);
	expect(secondHeader).toBeGreaterThan(firstHeader);
	for (const line of lines.slice(firstHeader + 1, secondHeader)) {
		expect(line, "rows between two events carry the vertical rail").toMatch(/^\S+\s+│/);
	}
});

test("expanded status shows every event instead of hiding earlier ones", () => {
	const events: EvalStatusEvent[] = Array.from({ length: 40 }, (_, i) => ({ op: "log", message: `step ${i}` }));
	const lines = render(events, { expanded: true });
	expect(lines.some(line => line.includes("earlier"))).toBe(false);
	for (let i = 0; i < events.length; i++) {
		expect(
			lines.some(line => line.includes(`step ${i}`)),
			`step ${i} rendered`,
		).toBe(true);
	}
	const collapsed = render(events, { expanded: false });
	expect(collapsed.some(line => line.includes("37 earlier"))).toBe(true);
});

test("collapsed status shares the diff budget across file events", () => {
	const big = (seed: string) => `${Array.from({ length: 60 }, (_, i) => `${seed} line ${i}`).join("\n")}\n`;
	const events = [1, 2, 3].map(n => diffEvent(FILE.replace("x.py", `f${n}.py`), big("old"), big("new")));
	const lines = render(events, { expanded: false });
	const diffRows = lines.filter(line => /[+-]\s*\d+│/.test(line));
	expect(diffRows.length).toBeLessThanOrEqual(PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
	expect(lines.filter(line => line.includes("more") && line.includes("expand")).length).toBe(3);
});

test("status events render under their own label even when the cell has no output", () => {
	const lines = render([{ op: "log", message: "hello" }], { expanded: false, output: "" });
	expect(lines.some(line => /(^|\s)Status$/.test(line))).toBe(true);
	expect(lines.some(line => /(^|\s)Output$/.test(line))).toBe(false);
	expect(lines.some(line => line.includes("hello"))).toBe(true);
});
