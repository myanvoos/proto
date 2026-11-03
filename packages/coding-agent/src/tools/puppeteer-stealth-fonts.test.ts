import { expect, test } from "bun:test";

test("reacquiring a cached canvas context does not grow fillText wrappers or overflow the draw", async () => {
	class CanvasContext {
		draws = 0;
		fillText(_text: string, _x: number, _y: number, _maxWidth?: number): void {
			this.draws++;
		}
	}
	class Canvas {
		#context = new CanvasContext();
		getContext(_kind: string): CanvasContext {
			return this.#context;
		}
	}
	const source = await Bun.file(new URL("./puppeteer/07_stealth_fonts.txt", import.meta.url)).text();
	new Function("window", "HTMLCanvasElement", "CanvasRenderingContext2D", "Math_random", "patchToString", source)(
		{},
		Canvas,
		CanvasContext,
		Math.random,
		() => {},
	);
	const canvas = new Canvas();
	let context = canvas.getContext("2d");
	for (let index = 0; index < 30_000; index++) context = canvas.getContext("2d");
	context.fillText("probe", 10, 10);
	expect(context.draws).toBe(1);
});
