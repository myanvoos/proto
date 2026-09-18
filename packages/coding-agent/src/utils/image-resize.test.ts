import { afterEach, expect, spyOn, test, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ImageResizeMaxBytesError, resizeImage } from "./image-resize";

const ONE_PIXEL_PNG: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};

afterEach(() => vi.restoreAllMocks());

test("resize rejects with a typed error instead of returning bytes above maxBytes", async () => {
	const resizing = resizeImage(ONE_PIXEL_PNG, { maxBytes: 1, excludeWebP: true });
	await expect(resizing).rejects.toBeInstanceOf(ImageResizeMaxBytesError);
	await expect(resizing).rejects.toMatchObject({ maxBytes: 1 });
});

test("over-limit resizing does not repeat target-dimension lossy encodes", async () => {
	const jpeg = spyOn(Bun.Image.prototype, "jpeg");
	await resizeImage(ONE_PIXEL_PNG, { maxBytes: 1, excludeWebP: true }).catch(() => undefined);
	expect(jpeg).toHaveBeenCalledTimes(13);
});
