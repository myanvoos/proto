import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		getSessionId: () => `bash-cwd:${cwd}`,
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
		await disposeBashSessions(`bash-cwd:${dir}`);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("leading cd preserves PWD and OLDPWD just like an unoptimized shell command", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-state-"));
	try {
		await fs.mkdir(path.join(dir, "sub"));
		const bash = new BashTool(stubSession(dir));
		const command = `cd sub && printf 'PWD=%s OLDPWD=%s\\n' "$PWD" "$OLDPWD"`;
		const env = { CDPATH: "" };
		const result = await bash.execute("cd-state", { command, env });
		const control = await bash.execute("cd-state-control", { command: `:; ${command}`, env });
		expect(firstLine(control)).toBe(`PWD=${dir}/sub OLDPWD=${dir}`);
		expect(firstLine(result)).toBe(firstLine(control));
	} finally {
		await disposeBashSessions(`bash-cwd:${dir}`);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("leading cd leaves CDPATH lookup and output to the shell", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-cdpath-"));
	try {
		await fs.mkdir(path.join(dir, "search", "sub"), { recursive: true });
		const bash = new BashTool(stubSession(dir));
		const command = "cd sub && pwd";
		const env = { CDPATH: path.join(dir, "search") };
		const control = await bash.execute("cd-path-control", { command: `:; ${command}`, env });
		const result = await bash.execute("cd-path", { command, env });
		expect(result.details?.execution?.exitCode).toBe(control.details?.execution?.exitCode);
		expect(firstLine(result)).toBe(firstLine(control));
	} finally {
		await disposeBashSessions(`bash-cwd:${dir}`);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("leading cd retains logical symlink paths for a later relative cd", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-symlink-"));
	try {
		await fs.mkdir(path.join(dir, "real", "nested"), { recursive: true });
		await fs.symlink(path.join(dir, "real", "nested"), path.join(dir, "link"));
		const bash = new BashTool(stubSession(dir));
		const command = `cd link && printf '%s ' "$PWD" && cd .. && pwd`;
		const env = { CDPATH: "" };
		const control = await bash.execute("cd-link-control", { command: `:; ${command}`, env });
		expect(firstLine(control)).toBe(`${dir}/link ${dir}`);
		const result = await bash.execute("cd-link", { command, env });
		expect(result.details?.execution?.exitCode).toBe(control.details?.execution?.exitCode);
		expect(firstLine(result)).toBe(firstLine(control));
	} finally {
		await disposeBashSessions(`bash-cwd:${dir}`);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a failed leading cd remains a shell failure instead of a cwd validation error", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cwd-failure-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("cd-missing", {
			command: "cd missing && printf should-not-run",
			env: { CDPATH: "" },
		});
		expect(result.details?.exitCode).toBe(1);
		expect(firstLine(result)).toContain("cd:");
		expect(firstLine(result)).not.toContain("should-not-run");
	} finally {
		await disposeBashSessions(`bash-cwd:${dir}`);
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
		await disposeBashSessions(`bash-cwd:${dir}`);
		await fs.rm(dir, { recursive: true, force: true });
	}
});
