import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { askToolRenderer } from "./ask";

initThemeSync();

const WIDTH = 60;

function strip(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const PENDING = { expanded: false, isPartial: true } as const;

// While the dialog is open, the full question + option list is already on screen in the
// dialog itself; the transcript card must stay a one-line-per-question summary.
test("pending ask card renders one truncated line per question and no options", () => {
	const longQuestion = `Which migration strategy should we use for the ${"very ".repeat(20)}large table?`;
	const lines = askToolRenderer
		.renderCall(
			{
				questions: [
					{
						id: "strategy",
						question: longQuestion,
						options: [
							{ label: "Online", description: "Use pt-online-schema-change" },
							{ label: "Offline", description: "Take a maintenance window" },
						],
					},
					{
						id: "scope",
						question: "Line one\nLine two\tof the second question",
						options: [{ label: "All" }, { label: "Some" }],
					},
				],
			},
			PENDING,
			theme,
		)
		.render(WIDTH)
		.map(strip);

	expect(lines[0]).toContain("Ask");
	expect(lines[0]).toContain("2 questions");
	expect(lines).toHaveLength(3);
	expect(lines[1]).toMatch(/Which migration strategy should we use for the very/);
	expect(lines[1]).toContain("…");
	expect(lines[2]).toContain("Line one Line two of the second question");
	const body = lines.join("\n");
	expect(body).not.toContain("Online");
	expect(body).not.toContain("pt-online-schema-change");
	expect(body).not.toContain("↳");
	for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(WIDTH);
});

test("pending ask header pluralises by question count", () => {
	const single = askToolRenderer
		.renderCall(
			{ questions: [{ id: "q", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
			PENDING,
			theme,
		)
		.render(WIDTH)
		.map(strip);
	expect(single[0]).toContain("1 question");
	expect(single[0]).not.toContain("1 questions");
});

test("answered ask card keeps the chosen option and pluralises its header", () => {
	const lines = askToolRenderer
		.renderResult(
			{
				content: [{ type: "text", text: "Yes" }],
				details: {
					results: [
						{ id: "q", question: "Proceed?", options: ["Yes", "No"], selectedOptions: ["Yes"], multi: false },
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
		)
		.render(WIDTH)
		.map(strip);
	expect(lines[0]).toContain("1 question");
	expect(lines[0]).not.toContain("1 questions");
	expect(lines.join("\n")).toContain("Yes");
	expect(lines.join("\n")).toContain("No");
});
