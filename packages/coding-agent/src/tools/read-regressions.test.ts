import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { DEFAULT_MAX_BYTES } from "../session/streaming-output";
import type { ToolSession } from ".";
import { formatOutputNotice, wrapToolWithMetaNotice } from "./output-meta";
import { ReadTool } from "./read";

type SettingsKey = string;

const settingsValues: Record<SettingsKey, unknown> = {
	"images.autoResize": false,
	"read.defaultLimit": 200,
	readLineNumbers: false,
	"read.renderMarkdown": false,
	"read.summarize.enabled": false,
	"fetch.enabled": true,
	"bashInterceptor.enabled": false,
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"kernel.speculation.enabled": false,
	"kernel.assertPreflight.enabled": false,
	"bash.direnv": "off",
	"tools.maxTimeout": 300,
	"tools.outputMaxColumns": 0,
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

function readSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: SettingsKey) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-regressions",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

async function withReadSession(run: (read: ReadTool, root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-regressions-"));
	try {
		await run(new ReadTool(readSession(root)), root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("multi-range reads surface the same truncation boundary as single-range reads", async () => {
	await withReadSession(async (read, root) => {
		const lines = Array.from(
			{ length: 50_000 },
			(_, index) => `${String(index + 1).padStart(5, "0")}-${"x".repeat(100)}`,
		);
		const file = path.join(root, "large.txt");
		await Bun.write(file, `${lines.join("\n")}\n`);

		const result = await read.execute("multi-range-truncation", { path: "large.txt:1-4000,49999-50000" });
		const text = textOf(result);

		expect(text).toContain("0001-");
		expect(text).toContain("3000-");
		expect(text).not.toContain("3001-");
		expect(text).toContain("Use :3001 to continue");
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.meta?.truncation?.truncatedBy).toBe("lines");
		expect(result.details?.meta?.truncation?.shownRange).toEqual({ start: 1, end: 3000 });

		const controller = new AbortController();
		controller.abort();
		await expect(
			read.execute("multi-range-abort", { path: "large.txt:1-4000,49999-50000" }, controller.signal),
		).rejects.toThrow();

		const wideLines = Array.from({ length: 5_000 }, (_, index) => `${index + 1}-${"w".repeat(1_000)}`);
		await Bun.write(path.join(root, "wide.txt"), `${wideLines.join("\n")}\n`);
		const wideResult = await read.execute("multi-range-byte-truncation", { path: "wide.txt:1-5000,4999-5000" });
		expect(wideResult.details?.truncation?.truncated).toBe(true);
		expect(wideResult.details?.truncation?.truncatedBy).toBe("bytes");
	});
});

test("large single-range reads honor an already-aborted signal", async () => {
	await withReadSession(async (read, root) => {
		const file = path.join(root, "large.txt");
		await Bun.write(file, `${"x".repeat(4 * 1024 * 1024)}\nsecond\n`);
		const controller = new AbortController();
		controller.abort();

		await expect(read.execute("aborted-large-read", { path: "large.txt:2-2" }, controller.signal)).rejects.toThrow();
	});
});

test("non-raw reads reject invalid UTF-8 after the sniff window", async () => {
	await withReadSession(async (read, root) => {
		const file = path.join(root, "invalid.txt");
		const prefix = Buffer.from(`${"a".repeat(9_000)}\n`);
		await Bun.write(file, Buffer.concat([prefix, Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));

		const result = await read.execute("invalid-utf8", { path: "invalid.txt:2-2" });
		const text = textOf(result);
		expect(text).toContain("Cannot read binary file");
		expect(text).not.toContain("�");

		const rawResult = await read.execute("invalid-utf8-raw", { path: "invalid.txt:raw" });
		expect(textOf(rawResult)).toContain("Cannot read binary file");

		const largeBinary = path.join(root, "large-binary.bin");
		await Bun.write(
			largeBinary,
			Buffer.concat([Buffer.from(`${"a".repeat(4 * 1024 * 1024)}\n`), Buffer.from([0]), Buffer.from("\n")]),
		);
		const largeBinaryResult = await read.execute("large-binary", { path: "large-binary.bin:2-2" });
		expect(textOf(largeBinaryResult)).toContain("Cannot read binary file");
	});
});

test("CRLF line endings are normalized before non-raw content reaches the model", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "crlf.txt"), "first\r\nsecond\r\nlast");
		const result = await read.execute("crlf-read", { path: "crlf.txt:1-3" });
		expect(textOf(result)).toBe("first\nsecond\nlast");
	});
});

test("oversized first lines retain the real byte limit in truncation metadata", async () => {
	await withReadSession(async (read, root) => {
		await Bun.write(path.join(root, "long-line.txt"), `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\nnext\n`);
		const result = await read.execute("long-first-line", { path: "long-line.txt:1-2" });
		const notice = formatOutputNotice(result.details?.meta);
		const text = textOf(result);

		expect(text.length).toBe(DEFAULT_MAX_BYTES);
		expect(result.details?.truncation?.outputBytes).toBe(0);
		expect(result.details?.truncation?.totalBytes).toBe(DEFAULT_MAX_BYTES + 1);
		expect(notice).toContain("50.0KB limit");
		expect(notice).not.toContain("0B limit");
		expect(notice).not.toContain("lines 1-0");

		const multi = await read.execute("long-first-line-multi", { path: "long-line.txt:1-2,2-2" });
		expect(multi.details?.truncation?.firstLineExceedsLimit).toBe(true);
		expect(multi.details?.truncation?.totalBytes).toBe(DEFAULT_MAX_BYTES + 1);
	});
});

test("spilling oversized results keeps text and image blocks interleaved", async () => {
	const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const content: Array<TextContent | ImageContent> = [
		{ type: "text", text: `before ${"x".repeat(8_000)}` },
		image,
		{ type: "text", text: "after" },
	];
	const tool: AgentTool = {
		name: "interleave",
		label: "Interleave",
		description: "test",
		parameters: {} as AgentTool["parameters"],
		strict: true,
		execute: async (): Promise<AgentToolResult> => ({ content }),
	};
	const settings = {
		get: (key: SettingsKey) =>
			({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 100,
				"tools.artifactHeadBytes": 0,
			})[key],
	};
	const wrapped = wrapToolWithMetaNotice(tool);
	const result = await wrapped.execute("interleave", {}, undefined, undefined, {
		settings,
		sessionManager: { saveArtifact: async () => "artifact-1" },
	} as unknown as AgentToolContext);

	expect(result.content[0]?.type).toBe("text");
	expect(result.content[1]).toEqual(image);
	const trailingText = result.content[2];
	expect(trailingText?.type).toBe("text");
	if (trailingText?.type === "text") expect(trailingText.text).toContain("Showing");
});
