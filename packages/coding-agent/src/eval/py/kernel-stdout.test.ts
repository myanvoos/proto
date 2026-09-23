import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const kernelTest = availability.ok ? test : test.skip;
if (!availability.ok) console.warn("skipping python kernel stdout tests: no local Python interpreter");

async function run(kernel: PythonKernel, code: string): Promise<{ status: string; text: string }> {
	const chunks: string[] = [];
	const result = await kernel.execute(code, { onChunk: text => void chunks.push(text) });
	return { status: result.status, text: chunks.join("") };
}

describe("python kernel stdout proxy", () => {
	kernelTest("exposes the binary layer, a real fileno and the stream encoding", async () => {
		using tempDir = TempDir.createSync("@python-stdout-facets-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const { status, text } = await run(
				kernel,
				[
					"import sys",
					'print("P1 hasbuffer", hasattr(sys.stdout, "buffer"))',
					"try:",
					'    print("P2 fileno", sys.stdout.fileno())',
					"except Exception as exc:",
					'    print("P2 fileno raises", type(exc).__name__, exc)',
					'print("P5 encoding", sys.stdout.encoding, "isatty", sys.stdout.isatty())',
				].join("\n"),
			);
			expect(status).toBe("ok");
			expect(text).toContain("P1 hasbuffer True");
			expect(text).toContain("P2 fileno 1");
			expect(text).not.toContain("fileno raises");
			expect(text).toContain("P5 encoding utf-8 isatty False");
		} finally {
			await kernel.shutdown().catch(() => {});
		}
	});

	kernelTest("writes bytes through sys.stdout.buffer instead of crashing", async () => {
		using tempDir = TempDir.createSync("@python-stdout-binary-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const { status, text } = await run(
				kernel,
				[
					"import sys",
					'sys.stdout.buffer.write(b"BINSTART\\n")',
					"sys.stdout.buffer.write(bytes(range(256)) * 8)",
					'sys.stdout.buffer.write(b"\\n\\xff\\xfe invalid utf8 \\xc3\\x28\\n")',
					'sys.stdout.buffer.write(b"BINEND\\n")',
					"sys.stdout.buffer.flush()",
				].join("\n"),
			);
			expect(status).toBe("ok");
			expect(text).toContain("BINSTART");
			expect(text).toContain("BINEND");
			// Undecodable bytes stay visible rather than becoming U+FFFD.
			expect(text).toContain("\\xff");
			expect(text).toContain("invalid utf8");
		} finally {
			await kernel.shutdown().catch(() => {});
		}
	});

	kernelTest("keeps subprocess output that inherits the cell's fds in write order", async () => {
		using tempDir = TempDir.createSync("@python-stdout-order-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const { status, text } = await run(
				kernel,
				[
					"import subprocess, sys",
					'print("BEFORE")',
					'subprocess.run(["printf", "INHERITED\\\\n"])',
					'print("AFTER")',
				].join("\n"),
			);
			expect(status).toBe("ok");
			const order = ["BEFORE", "INHERITED", "AFTER"].map(marker => text.indexOf(marker));
			expect(order.every(index => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
		} finally {
			await kernel.shutdown().catch(() => {});
		}
	});

	kernelTest("keeps a display bundle ordered behind the text printed before it", async () => {
		using tempDir = TempDir.createSync("@python-stdout-display-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const { status, text } = await run(
				kernel,
				['print("TEXT BEFORE DISPLAY")', 'display("DISPLAYED VALUE")', 'print("TEXT AFTER DISPLAY")'].join("\n"),
			);
			expect(status).toBe("ok");
			const order = ["TEXT BEFORE DISPLAY", "DISPLAYED VALUE", "TEXT AFTER DISPLAY"].map(marker =>
				text.indexOf(marker),
			);
			expect(order.every(index => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
		} finally {
			await kernel.shutdown().catch(() => {});
		}
	});
});
