import { expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	getKittyGraphics,
	ImageBudget,
	ImageProtocol,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { AttachmentChipsBand } from "./attachment-chips";
import type { ComposerChipDescriptor, CustomEditor } from "./custom-editor";

initThemeSync();

const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("attachment chip image acquisitions stay balanced across renders and removal", () => {
	const previousProtocol = TERMINAL.imageProtocol;
	const previousGraphics = getKittyGraphics();
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: true });
	try {
		const image: ImageContent = { type: "image", data: ONE_BY_ONE_PNG, mimeType: "image/png" };
		let chips: ComposerChipDescriptor[] = [{ kind: "image", n: 1, image, link: undefined }];
		const editor = { composerChips: () => chips } as unknown as CustomEditor;
		const budget = new ImageBudget(4);
		const band = new AttachmentChipsBand(editor, budget, () => {});
		band.render(40);
		band.render(40);
		expect(budget.hasPendingTransmits()).toBe(true);

		chips = [];
		band.render(40);
		const imageKey = `chip:${image.mimeType}:${image.data.length}:${image.data.slice(0, 32)}`;
		const fresh = budget.acquireId(imageKey);
		expect(budget.shouldTransmit(fresh)).toBe(true);
		budget.releaseImageKey(imageKey, fresh);
	} finally {
		setTerminalImageProtocol(previousProtocol);
		setKittyGraphics(previousGraphics);
	}
});

function pasteChip(n = 1): ComposerChipDescriptor {
	const content = Array.from({ length: 30 }, (_, index) => `line ${index} 漢字🙂`).join("\n");
	return { kind: "paste", n, text: { n, label: `#${n}`, content, lineCount: 30, charCount: content.length } };
}

test("attachment previews are complete cards or compact captions within both dimensions", () => {
	const editor = { composerChips: () => [pasteChip()] } as unknown as CustomEditor;
	const band = new AttachmentChipsBand(editor, new ImageBudget(4), () => {});
	try {
		for (const height of [6, 5, 4, 3, 2, 1, 0, 6]) {
			band.setMaxHeight(height);
			const rows = band.render(20).map(Bun.stripANSI);
			expect(rows.length).toBeLessThanOrEqual(height);
			if (height === 0) expect(rows).toEqual([]);
			else if (height < 6) expect(rows).toEqual(["#1 30 lines"]);
			else {
				expect(rows).toHaveLength(6);
				// Four preview rows are visible, so the caption counts only what stays hidden.
				expect(rows[5]).toContain("+26 lines");
			}
		}
		for (const width of [1, 2, 8, 12, 13]) {
			const rows = band.render(width);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
		}
	} finally {
		band.dispose();
	}
});

test("adjacent attachment cards account for their inter-card gap", () => {
	const editor = { composerChips: () => [pasteChip(1), pasteChip(2)] } as unknown as CustomEditor;
	const band = new AttachmentChipsBand(editor, new ImageBudget(4), () => {});
	try {
		for (const width of [14, 28, 29, 30, 40]) {
			const rows = band.render(width);
			expect(rows).toHaveLength(6);
			expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		}
	} finally {
		band.dispose();
	}
});

function longPasteChip(n = 1, lines = 221): ComposerChipDescriptor {
	const content = Array.from({ length: lines }, () => "The quick brown fox jumps over the lazy dog").join("\n");
	return { kind: "paste", n, text: { n, label: `#${n}`, content, lineCount: lines, charCount: content.length } };
}

test("a text preview grows to the width its own rows need", () => {
	const editor = { composerChips: () => [longPasteChip()] } as unknown as CustomEditor;
	const band = new AttachmentChipsBand(editor, new ImageBudget(4), () => {});
	try {
		const wide = band.render(100).map(Bun.stripANSI);
		expect(wide[1]).toContain("The quick brown fox jumps over the lazy dog");
		expect(visibleWidth(wide[0]!)).toBe(45);
		expect(wide.every(row => visibleWidth(row) <= 100)).toBe(true);

		// A narrow composer still truncates to the card it can afford.
		const narrow = band.render(20).map(Bun.stripANSI);
		expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(20);
		expect(narrow[1]).toContain("The quick");
		expect(narrow[1]).not.toContain("lazy dog");
	} finally {
		band.dispose();
	}
});

test("two text previews share the spare columns and keep their gap", () => {
	const editor = { composerChips: () => [longPasteChip(1), longPasteChip(2)] } as unknown as CustomEditor;
	const band = new AttachmentChipsBand(editor, new ImageBudget(4), () => {});
	try {
		for (const width of [30, 60, 100, 120]) {
			const rows = band.render(width).map(Bun.stripANSI);
			expect(rows).toHaveLength(6);
			expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		}
		const balanced = band.render(60).map(Bun.stripANSI);
		const [first, second] = balanced[0]!.split("  ");
		expect(visibleWidth(first!)).toBe(visibleWidth(second!));
	} finally {
		band.dispose();
	}
});

test("a paste whose rows all fit reports its size instead of a line remainder", () => {
	const content = "alpha\nbeta\ngamma";
	const chip: ComposerChipDescriptor = {
		kind: "paste",
		n: 1,
		text: { n: 1, label: "#1", content, lineCount: 3, charCount: content.length },
	};
	const editor = { composerChips: () => [chip] } as unknown as CustomEditor;
	const band = new AttachmentChipsBand(editor, new ImageBudget(4), () => {});
	try {
		const rows = band.render(40).map(Bun.stripANSI);
		expect(rows[5]).toContain(`${content.length} chars`);
		expect(rows[5]).not.toContain("lines");
	} finally {
		band.dispose();
	}
});
