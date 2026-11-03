import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, ImageContent } from "../types";
import { prepareAnthropicImageContext } from "./anthropic-images";

const pixel = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
	"base64",
);
const spec = {
	id: "claude-sonnet-4-6",
	name: "Claude",
	api: "anthropic-messages" as const,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

function firstImage(context: Context): ImageContent {
	const message = context.messages[0];
	if (!Array.isArray(message.content)) throw new Error("Expected image content");
	const image = message.content.find(block => block.type === "image");
	if (image?.type !== "image") throw new Error("Expected image block");
	return image;
}

describe("Claude image request limits", () => {
	it("clamps even a single image and discards URLs that reference the oversized original", async () => {
		const data = Buffer.from(await new Bun.Image(pixel).resize(64, 32).png().bytes()).toString("base64");
		const original: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data,
			url: "https://images.example.test/original",
			providerFile: { provider: "anthropic", id: "file-original" },
		};
		const context: Context = {
			messages: [{ role: "developer", synthetic: true, content: [original], timestamp: 0 }],
		};
		const model = buildModel({ ...spec, compat: { maxImageDimension: 16 } });
		const prepared = await prepareAnthropicImageContext(context, model);
		const resized = firstImage(prepared);
		const metadata = await new Bun.Image(Buffer.from(resized.data, "base64")).metadata();
		expect(metadata.width).toBe(16);
		expect(metadata.height).toBe(8);
		expect(resized.url).toBeUndefined();
		expect(resized.providerFile).toBeUndefined();
		expect(original.url).toBe("https://images.example.test/original");
	});

	it("re-encodes tool-result images that fit the dimensions but exceed the encoded byte cap", async () => {
		const data = Buffer.from(await new Bun.Image(pixel).resize(64, 64).jpeg({ quality: 100 }).bytes()).toString(
			"base64",
		);
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "image",
					isError: false,
					toolName: "screenshot",
					content: [{ type: "image", mimeType: "image/jpeg", data }],
					timestamp: 0,
				},
			],
		};
		const model = buildModel({ ...spec, compat: { maxImagePayloadBytes: 800 } });
		const resized = firstImage(await prepareAnthropicImageContext(context, model));
		expect(data.length).toBeGreaterThan(800);
		expect(resized.data.length).toBeLessThanOrEqual(720);
		expect(resized.mimeType).toBe("image/png");
	});
});
