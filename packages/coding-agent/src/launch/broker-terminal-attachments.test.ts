import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "./protocol";

interface AttachmentProbe {
	refused: string[];
	pendingRejection: string;
	firstSize: string;
	resized: string;
	freshScreen: string;
	observerScreen: string;
	confirmed: string;
	freshCursor: number;
	detachedCursor: number;
	effectiveSizes: string[];
	unintendedInput: boolean;
	samePidAfterDetach: boolean;
	samePidAfterDisconnect: boolean;
}

test.skipIf(process.platform === "win32")(
	"real broker PTY attachments revoke replaced control, preserve observers and detached processes, and redraw on reconnect",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-terminal-attachments-"));
		let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
		try {
			child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../../test/fixtures/daemon-terminal-attachments.ts"),
					dir,
				],
				{
					env: {
						...Bun.env,
						HOME: dir,
						PI_CODING_AGENT_DIR: path.join(dir, "agent"),
						[DAEMON_PROJECT_DIR_ENV]: dir,
						[DAEMON_RUNTIME_DIR_ENV]: path.join(dir, "run"),
						[DAEMON_IDLE_GRACE_ENV]: "60000",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 20_000,
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (exitCode !== 0) throw new Error(`Real terminal attachment fixture failed (${exitCode}): ${stderr}`);
			const result = JSON.parse(stdout) as AttachmentProbe;
			expect(result.refused).toEqual([
				"unleased-send",
				"stolen-resize",
				"read",
				"send",
				"terminal_resize",
				"terminal_detach",
				"stolen-read",
				"stolen-send",
				"detached-resize",
				"disconnected-resize",
			]);
			expect(result.pendingRejection).toContain("reattach");
			expect(result.firstSize).toContain("SIZE:first:90:30");
			expect(result.resized).toContain("SIZE:resized:111:37");
			expect(result.effectiveSizes).toEqual(["SIZE:minimum:20:5", "SIZE:maximum:400:200"]);
			expect(result.unintendedInput).toBe(false);
			expect(result.samePidAfterDetach).toBe(true);
			expect(result.samePidAfterDisconnect).toBe(true);
			expect(result.freshCursor).toBeGreaterThanOrEqual(result.detachedCursor);
			expect(result.freshScreen).toContain("SCREEN:");
			expect(result.freshScreen).not.toContain("before-detach");
			expect(result.observerScreen).toContain(":111:37");
			expect(result.observerScreen).not.toContain("before-detach");
			expect(result.confirmed).toContain("EVENT:after-reconnect");
		} finally {
			if (child?.exitCode === null) child.kill();
			await child?.exited;
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
	30_000,
);
