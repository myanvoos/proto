import { describe, expect, it } from "bun:test";
import { MacOSSpellingProvider, type SpellingBackend } from "./macos-spelling";

const misspelled: SpellingBackend = {
	isAvailable: () => true,
	checkSpelling: async text => (text === "recieved" ? [{ start: 0, length: 8 }] : []),
	completeWord: async () => [],
	autocorrectWord: async () => null,
	spellingGuesses: async () => [],
};

async function paintTypo(styledUnderlines: boolean): Promise<string> {
	const provider = new MacOSSpellingProvider(misspelled, styledUnderlines);
	provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });
	const updated = Promise.withResolvers<void>();
	provider.onUpdate = updated.resolve;
	const context = { editorText: "recieved", lines: ["recieved"], line: 0, startCol: 0 };
	provider.decorateTypos("recieved", context);
	await updated.promise;
	return provider.decorateTypos("recieved", context);
}

describe("macOS spelling typo marks", () => {
	it("paints a colored undercurl where styled underlines render", async () => {
		expect(await paintTypo(true)).toBe("\x1b[4:3m\x1b[58:2::255:95:95mrecieved\x1b[4:0m\x1b[59m");
	});

	it("falls back to a flat underline without the colon-form reset elsewhere", async () => {
		// Apple Terminal paints CSI 4 : 0 m as a solid black bar to end of line.
		expect(await paintTypo(false)).toBe("\x1b[4mrecieved\x1b[24m");
	});
});
