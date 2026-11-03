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

test("registered conflicts follow moved blocks and retire after resolution", async () => {
	const tool = readTool(["read", "bash"]);
	await readText(tool, "merge.txt:conflicts");
	const file = path.join(root, "merge.txt");
	const original = await Bun.file(file).text();
	await Bun.write(file, `preface\n${original}`);
	expect(await readText(tool, "conflict://1/theirs:1-1:raw")).toBe("theirs line");
	await Bun.write(file, "resolved\n");
	await expect(readText(tool, "conflict://1/theirs")).rejects.toThrow("was resolved");
});

test("a changed conflict never inherits a stale id at the same source line", async () => {
	const tool = readTool(["read"]);
	await readText(tool, "merge.txt:conflicts");
	const file = path.join(root, "merge.txt");
	await Bun.write(file, (await Bun.file(file).text()).replace("ours line", "new ours"));
	expect(await readText(tool, "merge.txt:conflicts")).toContain("#2");
	await expect(readText(tool, "conflict://1")).rejects.toThrow("#2 in merge.txt");
});

test("raw conflict reads return only selected source lines without synthetic conflict notices", async () => {
	const tool = readTool(["read"]);
	expect(await readText(tool, "merge.txt:2-6:raw")).toBe(
		"<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature",
	);
	expect(await readText(tool, "conflict://1/ours:raw")).toBe("ours line");
});

test("column-capped streamed conflict sides do not overwrite registered complete sides", async () => {
	const tool = readTool(["read"]);
	const file = path.join(root, "merge.txt");
	const ours = "O".repeat(80_000);
	await Bun.write(file, `<<<<<<< HEAD\n${ours}\n=======\ntheirs\n>>>>>>> feature\n${"F".repeat(4 * 1024 * 1024)}\n`);
	await readText(tool, "merge.txt:conflicts");
	// Default output columns are capped; the displayed side is only a retained prefix.
	const display = await readText(tool, "merge.txt:1-5");
	expect(display).toContain("…");
	expect(await readText(tool, "conflict://1/ours:1-1:raw")).toBe(ours.slice(0, 50 * 1024));
});
