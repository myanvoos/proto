import { afterEach, expect, spyOn, test, vi } from "bun:test";
import {
	assertDecodableImage,
	convertImageToPng,
	loadImageAttachmentInput,
	normalizeModelContextImages,
} from "./image-loading";
import { resizeImage } from "./image-resize";
import {
	ImageResourceLimitError,
	MAX_IMAGE_INPUT_BYTES,
	MAX_IMAGE_PIXELS,
	MAX_PENDING_IMAGE_INPUTS,
	reserveImageInput,
	withImageInput,
	withImagePixels,
} from "./image-resources";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image = { type: "image" as const, mimeType: "image/png", data: PNG };

function pngHeader(width: number, height: number): Buffer {
	const buffer = Buffer.from(PNG, "base64");
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

afterEach(() => vi.restoreAllMocks());

test("direct resize and attachment normalization reject pixel bombs before native metadata", async () => {
	const metadata = spyOn(Bun.Image.prototype, "metadata");
	const bomb = { ...image, data: pngHeader(MAX_IMAGE_PIXELS + 1, 1).toString("base64") };
	await expect(resizeImage(bomb)).rejects.toBeInstanceOf(ImageResourceLimitError);
	await expect(normalizeModelContextImages([bomb])).rejects.toBeInstanceOf(ImageResourceLimitError);
	await expect(
		loadImageAttachmentInput({ image: bomb, label: "bomb", uri: "attachment://1", autoResize: true }),
	).rejects.toBeInstanceOf(ImageResourceLimitError);
	expect(metadata).not.toHaveBeenCalled();
});

test("GIF and WebP dimensions are admitted before invoking a native decoder", async () => {
	const metadata = spyOn(Bun.Image.prototype, "metadata");
	const gif = Buffer.alloc(30);
	gif.write("GIF89a");
	gif.writeUInt16LE(65535, 6);
	gif.writeUInt16LE(65535, 8);
	const webp = Buffer.alloc(30);
	webp.write("RIFF", 0);
	webp.write("WEBPVP8X", 8);
	webp.writeUIntLE(65534, 24, 3);
	webp.writeUIntLE(65534, 27, 3);
	for (const data of [gif, webp]) {
		await expect(assertDecodableImage(data, "bomb")).rejects.toBeInstanceOf(ImageResourceLimitError);
	}
	expect(metadata).not.toHaveBeenCalled();
});

test("base64 and raw payloads cannot bypass the encoded input ceiling", async () => {
	const metadata = spyOn(Bun.Image.prototype, "metadata");
	const oversized = Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1);
	await expect(assertDecodableImage(oversized, "raw")).rejects.toBeInstanceOf(ImageResourceLimitError);
	await expect(resizeImage({ ...image, data: oversized.toString("base64") })).rejects.toBeInstanceOf(
		ImageResourceLimitError,
	);
	await expect(
		convertImageToPng({ ...image, data: " ".repeat(Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 + 1) }),
	).rejects.toBeInstanceOf(ImageResourceLimitError);
	expect(metadata).not.toHaveBeenCalled();
});

test("pending input count rejects without retaining or running another payload and releases on failure", async () => {
	const barrier = Promise.withResolvers<void>();
	let started = 0;
	const pending = Array.from({ length: MAX_PENDING_IMAGE_INPUTS }, () =>
		withImageInput(PNG, async () => {
			started++;
			await barrier.promise;
			throw new Error("reader failed");
		}).catch(error => error),
	);
	try {
		await expect(
			withImageInput(PNG, async () => {
				started++;
			}),
		).rejects.toBeInstanceOf(ImageResourceLimitError);
		expect(started).toBe(MAX_PENDING_IMAGE_INPUTS);
	} finally {
		barrier.resolve();
		await Promise.all(pending);
	}
	await expect(withImageInput(PNG, async bytes => bytes[0])).resolves.toBe(0x89);
});

test("pending aggregate bytes include simultaneous raw and UTF-16 base64 and release idempotently", () => {
	const first = reserveImageInput(MAX_IMAGE_INPUT_BYTES);
	const second = reserveImageInput(MAX_IMAGE_INPUT_BYTES);
	try {
		expect(() => reserveImageInput(MAX_IMAGE_INPUT_BYTES)).toThrow(ImageResourceLimitError);
		first.release();
		first.release();
		const replacement = reserveImageInput(MAX_IMAGE_INPUT_BYTES);
		try {
			expect(() => reserveImageInput(MAX_IMAGE_INPUT_BYTES)).toThrow(ImageResourceLimitError);
		} finally {
			replacement.release();
		}
	} finally {
		first.release();
		second.release();
	}
});

test("native concurrency remains occupied until pending native work settles", async () => {
	const barrier = Promise.withResolvers<void>();
	const original = Bun.Image.prototype.metadata;
	const metadata = spyOn(Bun.Image.prototype, "metadata").mockImplementation(async function (this: Bun.Image) {
		await barrier.promise;
		return original.call(this);
	});
	const first = assertDecodableImage(PNG, "first");
	const second = assertDecodableImage(PNG, "second");
	try {
		await expect(resizeImage(image)).rejects.toMatchObject({ reason: "busy" });
		await expect(convertImageToPng(image)).rejects.toMatchObject({ reason: "busy" });
		expect(metadata).toHaveBeenCalledTimes(2);
	} finally {
		barrier.resolve();
		await Promise.all([first, second]);
	}
	await expect(assertDecodableImage(PNG, "after completion")).resolves.toEqual({ width: 1, height: 1 });
});

test("aggregate decoded pixels include encoder target dimensions, not just operation count", async () => {
	const barrier = Promise.withResolvers<void>();
	const maxPixels = pngHeader(8000, 4000);
	const pending = withImagePixels(
		maxPixels,
		async () => {
			await barrier.promise;
			return "completed";
		},
		1,
	);
	try {
		await expect(withImagePixels(maxPixels, async () => "should not start")).rejects.toMatchObject({
			reason: "busy",
		});
	} finally {
		barrier.resolve();
		await pending;
	}
	await expect(withImagePixels(maxPixels, async () => "admitted")).resolves.toBe("admitted");
});

test("resize format candidates do not overlap native encoders", async () => {
	const original = Bun.Image.prototype.bytes;
	let active = 0;
	let peak = 0;
	spyOn(Bun.Image.prototype, "bytes").mockImplementation(async function (this: Bun.Image) {
		active++;
		peak = Math.max(peak, active);
		try {
			return await original.call(this);
		} finally {
			active--;
		}
	});
	const result = await resizeImage(image);
	expect(result.width).toBe(200);
	expect(peak).toBe(1);
});

test("invalid target reservations cannot subtract from or bypass the active pixel budget", async () => {
	for (const targetPixels of [-1, Number.NaN, MAX_IMAGE_PIXELS + 1]) {
		let started = false;
		await expect(
			withImagePixels(
				Buffer.from(PNG, "base64"),
				async () => {
					started = true;
				},
				targetPixels,
			),
		).rejects.toMatchObject({ reason: "oversized" });
		expect(started).toBe(false);
	}
});

test("failed native work releases its operation capacity for subsequent images", async () => {
	spyOn(Bun.Image.prototype, "metadata").mockRejectedValueOnce(new Error("native decoder failed"));
	await expect(assertDecodableImage(PNG, "failed")).rejects.toMatchObject({ name: "ImageDecodeError" });
	await expect(
		Promise.all([assertDecodableImage(PNG, "first"), assertDecodableImage(PNG, "second")]),
	).resolves.toEqual([
		{ width: 1, height: 1 },
		{ width: 1, height: 1 },
	]);
});
