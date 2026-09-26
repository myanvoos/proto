import { afterEach, beforeEach, expect, test } from "bun:test";
import { Image, ImageBudget } from "./components/image";
import { TERMINAL_IMAGE_LIMITS } from "./image-limits";
import { ImageProtocol, renderImage, setTerminalImageProtocol, TERMINAL } from "./terminal-capabilities";

let protocol: ImageProtocol | null;
const images: Image[] = [];
beforeEach(() => {
	protocol = TERMINAL.imageProtocol;
	setTerminalImageProtocol(ImageProtocol.Kitty);
});
afterEach(() => {
	for (const image of images.splice(0)) image.dispose();
	setTerminalImageProtocol(protocol);
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const theme = { fallbackColor: (text: string) => text };

test("source byte admission falls back without queuing data and disposal frees exactly its ownership", () => {
	const budget = new ImageBudget(8, () => {}, { imageBytes: PNG.length, sourceBytes: PNG.length * 2 });
	const make = () => {
		const image = new Image(PNG, "image/png", theme, { budget });
		images.push(image);
		return image;
	};
	const first = make();
	make();
	const rejected = make();
	expect(rejected.render(80).join("")).toContain("limit");
	expect(budget.hasPendingTransmits()).toBe(false);
	first.dispose();
	first.dispose();
	const replacement = make();
	replacement.render(80);
	expect(budget.takeTransmitBatch().ids).toHaveLength(1);
	expect(make().render(80).join("")).toContain("limit");
});

test("image disposal cancels queued payloads and disposed components cannot transmit again", () => {
	const budget = new ImageBudget();
	const image = new Image(PNG, "image/png", theme, { budget, imageKey: "owned" });
	images.push(image);
	image.render(80);
	expect(budget.hasPendingTransmits()).toBe(true);
	image.dispose();
	expect(budget.hasPendingTransmits()).toBe(false);
	image.render(80);
	expect(budget.hasPendingTransmits()).toBe(false);
});

test("small advertised geometry cannot bypass intrinsic pixel-bomb rejection", () => {
	const bomb = Buffer.from(PNG, "base64");
	bomb.writeUInt32BE(TERMINAL_IMAGE_LIMITS.pixels + 1, 16);
	const base64 = bomb.toString("base64");
	const budget = new ImageBudget();
	const image = new Image(base64, "image/png", theme, { budget }, { widthPx: 1, heightPx: 1 });
	images.push(image);
	expect(image.render(80).join("")).toContain("limit");
	expect(budget.hasPendingTransmits()).toBe(false);
	expect(renderImage(base64, { widthPx: 1, heightPx: 1 })).toBeNull();
});
