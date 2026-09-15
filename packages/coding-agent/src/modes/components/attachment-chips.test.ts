import { expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	getKittyGraphics,
	ImageBudget,
	ImageProtocol,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
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
