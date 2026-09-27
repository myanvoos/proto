import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AudioContent, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { disposeBashSessions } from "../exec/bash-executor";
import { createTools, type ToolSession } from ".";
import { ReadTool } from "./read";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "input">): Model<Api> {
	return { provider: "testprov", api: "openai-completions", name: overrides.id, ...overrides } as Model<Api>;
}

function readSession(
	cwd: string,
	activeModel: Model<Api>,
	settingsValues: Parameters<typeof Settings.isolated>[0] = {},
): ToolSession {
	const settings = Settings.isolated(settingsValues);
	return {
		cwd,
		settings,
		getActiveModel: () => activeModel,
		getImageAttachments: () => [],
	} as unknown as ToolSession;
}

async function withPng(cwd: string): Promise<string> {
	const target = path.join(cwd, "pixel.png");
	await Bun.write(target, Buffer.from(PNG_BASE64, "base64"));
	return target;
}

async function withWav(cwd: string): Promise<string> {
	const target = path.join(cwd, "sample.wav");
	const wav = Buffer.alloc(44);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36, 4);
	wav.write("WAVE", 8);
	wav.write("fmt ", 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24);
	wav.writeUInt32LE(16000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(0, 40);
	await Bun.write(target, wav);
	return target;
}

test("protolens read preserves native audio outside shell stdout", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-shell-audio-"));
	const owner = `read-shell-audio:${crypto.randomUUID()}`;
	try {
		const source = await withWav(dir);
		const session: ToolSession = {
			...readSession(dir, model({ id: "audio", input: ["text", "audio"] }), {
				"bash.autoBackground.enabled": false,
				"bash.direnv": "off",
			}),
			getSessionId: () => owner,
			getEvalSessionId: () => owner,
			getEvalKernelOwnerId: () => owner,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		await createTools(session, ["bash", "read"]);
		const bash = session.toolRegistry?.get("bash");
		if (!bash) throw new Error("bash tool was not created");
		const result = await bash.execute("native-audio", { command: "protolens read sample.wav", timeout: 10 });
		expect(result.isError).not.toBe(true);
		const audio = result.content.find(block => block.type === "audio");
		expect(audio).toEqual({
			type: "audio",
			mimeType: "audio/wav",
			data: (await fs.readFile(source)).toString("base64"),
		});
	} finally {
		await disposeBashSessions(owner);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 20_000);

test("video signatures are delivered natively even without a video filename extension", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-video-"));
	try {
		const bytes = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
		await Bun.write(path.join(dir, "clip.bin"), bytes);
		const tool = new ReadTool(readSession(dir, model({ id: "video", input: ["text", "video"] })));
		const result = await tool.execute("native-video", { path: "clip.bin" });
		expect(result.isError).not.toBe(true);
		expect(result.content.find(block => block.type === "video")).toEqual({
			type: "video",
			mimeType: "video/mp4",
			data: bytes.toString("base64"),
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("ordinary read decodes images inline for a vision model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-inline-vision-"));
	try {
		const vision = model({ id: "vision", input: ["text", "image"] });
		const tool = new ReadTool(readSession(dir, vision));
		await withPng(dir);

		const result = await tool.execute("t1", { path: "pixel.png" });
		const image = result.content.find((block): block is ImageContent => block.type === "image");
		expect(image).toBeDefined();
		expect(image?.data.length).toBeGreaterThan(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("ordinary read returns metadata and a simple notice for text-only image models", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-metadata-textonly-"));
	try {
		const textOnly = model({ id: "textonly", input: ["text"] });
		const tool = new ReadTool(readSession(dir, textOnly));
		await withPng(dir);

		const result = await tool.execute("t2", { path: "pixel.png" });
		const image = result.content.find(block => block.type === "image");
		expect(image).toBeUndefined();
		const text = result.content.find((block): block is TextContent => block.type === "text");
		expect(text?.text).toContain("Image metadata:");
		expect(text?.text).toContain("does not support image input");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("ordinary read returns native audio for an audio-capable model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-audio-native-"));
	try {
		const audio = model({ id: "audio", input: ["text", "audio"] });
		const tool = new ReadTool(readSession(dir, audio));
		await withWav(dir);

		const result = await tool.execute("t3", { path: "sample.wav" });
		const block = result.content.find((entry): entry is AudioContent => entry.type === "audio");
		expect(block).toBeDefined();
		expect(block?.mimeType).toBe("audio/wav");
		expect(block?.data.length).toBeGreaterThan(0);
		expect(result.isError).toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("local media URLs use the native audio loader", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-local-audio-"));
	try {
		const audio = model({ id: "audio", input: ["text", "audio"] });
		const session = readSession(dir, audio);
		session.localProtocolOptions = { getArtifactsDir: () => dir, getSessionId: () => "media-test" };
		await fs.mkdir(path.join(dir, "local"), { recursive: true });
		await withWav(path.join(dir, "local"));
		const tool = new ReadTool(session);

		const result = await tool.execute("t-local", { path: "local://sample.wav" });
		expect(result.content.some(block => block.type === "audio")).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("ordinary read reports unsupported audio without returning binary content", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-audio-unsupported-"));
	try {
		const textOnly = model({ id: "textonly", input: ["text"] });
		const tool = new ReadTool(readSession(dir, textOnly));
		await withWav(dir);

		const result = await tool.execute("t4", { path: "sample.wav" });
		expect(result.isError).toBe(true);
		expect(result.content.some(block => block.type === "audio" || block.type === "video")).toBe(false);
		const text = result.content.find((block): block is TextContent => block.type === "text");
		expect(text?.text).toContain("does not support audio input");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("read blocks ordinary image content when image submission is disabled", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-media-blocked-"));
	try {
		const vision = model({ id: "vision", input: ["text", "image"] });
		const tool = new ReadTool(readSession(dir, vision, { "images.blockImages": true }));
		await withPng(dir);

		const result = await tool.execute("t5", { path: "pixel.png" });
		const image = result.content.find(block => block.type === "image");
		expect(image).toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
