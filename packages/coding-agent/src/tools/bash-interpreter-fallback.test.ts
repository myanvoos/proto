import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "@oh-my-pi/pi-natives";

const python3 = Bun.which("python3");

test.skipIf(!python3)("invalid interpreter stdin reports an error instead of silently succeeding", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-encoded-stdin-"));
	try {
		await Bun.write(path.join(dir, "source.py"), new Uint8Array([0xff, 0x0a]));
		let output = "";
		const result = await executeShell(
			{ command: "python3 - < source.py", cwd: dir, timeoutMs: 5000, minimizer: { enabled: false } },
			(error, chunk) => {
				if (!error) output += chunk;
			},
		);
		expect(result.exitCode).toBe(1);
		expect(output).toContain("SyntaxError");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(!python3)("interpreter fallback searches the shell cwd for empty PATH components", async () => {
	if (!python3) throw new Error("python3 is required");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-interpreter-path-"));
	try {
		await fs.symlink(python3, path.join(dir, "python3"));
		await Bun.write(path.join(dir, "script.py"), "print('cwd-interpreter')\n");
		let output = "";
		const result = await executeShell(
			{
				command: "python3 script.py",
				cwd: dir,
				env: { PATH: ":" },
				timeoutMs: 5000,
				minimizer: { enabled: false },
			},
			(error, chunk) => {
				if (!error) output += chunk;
			},
		);
		expect(result.exitCode).toBe(0);
		expect(output.trim()).toBe("cwd-interpreter");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
