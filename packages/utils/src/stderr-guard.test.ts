import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GUARD_MODULE = path.resolve(import.meta.dir, "stderr-guard.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

// Runs in a PTY subprocess so the suite's own fd 2 is never mutated.
test("redirects same-terminal fd-2 writes by default and restores them", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
	tempDirs.push(dir);
	const redirectPath = path.join(dir, "redirect.log");
	const probePath = path.join(dir, "terminal-probe.ts");
	fs.writeFileSync(
		probePath,
		[
			`import { restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
			`import * as fs from "node:fs";`,
			`const redirected = suppressTerminalStderr({ redirectPath: process.argv[2] });`,
			`process.stdout.write(JSON.stringify({ redirected }) + "\\n");`,
			`fs.writeSync(2, "redirected\\n");`,
			`restoreTerminalStderr();`,
			`fs.writeSync(2, "restored\\n");`,
		].join("\n"),
	);

	const chunks: Buffer[] = [];
	const terminalExited = Promise.withResolvers<void>();
	const proc = Bun.spawn([process.execPath, probePath, redirectPath], {
		terminal: {
			data(_terminal, data) {
				chunks.push(Buffer.from(data));
			},
			exit() {
				terminalExited.resolve();
			},
		},
		timeout: 10_000,
	});
	const exitCode = await proc.exited;
	await terminalExited.promise;
	proc.terminal?.close();

	expect(exitCode).toBe(0);
	const output = Buffer.concat(chunks).toString("utf8").replaceAll("\r\n", "\n");
	expect(output).toBe('{"redirected":true}\nrestored\n');
	expect(fs.readFileSync(redirectPath, "utf8")).toBe("redirected\n");
});

test("follows the rotating sink's active file while suppressed and only records it after restore", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-"));
	tempDirs.push(dir);
	const [first, second, third] = ["first.log", "second.log", "third.log"].map(name => path.join(dir, name));
	const probePath = path.join(dir, "rotation-probe.ts");
	fs.writeFileSync(
		probePath,
		[
			`import { restoreTerminalStderr, setStderrRedirectTarget, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
			`import * as fs from "node:fs";`,
			`const [first, second, third] = process.argv.slice(2);`,
			`setStderrRedirectTarget(first);`,
			`suppressTerminalStderr({ force: true });`,
			`fs.writeSync(2, "first-marker\\n");`,
			`setStderrRedirectTarget(second);`,
			`fs.writeSync(2, "second-marker\\n");`,
			`restoreTerminalStderr();`,
			`setStderrRedirectTarget(third);`,
			`fs.writeSync(2, "restored\\n");`,
		].join("\n"),
	);

	const proc = Bun.spawn([process.execPath, probePath, first, second, third], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10_000,
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

	expect(exitCode).toBe(0);
	expect(fs.readFileSync(first, "utf8")).toBe("first-marker\n");
	expect(fs.readFileSync(second, "utf8")).toBe("second-marker\n");
	expect(fs.existsSync(third)).toBe(false);
	expect(stderr).toBe("restored\n");
});
