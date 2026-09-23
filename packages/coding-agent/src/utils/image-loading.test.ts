import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	ImageDecodeError,
	loadImageAttachmentInput,
	loadImageInput,
	normalizeModelContextImages,
	UnsupportedImageConversionError,
} from "./image-loading";

// A real 1x1 PNG, and a file that only looks like a PNG: correct signature, undecodable body.
const VALID_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function corruptPngBytes(size = 5000): Buffer {
	const body = Buffer.alloc(size);
	for (let i = 0; i < size; i++) body[i] = (i * 37 + 11) % 251;
	return Buffer.concat([PNG_SIGNATURE, body]);
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-image-decode-"));
	try {
		return await run(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

const UNDECODABLE_WEBP: ImageContent = {
	type: "image",
	mimeType: "image/webp",
	data: Buffer.from("RIFFinvalidWEBPpayload").toBase64(),
};

const STB_MODEL = {
	provider: "ollama",
	api: "ollama-chat",
	imageInputDecoder: "stb",
} as Model;

test("model context images reject WebP when required conversion fails", async () => {
	await expect(normalizeModelContextImages([UNDECODABLE_WEBP], { model: STB_MODEL })).rejects.toBeInstanceOf(
		UnsupportedImageConversionError,
	);
});

test("a corrupt image file is rejected instead of being loaded as undecodable base64", async () => {
	await withTempDir(async directory => {
		const corrupt = path.join(directory, "corrupt.png");
		await Bun.write(corrupt, corruptPngBytes());

		for (const autoResize of [false, true]) {
			await expect(loadImageInput({ path: corrupt, cwd: directory, autoResize })).rejects.toBeInstanceOf(
				ImageDecodeError,
			);
		}
		await expect(loadImageInput({ path: corrupt, cwd: directory, autoResize: false })).rejects.toThrow(
			/corrupt or truncated/,
		);
	});
});

test("a decodable image file still loads with its bytes intact", async () => {
	await withTempDir(async directory => {
		const valid = path.join(directory, "valid.png");
		await Bun.write(valid, Buffer.from(VALID_PNG_BASE64, "base64"));

		const loaded = await loadImageInput({ path: valid, cwd: directory, autoResize: false });
		expect(loaded?.mimeType).toBe("image/png");
		expect(loaded?.data).toBe(VALID_PNG_BASE64);
	});
});

test("a corrupt image attachment is rejected while a decodable one loads", async () => {
	const corrupt: ImageContent = {
		type: "image",
		mimeType: "image/png",
		data: corruptPngBytes().toBase64(),
	};
	await expect(
		loadImageAttachmentInput({ image: corrupt, label: "#1", uri: "attachment://1", autoResize: false }),
	).rejects.toBeInstanceOf(ImageDecodeError);

	const valid: ImageContent = { type: "image", mimeType: "image/png", data: VALID_PNG_BASE64 };
	const loaded = await loadImageAttachmentInput({
		image: valid,
		label: "#1",
		uri: "attachment://1",
		autoResize: false,
	});
	expect(loaded?.data).toBe(VALID_PNG_BASE64);
});
