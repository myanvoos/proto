import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui/editor-limits";

test("clipboard command output is rejected at the byte ceiling without returning a truncated paste", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-clipboard-limit-"));
	try {
		const command = path.join(directory, "wl-paste");
		await Bun.write(
			command,
			`#!${process.execPath}\nprocess.stdout.write("x".repeat(${EDITOR_LIMITS.draftBytes + 1}));\n`,
		);
		await fs.chmod(command, 0o755);
		const source = `import { readTextFromClipboard } from ${JSON.stringify(path.join(import.meta.dir, "clipboard.ts"))};
try { await readTextFromClipboard(); process.exitCode = 2; } catch (error) { if (!(error instanceof RangeError)) throw error; process.stdout.write(error.message); }`;
		const proc = Bun.spawn([process.execPath, "--eval", source], {
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
				WAYLAND_DISPLAY: "clipboard-test",
				DISPLAY: "",
				TERMUX_VERSION: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain(String(EDITOR_LIMITS.draftBytes));
		expect(stdout).toContain("not pasted");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
