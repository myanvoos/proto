import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "./streaming-output";

async function withSixelPassthrough<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const previousAllow = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	try {
		return await fn();
	} finally {
		if (previousProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = previousProtocol;
		if (previousAllow === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = previousAllow;
	}
}

test("diagnostic summary preserves file, line, category, and message across chunk boundaries", async () => {
	const sink = new OutputSink({ spillThreshold: 64, headBytes: 0 });
	sink.push("noise before\nsrc/check.ts:17: error: actionable failure\n".slice(0, 23));
	sink.push("noise before\nsrc/check.ts:17: error: actionable failure\n".slice(23));
	sink.push("incidental output\n".repeat(20));
	const summary = await sink.dump();
	expect(summary.truncated).toBe(true);
	expect(summary.actionableDiagnostics).toContain("src/check.ts:17: error: actionable failure");
	expect(summary.output).toContain("ACTIONABLE DIAGNOSTICS");
	expect(summary.output).toContain("src/check.ts:17: error: actionable failure");
});

test("oversized diagnostic lines are skipped until their newline", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const oversized = `${"x".repeat(16 * 1024)} error: hidden tail`;
	const valid = "src/next.ts:8: error: retained diagnostic";

	sink.push(oversized.slice(0, 4096));
	sink.push(oversized.slice(4096));
	sink.push(`\n${valid}\n`);
	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([valid]);
	expect(summary.output).toContain(valid);
	expect(summary.output).not.toContain("hidden tail");
});

test("diagnostic byte limits stay UTF-8 correct across chunks", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const line = `error: ${"😀".repeat((16 * 1024 - 1 - 7) / 4)}`;
	const oneByteOver = `${line}x`;
	const chunkBoundary = "error: ".length + 2_000 * 2;

	expect(Buffer.byteLength(line, "utf-8")).toBe(16 * 1024 - 1);
	expect(Buffer.byteLength(oneByteOver, "utf-8")).toBe(16 * 1024);
	sink.push(line.slice(0, -2));
	sink.push(line.slice(-2));
	sink.push("\n");
	sink.push(oneByteOver.slice(0, chunkBoundary));
	sink.push(oneByteOver.slice(chunkBoundary));
	sink.push("\n");
	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([line]);
});

test("replace resets pending and oversized diagnostic state", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	sink.push(`${"x".repeat(16 * 1024)} error: stale tail`);
	sink.replace("replacement");
	sink.push("src/fresh.ts:3: error: fresh diagnostic\n");

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual(["src/fresh.ts:3: error: fresh diagnostic"]);
	expect(summary.output).not.toContain("stale tail");
});

test("complete diagnostics are deduplicated while retained", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const retained = "error: retained diagnostic";
	sink.push(`${retained}\n${retained}\n`);

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([retained]);
});

test("complete diagnostics stay within the FIFO byte budget", async () => {
	const sink = new OutputSink({ spillThreshold: 1 });
	const first = `error: ${"a".repeat(12_000)}`;
	const second = `warning: ${"b".repeat(7_000)}`;
	sink.push(`${first}\n${second}\n`);

	const summary = await sink.dump();

	expect(summary.actionableDiagnostics).toEqual([second]);
});

