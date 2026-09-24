import { expect, test } from "bun:test";
import type { EvalCellResult, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import { createTheme, getBuiltinThemes } from "../modes/theme/loader";
import { initThemeSync, theme } from "../modes/theme/theme";
import { capEventDiff, generateDiffString } from "../utils/diff";
import { EVAL_DEFAULT_PREVIEW_LINES, evalToolRenderer, renderKernelCellLines } from "./eval-render";
import { truncateToWidth } from "./render-utils";

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
	return { op: "write", path, chars: after.length, sha: "0", diff: generateDiffString(before, after, 2).diff };
}

function withTerminalRows(rows: number, run: () => void): void {
	const original = process.stdout.rows;
	process.stdout.rows = rows;
	try {
		run();
	} finally {
		if (original === undefined) {
			delete (process.stdout as { rows?: number }).rows;
		} else {
			process.stdout.rows = original;
		}
	}
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

test("file event diffs render every hunk even in the collapsed transcript", () => {
	const big = (seed: string) => `${Array.from({ length: 60 }, (_, i) => `${seed} line ${i}`).join("\n")}\n`;
	const events = [1, 2, 3].map(n => diffEvent(FILE.replace("x.py", `f${n}.py`), big("old"), big("new")));
	const lines = render(events, { expanded: false });
	const diffRows = lines.filter(line => /[+-]\s*\d+│/.test(line));
	const expectedRows = events.reduce(
		(sum, event) =>
			sum +
			String(event.diff ?? "")
				.split("\n")
				.filter((row: string) => /^[+-]\d+\|/.test(row)).length,
		0,
	);
	expect(diffRows.length, "every hunk row of every file event is rendered").toBe(expectedRows);
	expect(lines.some(line => line.includes("earlier"))).toBe(false);
	for (const n of [1, 2, 3]) {
		expect(
			lines.some(line => line.includes(`f${n}.py`)),
			`f${n}.py rendered`,
		).toBe(true);
	}
	expect(
		lines.some(line => line.includes("expand")),
		"no collapse hint for file-op diffs",
	).toBe(false);
});

test("collapsed status keeps file events visible even when they fall outside the event window", () => {
	const big = (seed: string) => `${Array.from({ length: 60 }, (_, i) => `${seed} line ${i}`).join("\n")}\n`;
	const events: EvalStatusEvent[] = [];
	for (let i = 0; i < 5; i++) {
		events.push({ op: "log", message: `step ${i}` });
		events.push(diffEvent(FILE.replace("x.py", `f${i}.py`), big("old"), big("new")));
	}
	const lines = render(events, { expanded: false });
	for (let i = 0; i < 5; i++) {
		expect(
			lines.some(line => line.includes(`f${i}.py`)),
			`f${i}.py rendered`,
		).toBe(true);
	}
	expect(lines.some(line => line.includes("2 earlier"))).toBe(true);
	for (const i of [2, 3, 4]) {
		expect(
			lines.some(line => line.includes(`step ${i}`)),
			`step ${i} rendered`,
		).toBe(true);
	}
	for (const i of [0, 1]) {
		expect(
			lines.some(line => line.includes(`step ${i}`)),
			`step ${i} hidden`,
		).toBe(false);
	}
});

function renderCells(cells: EvalToolDetails["cells"], options: { expanded: boolean; isPartial: boolean }): string[] {
	const details: EvalToolDetails = { language: "python", cells };
	const component = evalToolRenderer.renderResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded: options.expanded, isPartial: options.isPartial },
		theme,
	);
	return component.render(WIDTH).map(strip);
}

test("a streaming cell renders delivered hunks as completely as the settled cell", () => {
	const big = (seed: string) => `${Array.from({ length: 60 }, (_, i) => `${seed} line ${i}`).join("\n")}\n`;
	const cells: EvalToolDetails["cells"] = [
		{
			index: 0,
			title: "cell",
			code: "pass",
			language: "python",
			output: "running…",
			status: "running",
			statusEvents: [diffEvent(FILE, big("old"), big("new"))],
		},
	];
	withTerminalRows(12, () => {
		const partial = renderCells(cells, { expanded: false, isPartial: true });
		const settled = renderCells(
			cells.map(cell => ({ ...cell, status: "complete" as const, durationMs: 5 })),
			{ expanded: false, isPartial: false },
		);
		const diffRows = (lines: string[]) => lines.filter(line => /[+-]\s*\d+│/.test(line));
		expect(diffRows(partial).length, "hunk rows render while streaming").toBeGreaterThan(0);
		expect(diffRows(partial)).toEqual(diffRows(settled));
		expect(partial.some(line => line.includes("earlier diff line"))).toBe(false);
	});
});

