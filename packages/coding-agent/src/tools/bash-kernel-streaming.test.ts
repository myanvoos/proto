import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { ToolAbortError } from "./tool-errors";

async function fixture(run: (bash: BashTool, cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-streaming-"));
	const owner = `kernel-streaming-${crypto.randomUUID()}`;
	const session = {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession;
	try {
		await run(new BashTool(session), cwd);
	} finally {
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

for (const language of ["python", "node", "bun"] as const) {
	const flag = language === "python" ? "-c" : "-e";
	const cell = (source: string): string => `${language} ${flag} '${source.replaceAll("'", "'\"'\"'")}'`;

	test(`${language} consumes its first line before the producer can finish`, async () => {
		await fixture(async bash => {
			// No timing threshold: the producer cannot emit EOF until the consumer
			// has read the first line and acknowledged it. Eager stdin collection deadlocks.
			const code =
				language === "python"
					? 'import sys; from pathlib import Path; first = sys.stdin.readline(); Path("ack").write_text("ok"); print(first.strip() + ":" + sys.stdin.read().strip())'
					: 'import { writeFileSync } from "node:fs"; let input = "", acknowledged = false; for await (const chunk of process.stdin) { input += chunk; if (!acknowledged && input.includes("\\n")) { writeFileSync("ack", "ok"); acknowledged = true; } } console.log(input.trim().replace("\\n", ":"));';
			const producer = `sh -c 'printf "first\\n"; while [ ! -f ack ]; do sleep 0.01; done; printf "second\\n"'`;
			const result = await bash.execute("live-input", { command: `${producer} | ${cell(code)}`, timeout: 8 });
			expect(result.details?.timedOut).not.toBe(true);
			expect(result.isError).not.toBe(true);
			expect(text(result)).toContain("first:second");
		});
	}, 20_000);

	test(`${language} streams more than one MiB losslessly through pipes and retains state`, async () => {
		await fixture(async (bash, cwd) => {
			const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 256);
			await Bun.write(path.join(cwd, "input.bin"), bytes);
			const seed = language === "python" ? "stream_marker = 41" : "globalThis.stream_marker = 41";
			expect((await bash.execute("seed", { command: `${language} <<'CELL'\n${seed}\nCELL` })).isError).not.toBe(
				true,
			);
			const code =
				language === "python"
					? "import sys\nassert stream_marker == 41\nwhile chunk := sys.stdin.buffer.read(32768):\n    sys.stdout.buffer.write(chunk)"
					: 'import { once } from "node:events"; if (stream_marker !== 41) throw Error("lost state"); for await (const chunk of process.stdin) { if (!process.stdout.write(chunk)) await once(process.stdout, "drain"); }';
			const result = await bash.execute("copy", {
				command: `cat input.bin | ${cell(code)} | cat > copy.bin`,
				timeout: 15,
			});
			expect(result.isError).not.toBe(true);
			expect(result.details?.timedOut).not.toBe(true);
			expect(new Uint8Array(await Bun.file(path.join(cwd, "copy.bin")).arrayBuffer())).toEqual(bytes);
			const after = language === "python" ? "print(stream_marker + 1)" : "console.log(stream_marker + 1)";
			expect(text(await bash.execute("after", { command: cell(after) }))).toContain("42");
		});
	}, 30_000);

	test(`${language} preserves NUL and invalid UTF-8 on stdout and stderr redirections`, async () => {
		await fixture(async (bash, cwd) => {
			const code =
				language === "python"
					? "import os,sys; sys.stdout.buffer.write(bytes([0,65,128,255,10])); _ = os.write(2, bytes([255,0,128,66,10]))"
					: "process.stdout.write(Buffer.from([0,65,128,255,10])); void process.stderr.write(Buffer.from([255,0,128,66,10]));";
			const result = await bash.execute("binary", { command: `${cell(code)} > out.bin 2> err.bin` });
			expect(result.isError).not.toBe(true);
			expect(new Uint8Array(await Bun.file(path.join(cwd, "out.bin")).arrayBuffer())).toEqual(
				new Uint8Array([0, 65, 128, 255, 10]),
			);
			expect(new Uint8Array(await Bun.file(path.join(cwd, "err.bin")).arrayBuffer())).toEqual(
				new Uint8Array([255, 0, 128, 66, 10]),
			);
		});
	}, 20_000);

	test(`${language} closes upstream input when the cell exits early`, async () => {
		await fixture(async bash => {
			const code =
				language === "python"
					? "import sys; print(sys.stdin.readline().strip())"
					: 'for await (const chunk of process.stdin) { console.log(chunk.toString().split("\\n")[0]); break; }';
			const result = await bash.execute("early-input", {
				command: `set +o pipefail; yes early | ${cell(code)}`,
				timeout: 8,
			});
			expect(result.details?.timedOut).not.toBe(true);
			expect(result.isError).not.toBe(true);
			expect(text(result)).toContain("early");
		});
	}, 20_000);

	test(`${language} interrupts a cell blocked on live input without waiting for producer EOF`, async () => {
		await fixture(async bash => {
			const abort = new AbortController();
			const code =
				language === "python"
					? 'import sys; sys.stdin.readline(); print("WAITING", flush=True); sys.stdin.read()'
					: 'for await (const chunk of process.stdin) { console.log("WAITING"); }';
			const running = bash.execute(
				"interrupt-input",
				{
					command: `sh -c 'printf "first\\n"; sleep 60' | ${cell(code)}`,
					timeout: 10,
				},
				abort.signal,
				update => {
					if (text(update).includes("WAITING")) abort.abort();
				},
			);
			await expect(running).rejects.toBeInstanceOf(ToolAbortError);
			expect(abort.signal.aborted).toBe(true);
			const next = await bash.execute("after-interrupt", {
				command: cell(language === "python" ? 'print("resumed")' : 'console.log("resumed")'),
			});
			expect(next.isError).not.toBe(true);
			expect(text(next)).toContain("resumed");
		});
	}, 25_000);

	test(`${language} cancels a live producer when its output consumer exits`, async () => {
		await fixture(async bash => {
			const code =
				language === "python"
					? 'import sys\nwhile True:\n    sys.stdout.buffer.write(b"x" * 32768)'
					: 'import { once } from "node:events"; while (true) { if (!process.stdout.write(Buffer.alloc(32768, 120))) await once(process.stdout, "drain"); }';
			const result = await bash.execute("early-output", {
				command: `set +o pipefail; ${cell(code)} | head -c 1`,
				timeout: 8,
			});
			expect(result.details?.timedOut).not.toBe(true);
			expect(text(result)).toContain("x");
			const next = await bash.execute("usable", {
				command: cell(language === "python" ? 'print("usable")' : 'console.log("usable")'),
			});
			expect(next.isError).not.toBe(true);
			expect(text(next)).toContain("usable");
		});
	}, 25_000);
}
