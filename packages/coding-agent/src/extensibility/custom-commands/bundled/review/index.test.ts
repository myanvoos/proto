import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { HookCommandContext } from "../../../hooks/types";
import type { CustomCommandAPI } from "../../types";
import { ReviewCommand } from "./index";

let root: string | undefined;

afterEach(async () => {
	if (root) await removeWithRetries(root);
	root = undefined;
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

test("reviews the live session cwd after the session moved away from the load-time cwd", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-review-cwd-"));
	const staleDir = path.join(root, "stale");
	const liveDir = path.join(root, "live");
	await Promise.all([fs.mkdir(staleDir), fs.mkdir(liveDir)]);
	await git(liveDir, "init", "-q");
	await git(liveDir, "config", "user.email", "test@example.com");
	await git(liveDir, "config", "user.name", "Test");
	await fs.writeFile(path.join(liveDir, "moved.txt"), "before\n");
	await git(liveDir, "add", "moved.txt");
	await git(liveDir, "commit", "-qm", "init");
	await fs.writeFile(path.join(liveDir, "moved.txt"), "after\n");

	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: liveDir,
		sessionManager: { getCwd: () => liveDir, getEntries: () => [], getBranch: () => [] },
		ui: {
			select: async (_title: string, options: string[]) => options.find(option => option.includes("uncommitted")),
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as HookCommandContext;
	const command = new ReviewCommand({ cwd: staleDir } as CustomCommandAPI);

	const prompt = await command.execute([], ctx);

	expect(notifications).toEqual([]);
	expect(prompt).toContain("moved.txt");
});
