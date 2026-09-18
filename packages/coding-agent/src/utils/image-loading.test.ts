import { expect, test } from "bun:test";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { normalizeModelContextImages, UnsupportedImageConversionError } from "./image-loading";

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
