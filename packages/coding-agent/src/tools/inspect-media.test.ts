import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import type { ToolSession } from ".";
import { InspectMediaTool } from "./inspect-media";
import { ReadTool } from "./read";

// 1x1 PNG (transparent).
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "input">): Model<Api> {
	return { provider: "testprov", api: "openai-completions", name: overrides.id, ...overrides } as Model<Api>;
}

function inspectSession(cwd: string, activeModel: Model<Api>): ToolSession {
	const settings = new Map<string, unknown>();
	const registry = {
		getAvailable: () => [activeModel],
		getApiKey: async () => "unused",
		resolver: () => () => "unused",
	};
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getModelRole: () => undefined },
		modelRegistry: registry,
		getActiveModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModel: () => activeModel,
		getImageAttachments: () => [],
	} as unknown as ToolSession;
}

function readSession(cwd: string, activeModel: Model<Api>, inspectMediaActive: boolean): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key) } as ToolSession["settings"],
		getActiveModel: () => activeModel,
		isToolActive: (name: string) => (name === "inspect_media" ? inspectMediaActive : undefined),
	} as unknown as ToolSession;
}

async function withPng(cwd: string): Promise<string> {
	const target = path.join(cwd, "pixel.png");
	await Bun.write(target, Buffer.from(PNG_BASE64, "base64"));
	return target;
}

const failCompletion = async (): Promise<never> => {
	throw new Error("side-model completion must not run");
};

test("inspect_media attaches the image itself when the active model reads images natively", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inspect-media-inline-"));
	try {
		const vision = model({ id: "vision", input: ["text", "image"] });
		const tool = new InspectMediaTool(inspectSession(dir, vision), failCompletion);
		const png = await withPng(dir);

		const result = await tool.execute("t1", { path: png, question: "What color is the pixel?" });

		const image = result.content.find((block): block is ImageContent => block.type === "image");
		expect(image).toBeDefined();
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data.length).toBeGreaterThan(0);
		expect(result.details?.model).toBe("testprov/vision");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("inspect_media does not inline images for text-only actives and still routes to a side model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inspect-media-textonly-"));
	try {
		const textOnly = model({ id: "textonly", input: ["text"] });
		const tool = new InspectMediaTool(inspectSession(dir, textOnly), failCompletion);
		const png = await withPng(dir);

		let message = "";
		try {
			await tool.execute("t2", { path: png, question: "What color is the pixel?" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("does not support image input");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read decodes images inline for a vision model even while inspect_media is active", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-inline-vision-"));
	try {
		const vision = model({ id: "vision", input: ["text", "image"] });
		const tool = new ReadTool(readSession(dir, vision, true));
		await withPng(dir);

		const result = await tool.execute("t3", { path: "pixel.png" });

		const image = result.content.find((block): block is ImageContent => block.type === "image");
		expect(image).toBeDefined();
		expect(image?.data.length).toBeGreaterThan(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read returns metadata instead of image contents when the active model cannot take images", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-metadata-textonly-"));
	try {
		const textOnly = model({ id: "textonly", input: ["text"] });
		const tool = new ReadTool(readSession(dir, textOnly, true));
		await withPng(dir);

		const result = await tool.execute("t4", { path: "pixel.png" });

		const image = result.content.find(block => block.type === "image");
		expect(image).toBeUndefined();
		const text = result.content.find((block): block is TextContent => block.type === "text");
		expect(text?.text).toContain("Image metadata:");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
