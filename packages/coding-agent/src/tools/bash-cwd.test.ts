import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
	} as unknown as ToolSession;
}

function firstLine(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("")
			.split("\n", 1)[0] ?? ""
	);
}

test("a leading `cd /` and an explicit cwd of `/` run at the filesystem root, not the session cwd", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-root-"));
	try {
		const bash = new BashTool(stubSession(dir));
		expect(firstLine(await bash.execute("cd-root", { command: "cd / && pwd" }))).toBe("/");
		expect(firstLine(await bash.execute("cwd-root", { command: "pwd", cwd: "/" }))).toBe("/");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("relative and tilde cwd values resolve against the session cwd and the home directory", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-rel-"));
	const sub = path.join(dir, "sub");
	await fs.mkdir(sub);
	try {
		const bash = new BashTool(stubSession(dir));
		expect(await fs.realpath(firstLine(await bash.execute("cwd-rel", { command: "pwd", cwd: "sub" })))).toBe(
			await fs.realpath(sub),
		);
		expect(await fs.realpath(firstLine(await bash.execute("cd-rel", { command: "cd sub && pwd" })))).toBe(
			await fs.realpath(sub),
		);
		expect(firstLine(await bash.execute("cwd-home", { command: "pwd", cwd: "~" }))).toBe(os.homedir());
		await expect(bash.execute("cwd-missing", { command: "pwd", cwd: "missing" })).rejects.toThrow(
			`Working directory does not exist: ${path.join(dir, "missing")}`,
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
