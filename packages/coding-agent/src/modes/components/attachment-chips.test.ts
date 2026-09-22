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
				expect(rows[5]).toContain("+30 lines");
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
