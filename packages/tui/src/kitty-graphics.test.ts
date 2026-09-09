import { describe, expect, it } from "bun:test";
import {
	detectKittyUnicodePlaceholdersSupport,
	encodeKittyVirtualPlacement,
	KITTY_PLACEHOLDER,
	renderKittyPlaceholderLines,
} from "./kitty-graphics";

describe("Kitty placeholder placement across terminal boundaries", () => {
	it("does not emit PUA placeholders for leaked Ghostty identity in Herdr", () => {
		const env = { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty", HERDR_PANE_ID: "pane-1" };
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env)).toBe(false);
	});

	it("emits U=1 placeholder bytes for a detected capable terminal inside tmux", () => {
		const env = { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty", TMUX: "/tmp/tmux/default,1,0" };
		expect(detectKittyUnicodePlaceholdersSupport("ghostty", env)).toBe(true);
		const lines = renderKittyPlaceholderLines({ imageId: 0x010203, columns: 1, rows: 1 });
		expect(lines).toEqual([
			`${encodeKittyVirtualPlacement({ imageId: 0x010203, columns: 1, rows: 1 })}\x1b[38;2;1;2;3m${KITTY_PLACEHOLDER}\u0305\u0305\x1b[39;59m`,
		]);
	});

	it("honors an explicit Kitty protocol override inside Herdr", () => {
		const env = { HERDR_ENV: "1", PI_FORCE_IMAGE_PROTOCOL: "kitty" };
		expect(detectKittyUnicodePlaceholdersSupport("base", env)).toBe(true);
	});
});
