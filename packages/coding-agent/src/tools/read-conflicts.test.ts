import { afterEach, beforeEach, expect, test } from "bun:test";
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
};

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "read-conflicts-"));
	await Bun.write(
		path.join(root, "merge.txt"),
		"head\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature\ntail\n",
	);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function readTool(activeTools: readonly string[]): ReadTool {
	const active = new Set(activeTools);
	return new ReadTool({
		cwd: root,
		settings: {
			get: (key: string) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-conflicts",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: (name: string) => active.has(name),
	} as unknown as ToolSession);
}

async function readText(tool: ReadTool, readPath: string): Promise<string> {
	const result = await tool.execute("read-conflicts", { path: readPath });
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

for (const selector of ["merge.txt", "merge.txt:conflicts"]) {
	test(`${selector} directs resolution through bash when the session has no write tool`, async () => {
		const text = await readText(readTool(["read", "bash"]), selector);
		expect(text).toContain("Resolve a conflict by editing `merge.txt` with `bash`");
		expect(text).not.toContain("write(");
		expect(text).not.toContain("conflict://*");
	});
}

test("the conflict notice names no tool the session lacks", async () => {
	const text = await readText(readTool(["read"]), "merge.txt:conflicts");
	expect(text).toContain("Resolve a conflict by editing `merge.txt`:");
	expect(text).not.toContain("`bash`");
	expect(text).not.toContain("write(");
});

test("conflict ids surfaced by a read resolve to their recorded block", async () => {
	const tool = readTool(["read", "bash"]);
	expect(await readText(tool, "merge.txt:conflicts")).toContain("#1  L2-6");
	expect(await readText(tool, "conflict://1/theirs")).toBe("theirs line");
	await expect(readText(tool, "conflict://*")).rejects.toThrow("`<path>:conflicts` read selector");
});
