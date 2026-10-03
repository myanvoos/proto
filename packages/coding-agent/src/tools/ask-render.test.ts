import { expect, test } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { initThemeSync, theme } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { AskTool, askToolRenderer } from "./ask";

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

test("ask refuses noninteractive execution without opening a dialog", async () => {
	const tool = new AskTool({ hasUI: false, canPromptUser: false } as ToolSession);
	let aborted = false;
	const context = {
		hasUI: false,
		abort: () => {
			aborted = true;
		},
	} as AgentToolContext;
	expect(AskTool.createIf({ hasUI: false, canPromptUser: false } as ToolSession)).toBeNull();
	await expect(
		tool.execute(
			"ask-no-ui",
			{
				questions: [{ id: "q", question: "Choose a value", options: [{ label: "One" }] }],
			},
			undefined,
			undefined,
			context,
		),
	).rejects.toThrow("Ask tool requires interactive mode");
	expect(aborted).toBe(true);
});

test("ask returns the interactive dialog selection without requesting real user input", async () => {
	const tool = new AskTool({
		hasUI: false,
		settings: { get: () => 0 },
	} as unknown as ToolSession);
	let presented = 0;
	const context = {
		hasUI: true,
		abort: () => {
			throw new Error("Unexpected abort");
		},
		ui: {
			askDialog: async () => {
				presented++;
				return { kind: "submit", results: [{ id: "q", selectedOptions: ["One"] }] };
			},
		},
	} as unknown as AgentToolContext;
	const result = await tool.execute(
		"ask-dialog",
		{
			questions: [{ id: "q", question: "Choose a value", options: [{ label: "One" }] }],
		},
		undefined,
		undefined,
		context,
	);
	expect(presented).toBe(1);
	expect(result.details?.selectedOptions).toEqual(["One"]);
});

test("ask strips injected carriage returns from dialog prose but keeps option labels as the answer identity", async () => {
	const tool = new AskTool({
		hasUI: false,
		settings: { get: () => 0 },
	} as unknown as ToolSession);
	let presented: Array<{
		question: string;
		options: Array<{ label: string; description?: string; preview?: string }>;
	}> = [];
	const context = {
		hasUI: true,
		abort: () => {
			throw new Error("Unexpected abort");
		},
		ui: {
			askDialog: async (questions: typeof presented) => {
				presented = questions;
				return { kind: "submit", results: [{ id: "q", selectedOptions: ["Keep\r\rthis"] }] };
			},
		},
	} as unknown as AgentToolContext;
	const result = await tool.execute(
		"ask-cr",
		{
			questions: [
				{
					id: "q",
					question: "Which\r\r\rone?",
					options: [{ label: "Keep\r\rthis", description: "word\rby\r\rword", preview: "line one\r\nline\rtwo" }],
				},
			],
		},
		undefined,
		undefined,
		context,
	);
	expect(presented[0]?.question).toBe("Which one?");
	expect(presented[0]?.options[0]).toEqual({
		label: "Keep\r\rthis",
		description: "word by word",
		preview: "line one\nline two",
	});
	expect(result.details?.selectedOptions).toEqual(["Keep\r\rthis"]);

	const rendered = askToolRenderer
		.renderCall({ questions: [{ id: "q", question: "Which\r\r\rone?", options: [] }] }, PENDING, theme)
		.render(WIDTH)
		.map(strip)
		.join("\n");
	expect(rendered).toContain("Which one?");
});