test("diagnostic collection leaves raw artifact bytes unchanged", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-artifact-"));
	const artifactPath = path.join(directory, "raw-output.log");
	const oversized = `${"😀".repeat(9_000)} error: hidden artifact tail`;
	const valid = "src/subsequent.ts:4: error: retained artifact diagnostic";
	const raw = `${oversized}\n${valid}\n`;

	try {
		const sink = new OutputSink({ artifactPath, artifactId: "raw-output", spillThreshold: 1 });
		sink.push(oversized);
		sink.push(`\n${valid}\n`);
		const summary = await sink.dump();

		expect(summary.actionableDiagnostics).toEqual([valid]);
		expect(await fs.readFile(artifactPath, "utf8")).toBe(raw);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("summarized output has an explicit summarized disposition", async () => {
	const sink = new OutputSink({ spillThreshold: 64 });
	sink.replace("compact summary", { summarized: true });
	const summary = await sink.dump();
	expect(summary.outputDisposition).toBe("summarized");
	expect(summary.summarized).toBe(true);
});

test("collector failure with no retained bytes is explicitly unavailable", async () => {
	const sink = new OutputSink({
		spillThreshold: 0,
		artifactPath: "/dev/null/proto-output.log",
		artifactId: "missing",
	});
	sink.push("unavailable output");
	const summary = await sink.dump();
	expect(summary.collector?.state).toBe("failed");
	expect(summary.outputDisposition).toBe("unavailable");
});

test("flushes an unterminated sixel tail into accounted output", async () => {
	await withSixelPassthrough(async () => {
		const sink = new OutputSink({ spillThreshold: 1024 });
		sink.push("before\x1bPqPAY");
		const summary = await sink.dump();

		expect(summary.output).toBe("before\x1bPqPAY");
		expect(summary.totalBytes).toBe(Buffer.byteLength("before\x1bPqPAY", "utf-8"));
		expect(summary.outputDisposition).toBe("complete");
	});
});

test("holds a split sixel introducer until its terminator arrives", async () => {
	await withSixelPassthrough(async () => {
		const sink = new OutputSink({ spillThreshold: 1024 });
		sink.push("before\x1b");
		sink.push("PqPAY\x9cafter");
		const summary = await sink.dump();

		expect(summary.output).toBe("before\x1bPqPAY\x9cafter");
	});
});

test("bounds an unterminated sixel tail and reports truncation", async () => {
	await withSixelPassthrough(async () => {
		const sink = new OutputSink({ spillThreshold: 1024 });
		sink.push("\x1bPq");
		for (let index = 0; index < 6_000; index++) sink.push("x".repeat(1_000));
		const summary = await sink.dump();

		expect(summary.totalBytes).toBeGreaterThan(6_000_000);
		expect(summary.truncated).toBe(true);
		expect(summary.output.length).toBeLessThanOrEqual(1_024);
	});
});

test("column caps preserve a complete sixel envelope", async () => {
	await withSixelPassthrough(async () => {
		const sixel = "\x1bPq123456789012345\x1b\\";
		const sink = new OutputSink({ spillThreshold: 1024, maxColumns: 10 });
		sink.push(`A${sixel}Z\nSAFE\n`);
		const summary = await sink.dump();

		expect(summary.output).toBe(`A${sixel}Z\nSAFE\n`);
		expect(summary.output).not.toContain("…");
	});
});

test("replace clears a pending sixel tail", async () => {
	await withSixelPassthrough(async () => {
		const sink = new OutputSink({ spillThreshold: 1024 });
		sink.push("old\x1bPqPAY");
		sink.replace("new");
		sink.push("\x9c");
		const summary = await sink.dump();

		expect(summary.output).toBe("new");
		expect(summary.output).not.toContain("old");
	});
});

test("passthrough accounting uses sanitized ordinary bytes", async () => {
	await withSixelPassthrough(async () => {
		const ansi = new OutputSink({ spillThreshold: 1024, headBytes: 256 });
		ansi.push("\x1b[31mred\x1b[0m");
		const ansiSummary = await ansi.dump();
		expect(ansiSummary.output).toBe("red");
		expect(ansiSummary.totalBytes).toBe(3);
		expect(ansiSummary.truncated).toBe(false);
		expect(ansiSummary.output).not.toContain("elided");

		const crlf = new OutputSink({ spillThreshold: 1024, headBytes: 256 });
		crlf.push("a\r\nb");
		const crlfSummary = await crlf.dump();
		expect(crlfSummary.output).toBe("a\nb");
		expect(crlfSummary.totalBytes).toBe(3);
		expect(crlfSummary.truncated).toBe(false);
	});
});

test("normalizes carriage returns around an unterminated sixel tail", async () => {
	await withSixelPassthrough(async () => {
		const beforeTail = new OutputSink({ spillThreshold: 1024 });
		beforeTail.push("a\r\x1bPqPAY");
		const beforeSummary = await beforeTail.dump();
		expect(beforeSummary.output).toBe("a\n\x1bPqPAY");

		const afterTail = new OutputSink({ spillThreshold: 1024 });
		afterTail.push("a\x1bPqPAY\r");
		const afterSummary = await afterTail.dump();
		expect(afterSummary.output).toBe("a\x1bPqPAY\n");
	});
});

test("bounded held sixel tails still trigger artifact spill", async () => {
	await withSixelPassthrough(async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-sixel-"));
		const artifactPath = path.join(directory, "raw-output.log");
		try {
			const sink = new OutputSink({ artifactPath, artifactId: "sixel-output", spillThreshold: 4 });
			sink.push(`\x1bPq${"x".repeat(100)}`);
			const summary = await sink.dump();

			expect(summary.truncated).toBe(true);
			expect(summary.artifactId).toBe("sixel-output");
			expect(await fs.readFile(artifactPath, "utf8")).toBe("xxxx");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
