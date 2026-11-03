import { describe, expect, it, mock, vi } from "bun:test";
import { MacOSSpellingProvider, type SpellingBackend } from "./macos-spelling";

const misspelled: SpellingBackend = {
	isAvailable: () => true,
	checkSpelling: async text => (text === "recieved" ? [{ start: 0, length: 8 }] : []),
	completeWord: async () => [],
	autocorrectWord: async () => null,
	spellingGuesses: async () => [],
};

async function paintTypo(styledUnderlines: boolean, backend: SpellingBackend = misspelled): Promise<string> {
	const provider = new MacOSSpellingProvider(backend, styledUnderlines);
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

	it("never re-emits text for overlapping or out-of-bounds ranges", async () => {
		const overlapping: SpellingBackend = {
			...misspelled,
			checkSpelling: async () => [
				{ start: 0, length: 8 },
				{ start: 2, length: 3 },
				{ start: 6, length: 10 },
			],
		};
		expect(await paintTypo(false, overlapping)).toBe("\x1b[4mrecieved\x1b[24m");
	});
});

it("checks a whole logical word when the cursor splits its render segments", async () => {
	const checkSpelling = mock(misspelled.checkSpelling);
	const provider = new MacOSSpellingProvider({ ...misspelled, checkSpelling }, false);
	provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });
	const context = { editorText: "recieved", lines: ["recieved"], line: 0, startCol: 0 };
	const updated = Promise.withResolvers<void>();
	provider.onUpdate = updated.resolve;
	provider.decorateTypos("rec", context);
	await updated.promise;
	expect(checkSpelling).toHaveBeenCalledWith("recieved");
	expect(provider.decorateTypos("rec", context)).toBe("\x1b[4mrec\x1b[24m");
	expect(provider.decorateTypos("ieved", { ...context, startCol: 3 })).toBe("\x1b[4mieved\x1b[24m");
	expect(provider.decorateTypos("recieved", { ...context, typing: { line: 0, start: 0, end: 8 } })).toBe("recieved");
	expect(provider.decorateTypos("recieved", context)).toBe("\x1b[4mrecieved\x1b[24m");
});

it("disables spelling assistance when a native backend call never settles", async () => {
	vi.useFakeTimers();
	try {
		const pending = Promise.withResolvers<readonly { start: number; length: number }[]>();
		const checkSpelling = mock(() => pending.promise);
		const provider = new MacOSSpellingProvider({ ...misspelled, checkSpelling });
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });
		const context = { editorText: "recieved", lines: ["recieved"], line: 0, startCol: 0 };
		provider.decorateTypos("recieved", context);
		vi.advanceTimersByTime(5000);
		for (let tick = 0; tick < 10; tick++) await Promise.resolve();
		expect(provider.decorateTypos("recieved", context)).toBe("recieved");
		expect(await provider.getWordReplacements(["recieved"], 0, 4)).toBeNull();
		expect(await provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(checkSpelling).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});