test("ctrl+o expands a cell while it still streams", () => {
	const code = Array.from({ length: 80 }, (_, i) => `x${i} = ${i}`).join("\n");
	const jsonOutputs = [Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key${i}`, i]))];
	const cell: EvalCellResult = { index: 0, title: "cell", code, language: "python", output: "…", status: "running" };
	const lines = renderKernelCellLines(cell, jsonOutputs, theme, {
		expanded: true,
		isPartial: true,
		previewLines: EVAL_DEFAULT_PREVIEW_LINES,
		width: WIDTH,
	}).map(strip);
	expect(lines.some(line => line.includes("x0 = 0"))).toBe(true);
	expect(lines.some(line => line.includes("x79 = 79"))).toBe(true);
	expect(lines.some(line => line.includes("earlier lines"))).toBe(false);
	expect(lines.filter(line => /key\d+/.test(line)).length).toBe(300);
});

test("ctrl+o expands a call whose arguments still stream", () => {
	const code = Array.from({ length: 80 }, (_, i) => `x${i} = ${i}`).join("\n");
	const component = evalToolRenderer.renderCall(
		{ code, language: "python" },
		{ expanded: true, isPartial: true, spinnerFrame: 0 },
		theme,
	);
	const lines = component.render(WIDTH).map(strip);
	expect(lines.some(line => line.includes("x0 = 0"))).toBe(true);
	expect(lines.some(line => line.includes("x79 = 79"))).toBe(true);
	expect(lines.some(line => line.includes("earlier lines"))).toBe(false);
});

test("status events render under their own label even when the cell has no output", () => {
	const lines = render([{ op: "log", message: "hello" }], { expanded: false, output: "" });
	expect(lines.some(line => /(^|\s)Status$/.test(line))).toBe(true);
	expect(lines.some(line => /(^|\s)Output$/.test(line))).toBe(false);
	expect(lines.some(line => line.includes("hello"))).toBe(true);
});

test("timeout outcome follows output without leaking execution diagnostics", () => {
	const component = evalToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "all checks passed" }],
			details: {
				execution: {
					state: "unknown",
					collector: { state: "failed", error: "summary unavailable" },
					output: { disposition: "unavailable" },
					elapsedMs: 300000,
					timeout: { cause: "deadline", scope: "pipeline", effectiveMs: 300000 },
				},
			},
		},
		{ expanded: true, isPartial: false },
		theme,
	);
	const lines = component.render(WIDTH).map(strip);
	const outputLine = lines.findIndex(line => line.includes("all checks passed"));
	expect(outputLine).toBeGreaterThanOrEqual(0);
	// Execution footers were removed entirely: no timing, no timeout prose.
	expect(lines.join("\n")).not.toMatch(/Execution:|collector=|renderer=|output=|Timeout:|timed out|300000|5m/);
});

for (const [language, code] of [
	["python", 'PAYLOAD = <<END_PAYLOAD\n  first: keep(x,y)\n\n    second line\nEND_PAYLOAD\nprint("unfinished'],
	["js", "const payload = `\n  first: keep(x,y)\n\n    second line\n${unfinished("],
] as const) {
	test(`live ${language} previews preserve incomplete payload source lines`, () => {
		withTerminalRows(80, () => {
			for (const expanded of [false, true]) {
				const call = evalToolRenderer.renderCall({ language, code }, { expanded, isPartial: true }, theme);
				const lines = call.render(100).map(strip);
				expect(lines.join("\n")).not.toContain("· ast");
				const start = lines.findIndex(line => line.includes(code.split("\n")[0]!));
				expect(start).toBeGreaterThanOrEqual(0);
				for (const [index, sourceLine] of code.split("\n").entries()) {
					expect(lines[start + index]).toContain(sourceLine);
				}
				for (const [isPartial, status] of [
					[true, "complete"],
					[true, "running"],
					[false, "running"],
					[false, "pending"],
				] as const) {
					const result = renderCells([{ index: 0, code, language, output: "", status }], { expanded, isPartial });
					expect(result.join("\n")).not.toContain("· ast");
					for (const sourceLine of code.split("\n").filter(Boolean)) {
						expect(result.some(line => line.includes(sourceLine))).toBe(true);
					}
				}
			}
		});
	});
}

test("settled collapsed cells retain outlines while expanded cells show source", () => {
	const cells: EvalToolDetails["cells"] = [
		{ index: 0, code: "def greet(name):\n    return name", language: "python", output: "", status: "complete" },
	];
	expect(renderCells(cells, { expanded: false, isPartial: false }).join("\n")).toContain("· ast");
	const expanded = renderCells(cells, { expanded: true, isPartial: false }).join("\n");
	expect(expanded).not.toContain("· ast");
	expect(expanded).toContain("def greet(name):");
});

test("multiline status errors are sanitized, indented, and preview-limited", () => {
	const error = Array.from({ length: 120 }, (_, index) => `line-${index}\t\x07\x1b[31m`).join("\n");
	const component = evalToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "" }],
			details: {
				statusEvents: [{ op: "write", path: FILE, chars: 0, sha: "0", error }],
			},
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	const lines = component.render(80).map(strip);
	const output = lines.join("\n");
	expect(lines.length).toBeLessThan(10);
	expect(output).not.toContain("\t");
	expect(output).not.toContain("\x07");
	expect(output).not.toContain("\x1b[31m");
	expect(output).toContain("… 117 more lines");
	expect(lines.some(line => line.includes("line-1") && /^\s+/.test(line))).toBe(true);
	expect(lines.filter(line => line.includes("line-1")).length).toBe(1);
});

test("cached hunk rows follow the current supplied theme", () => {
	const makeTheme = (removed: string, added: string) => {
		const json = structuredClone(getBuiltinThemes().dark);
		json.colors = { ...json.colors, toolDiffRemoved: removed, toolDiffAdded: added };
		return createTheme(json, { mode: "256color" });
	};
	const firstTheme = makeTheme("#ff0000", "#00ff00");
	const secondTheme = makeTheme("#0000ff", "#ffff00");
	const event: EvalStatusEvent = {
		op: "write",
		path: FILE,
		chars: 4,
		sha: "0",
		diff: generateDiffString("old\n", "new\n", 0).diff,
	};
	const cell: EvalCellResult = {
		index: 0,
		title: "cell",
		code: "pass",
		language: "python",
		output: "",
		status: "complete",
		durationMs: 1,
		statusEvents: [event],
	};
	const first = renderKernelCellLines(cell, [], firstTheme, {
		expanded: true,
		isPartial: false,
		previewLines: 10,
		width: 80,
	});
	const second = renderKernelCellLines(cell, [], secondTheme, {
		expanded: true,
		isPartial: false,
		previewLines: 10,
		width: 80,
	});
	const firstDiff = first.filter(line => line.includes("old") || line.includes("new")).join("\n");
	const secondDiff = second.filter(line => line.includes("old") || line.includes("new")).join("\n");
	expect(firstDiff).toContain(firstTheme.getFgAnsi("toolDiffRemoved"));
	expect(secondDiff).toContain(secondTheme.getFgAnsi("toolDiffRemoved"));
	expect(secondDiff).not.toContain(firstTheme.getFgAnsi("toolDiffRemoved"));
});

test("a retained eval JSON result reflows its values when the terminal narrows and widens", () => {
	const value = "request-id-1234567890";
	const component = evalToolRenderer.renderResult(
		{ content: [], details: { jsonOutputs: [{ id: value }] } },
		{ expanded: true, isPartial: false },
		theme,
	);
	const visible = (width: number) => component.render(width).map(line => strip(truncateToWidth(line, width, "")));
	const wide = visible(40);
	const narrow = visible(8);
	expect(narrow.join("").replaceAll(" ", "")).toContain(value);
	expect(narrow.length).toBeGreaterThan(wide.length);
	expect(visible(40)).toEqual(wide);
});

test("the elision notice renders on the card rail, not loose under it", () => {
	const details: EvalToolDetails = {
		language: "python",
		notice: "Showing lines 1-196 and 29808-30002 of 30002; 29,611 middle lines (3.7MB) elided",
		cells: [
			{
				index: 0,
				title: "cell",
				code: "for i in range(30002):\\n    print(i)",
				language: "python",
				output: "0\\n1\\n2",
				status: "complete",
				durationMs: 12,
			},
		],
	};
	const component = evalToolRenderer.renderResult(
		{ content: [{ type: "text", text: "0\\n1\\n2" }], details },
		{ expanded: false, isPartial: false },
		theme,
	);
	const lines = component.render(72).map(strip);
	const rail = theme.symbol("block.rail");
	const first = lines.findIndex(line => line.includes("Showing lines 1-196"));
	const last = lines.findLastIndex(line => line.includes("elided"));

	expect(first).toBeGreaterThanOrEqual(0);
	expect(last).toBeGreaterThanOrEqual(first);
	// Every row of the notice, including its wrapped continuation, sits on the rail.
	for (const row of lines.slice(first, last + 1)) expect(row.startsWith(rail)).toBe(true);
	// And it stays inside the card: no un-railed row may follow it.
	for (const row of lines.slice(last + 1)) expect(row.trim()).toBe("");
});

test("a capped whole-file rewrite renders as a rewrite in the tool card", () => {
	const before = Array.from({ length: 1200 }, (_, index) => `before${index} = ${index}`).join("\n");
	const after = Array.from({ length: 1200 }, (_, index) => `after${index} = ${index * 2}`).join("\n");
	const capped = capEventDiff(before, after);
	const event: EvalStatusEvent = {
		op: "write",
		path: FILE,
		chars: after.length,
		sha: "0",
		diff: capped?.diff,
		diffTruncated: capped?.diffTruncated,
	};

	const lines = render([event], { expanded: true });

	expect(
		lines.some(line => /\+\s*\d+│/.test(line)),
		"the card shows added lines",
	).toBe(true);
	expect(
		lines.some(line => /-\s*\d+│/.test(line)),
		"the card shows removed lines",
	).toBe(true);
	expect(
		lines.some(line => line.includes("diff lines omitted")),
		"the elision is disclosed inline",
	).toBe(true);
	expect(
		lines.some(line => line.includes("… diff truncated")),
		"the card keeps its truncation footer",
	).toBe(true);
	// One event can no longer bury the transcript under thousands of rows.
	expect(lines.length).toBeLessThanOrEqual(410);
});
