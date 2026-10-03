import { describe, expect, it, vi } from "bun:test";
import { initThemeSync, theme } from "../theme/theme";
import { AskDialogComponent } from "./ask-dialog";

initThemeSync();

const CTRL_O = "\x0f";

function createDialog(question: string, description?: string, multi = false): AskDialogComponent {
	return new AskDialogComponent(
		[{ id: "q1", question, options: [{ label: "Option A", description }, { label: "Option B" }], multi }],
		{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
	);
}

function render(dialog: AskDialogComponent): string {
	return Bun.stripANSI(dialog.render(80).join("\n"));
}

function count(text: string, phrase: string): number {
	return text.split(phrase).length - 1;
}

describe("AskDialogComponent custom answers", () => {
	it("moves a single multi-select question to review after a custom answer instead of submitting", async () => {
		const onSubmit = vi.fn();
		const dialog = new AskDialogComponent(
			[{ id: "q1", question: "Choose several?", options: [{ label: "A" }, { label: "B" }], multi: true }],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn().mockResolvedValue("custom detail") },
		);

		dialog.handleInput(" ");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(dialog)).toContain("Review answers");

		dialog.handleInput("\r");
		expect(onSubmit.mock.calls[0]?.[0].results).toMatchObject([
			{ id: "q1", selectedOptions: ["A"], customInput: "custom detail" },
		]);
	});

	it("advances a multi-select custom answer to the next question", async () => {
		const dialog = new AskDialogComponent(
			[
				{ id: "q1", question: "Choose several?", options: [{ label: "A" }], multi: true },
				{ id: "q2", question: "Second question?", options: [{ label: "C" }] },
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn().mockResolvedValue("custom detail") },
		);

		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(render(dialog)).toContain("Second question?");
	});
});

describe("AskDialogComponent Ctrl+O expansion", () => {
	it("expands a truncated question within the dialog height and collapses on a second press", () => {
		const phrase = "This is a very long question";
		const dialog = createDialog(`${phrase} `.repeat(200));
		const collapsed = render(dialog);
		expect(count(collapsed, phrase)).toBeLessThan(10);
		expect(collapsed).toMatch(/ expand\b/);

		dialog.handleInput(CTRL_O);
		const expanded = render(dialog);
		expect(count(expanded, phrase)).toBeGreaterThanOrEqual(15);
		expect(expanded).toMatch(/ collapse\b/);
		expect(dialog.render(80).length).toBeLessThanOrEqual(Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7)));

		dialog.handleInput(CTRL_O);
		expect(render(dialog)).toBe(collapsed);
	});

	it("expands truncated option descriptions", () => {
		const phrase = "This is a very long description";
		const dialog = createDialog("Choose one?", `${phrase} `.repeat(30));
		const collapsed = render(dialog);
		expect(collapsed).toMatch(/ expand\b/);

		expect(dialog.toggleQuestionExpansion()).toBe(true);
		expect(count(render(dialog), phrase)).toBeGreaterThan(count(collapsed, phrase));
	});

	it("declines expansion when nothing is truncated or the submit tab is active", () => {
		const short = createDialog("Choose one?", "Short description.");
		const before = render(short);
		expect(before).not.toMatch(/ expand\b/);
		expect(short.toggleQuestionExpansion()).toBe(false);
		expect(render(short)).toBe(before);

		const multi = createDialog("This is a very long question ".repeat(30), undefined, true);
		multi.render(80);
		multi.handleInput("\x1b[Z");
		expect(multi.toggleQuestionExpansion()).toBe(false);
	});
});

describe("AskDialogComponent recommended options", () => {
	const SPACE = " ";
	const ENTER = "\r";

	it("multi-select: an intrinsic Recommended suffix still follows selection state", () => {
		const onSubmit = vi.fn();
		const dialog = new AskDialogComponent(
			[
				{
					id: "target",
					question: "Choose multiple?",
					options: [{ label: "Generic MLE loop (Recommended)" }, { label: "Amazon-style (LPs)" }],
					multi: true,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		dialog.handleInput(SPACE);
		expect(render(dialog)).toContain(`${theme.checkbox.checked} Generic MLE loop (Recommended)`);
		dialog.handleInput(SPACE);
		expect(render(dialog)).toContain(`${theme.checkbox.unchecked} Generic MLE loop (Recommended)`);
		dialog.handleInput(SPACE);
		dialog.handleInput(ENTER);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Generic MLE loop (Recommended)"]);
	});

	it("renders an intrinsic Recommended suffix only once", () => {
		const dialog = new AskDialogComponent(
			[
				{
					id: "target",
					question: "Choose one?",
					options: [{ label: "Generic MLE loop (Recommended)" }, { label: "Amazon-style (LPs)" }],
					recommended: 0,
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		expect(render(dialog)).toContain("Generic MLE loop (Recommended)");
		expect(render(dialog)).not.toContain("(Recommended) (Recommended)");
	});
});
