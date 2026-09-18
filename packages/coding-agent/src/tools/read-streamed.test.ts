import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from ".";
import { ReadTool } from "./read";

const settingsValues: Record<string, unknown> = {
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
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

function readSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: string) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-streamed",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

test("streamed newline-terminated reads count every finalized line at EOF", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-streamed-"));
	try {
		await Bun.write(path.join(root, "large.txt"), `${"a".repeat(4 * 1024 * 1024)}\nb\n`);
		const read = new ReadTool(readSession(root));

		const finalLine = await read.execute("streamed-final-line", { path: "large.txt:2-2" });
		expect(textOf(finalLine)).toBe("b");
		expect(finalLine.details?.totalLines).toBe(2);
		expect(finalLine.details?.displayContent).toEqual({ text: "b", startLine: 2, lineNumbers: [2] });

		const beyondEof = await read.execute("streamed-beyond-eof", { path: "large.txt:3-3" });
		expect(textOf(beyondEof)).toBe(
			"Line 3 is beyond end of file (2 lines total). Use :1 to read from the start, or :2 to read the last line.",
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
