import { expect, test } from "bun:test";
import type { EvalStatusEvent, EvalToolDetails } from "../eval/types";
import { initThemeSync, theme } from "../modes/theme/theme";
import { generateDiffString } from "../utils/diff";
import { evalToolRenderer } from "./eval-render";
import { previewWindowRows } from "./render-utils";

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

test("a streaming cell reveals delivered hunk bodies within the live window", () => {
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
	withTerminalRows(60, () => {
		const partial = renderCells(cells, { expanded: false, isPartial: true });
		// The hunk renders as soon as the write event is delivered — no waiting
		// for the whole call to settle — tail-truncated into the live window
		// with a marker for the hidden lines.
		const diffRows = partial.filter(line => /[+-]\s*\d+│/.test(line));
		expect(diffRows.length, "hunk rows render while streaming").toBeGreaterThan(0);
		expect(
			partial.some(line => line.includes("earlier diff line")),
			"truncation marker present",
		).toBe(true);
		// The write event still shows its summary line with ⟦+N/-M⟧ stats.
		expect(partial.some(line => line.includes("x.py"))).toBe(true);
		expect(partial.some(line => /\+\d+\/-\d+/.test(line))).toBe(true);
		// The whole live block must stay inside the streaming window (the
		// window is measured from the terminal rows, so a committed mid-stream
		// block — and the settle-time double print it causes — can't happen).
		expect(partial.length).toBeLessThanOrEqual(previewWindowRows() + 6);

		// Once the call settles, the finalized render keeps the complete diff.
		const final = renderCells(
			cells.map(cell => ({ ...cell, status: "complete" as const, durationMs: 5 })),
			{ expanded: false, isPartial: false },
		);
		const finalDiffRows = final.filter(line => /[+-]\s*\d+│/.test(line));
		expect(finalDiffRows.length).toBeGreaterThan(diffRows.length);
	});
});

test("a tiny live window degrades streaming hunks to the stats line", () => {
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
	// 12 rows → previewWindowRows() floors at 6; the reserved code/output
	// floors consume the entire budget, so no hunk row may render mid-stream
	// and the summary stats line carries the write.
	withTerminalRows(12, () => {
		const partial = renderCells(cells, { expanded: false, isPartial: true });
		expect(partial.filter(line => /[+-]\s*\d+│/.test(line)).length).toBe(0);
		expect(partial.some(line => line.includes("x.py"))).toBe(true);
		expect(partial.some(line => /\+\d+\/-\d+/.test(line))).toBe(true);
	});
});

test("ctrl+o expansion is deferred while a cell still streams", () => {
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
	withTerminalRows(60, () => {
		const lines = renderCells(cells, { expanded: true, isPartial: true });
		// Expanded live cells render like collapsed ones — windowed, with the
		// hunk tail revealed — and a note that the expansion applies on settle.
		expect(lines.filter(line => /[+-]\s*\d+│/.test(line)).length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(previewWindowRows() + 6);
		expect(lines.some(line => line.includes("expanded view once the cell settles"))).toBe(true);

		// Settling applies the same expanded toggle with no note and no cap.
		const settled = renderCells(
			cells.map(cell => ({ ...cell, status: "complete" as const, durationMs: 5 })),
			{ expanded: true, isPartial: false },
		);
		expect(settled.some(line => line.includes("expanded view once the cell settles"))).toBe(false);
		const settledDiffRows = settled.filter(line => /[+-]\s*\d+│/.test(line)).length;
		expect(settledDiffRows).toBeGreaterThan(lines.filter(line => /[+-]\s*\d+│/.test(line)).length);
	});
});

test("call-phase expansion is deferred while args stream", () => {
	const code = Array.from({ length: 80 }, (_, i) => `x${i} = ${i}`).join("\n");
	const component = evalToolRenderer.renderCall(
		{ code, language: "python" },
		{ expanded: true, isPartial: true, spinnerFrame: 0 },
		theme,
	);
	const lines = component.render(WIDTH).map(strip);
	expect(lines.length, "streaming call block stays windowed").toBeLessThan(30);
	expect(lines.some(line => line.includes("expanded view once the cell settles"))).toBe(true);
});

test("completed cells stream their hunks too while a later cell still runs", () => {
	const big = (seed: string) => `${Array.from({ length: 60 }, (_, i) => `${seed} line ${i}`).join("\n")}\n`;
	const done: NonNullable<EvalToolDetails["cells"]>[number] = {
		index: 0,
		title: "done",
		code: "pass",
		language: "python",
		output: "ok",
		status: "complete",
		durationMs: 5,
		statusEvents: [diffEvent(FILE, big("old"), big("new"))],
	};
	const running: NonNullable<EvalToolDetails["cells"]>[number] = {
		index: 1,
		title: "live",
		code: "pass",
		language: "python",
		output: "running…",
		status: "running",
		statusEvents: [diffEvent(FILE.replace("x.py", "y.py"), big("old"), big("new"))],
	};
	// Both cells' delivered hunks render while the call streams — the latest
	// cell gets budget priority and the earlier one uses what remains — each
	// tail-truncated so the block stays windowable.
	withTerminalRows(60, () => {
		const lines = renderCells([done, running], { expanded: false, isPartial: true });
		const diffRows = lines.filter(line => /[+-]\s*\d+│/.test(line));
		expect(diffRows.length, "hunks render while the call streams").toBeGreaterThan(0);
		expect(lines.some(line => line.includes("x.py"))).toBe(true);
		expect(lines.some(line => line.includes("y.py"))).toBe(true);
	});

	// Once the call settles, every cell renders its complete diff.
	const settled = renderCells([done, { ...running, status: "complete" as const, durationMs: 5 }], {
		expanded: false,
		isPartial: false,
	});
	const perCellDiffRows = String(done.statusEvents?.[0]?.diff ?? "")
		.split("\n")
		.filter((row: string) => /^[+-]\d+\|/.test(row)).length;
	const settledDiffRows = settled.filter(line => /[+-]\s*\d+│/.test(line));
	expect(settledDiffRows.length).toBeGreaterThanOrEqual(perCellDiffRows * 2);
});

test("status events render under their own label even when the cell has no output", () => {
	const lines = render([{ op: "log", message: "hello" }], { expanded: false, output: "" });
	expect(lines.some(line => /(^|\s)Status$/.test(line))).toBe(true);
	expect(lines.some(line => /(^|\s)Output$/.test(line))).toBe(false);
	expect(lines.some(line => line.includes("hello"))).toBe(true);
});
