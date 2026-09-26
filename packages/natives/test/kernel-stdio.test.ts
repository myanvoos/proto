import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getNativeAddonPath } from "../native/loader-state.js";

interface Control {
	type: string;
	runId?: string;
	sequence?: number;
	message?: string;
	before?: number;
	after?: number;
	childAlive?: boolean;
}

interface Frame {
	type: "native-stdio";
	runId: string;
	stream: "stdout" | "stderr";
	data: string;
	sequence: number;
}

const fixture = path.join(import.meta.dir, "fixtures/kernel-stdio.mjs");
const runtimes = [process.execPath, Bun.which("node")].filter((value): value is string => value !== null);

function spawnFixture(runtime: string, mode: string, onControl?: (control: Control) => void) {
	const controls: Control[] = [];
	const child = Bun.spawn([runtime, fixture, mode], {
		env: { ...process.env, PROTO_TEST_NATIVE_ADDON: getNativeAddonPath() },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		serialization: "json",
		ipc(message) {
			controls.push(message as Control);
			onControl?.(message as Control);
		},
		signal: AbortSignal.timeout(15_000),
	});
	const stderr = new Response(child.stderr).text();
	return { child, controls, stderr };
}

async function collectFixture(runtime: string, mode: string) {
	const { child, controls, stderr } = spawnFixture(runtime, mode);
	try {
		const stdout = await new Response(child.stdout).text();
		const exitCode = await child.exited;
		const errors = await stderr;
		expect(exitCode, errors).toBe(0);
		return { stdout, stderr: errors, controls };
	} finally {
		child.kill();
	}
}

function framesFrom(stdout: string): Frame[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Frame)
		.filter(frame => frame.type === "native-stdio");
}

function bytesFor(frames: Frame[], runId: string, stream: "stdout" | "stderr"): Buffer {
	return Buffer.concat(
		frames
			.filter(frame => frame.runId === runId && frame.stream === stream)
			.map(frame => Buffer.from(frame.data, "base64")),
	);
}

// Capture always runs in a fixture child: this suite never replaces the test runner's descriptors.
for (const runtime of runtimes) {
	describe(`native kernel stdio (${path.basename(runtime)})`, () => {
		test("preserves arbitrary bytes and the interpreter's native console formatting behind fences", async () => {
			const baseline = await collectFixture(runtime, "baseline");
			const result = await collectFixture(runtime, "capture");
			const frames = framesFrom(result.stdout);
			expect(bytesFor(frames, "binary", "stdout")).toEqual(
				Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
			);
			expect(bytesFor(frames, "binary", "stderr")).toEqual(Buffer.from([0, 255, 10, 13, 128]));
			expect(bytesFor(frames, "console", "stdout").toString()).toBe(baseline.stdout);
			expect(bytesFor(frames, "console", "stderr").toString()).toBe(baseline.stderr);
			expect(frames.map(frame => frame.sequence)).toEqual(frames.map((_, index) => index + 1));
			for (const fence of result.controls.filter(control => control.type === "fence")) {
				const preceding = frames.filter(frame => frame.runId === fence.runId);
				expect(Math.max(...preceding.map(frame => frame.sequence))).toBe(fence.sequence!);
			}
			expect(result.controls.find(control => control.type === "ownership")?.message).toContain("already owns");
			expect(result.stdout.endsWith('{"type":"restored"}\n')).toBe(true);
			expect(result.stderr).toBe("restored stderr\n");
		});

		test("retains descendant and nested callback ownership after the originating run finishes", async () => {
			const result = await collectFixture(runtime, "lifetime");
			const frames = framesFrom(result.stdout);
			expect(bytesFor(frames, "first", "stdout").toString()).toBe(
				"first-before\nfirst-nested\nfirst-same-owner\nchild-late",
			);
			expect(bytesFor(frames, "first", "stderr").toString()).toBe("retained-stderr\nchild-stderr");
			expect(bytesFor(frames, "second", "stdout").toString()).toBe("second-before\nsecond-after\n");
			expect(bytesFor(frames, "second", "stderr").toString()).toBe("second-stderr\n");
			const finalFence = result.controls.find(control => control.type === "final-fence")?.sequence;
			expect(finalFence).toBe(frames.at(-1)?.sequence);
			expect(result.stderr).toBe("");
		});

		test("applies OS backpressure without dropping bytes or waiting for the kernel JS event loop", async () => {
			const writing = Promise.withResolvers<void>();
			let written = false;
			const { child, controls, stderr } = spawnFixture(runtime, "backpressure", control => {
				if (control.type === "writing") writing.resolve();
				if (control.type === "written") written = true;
			});
			try {
				await writing.promise;
				// No host reads: a bounded pipe must stall the child's synchronous write loop.
				// Real-process negative check: fake timers cannot advance native threads or OS pipe writes.
				await Bun.sleep(100);
				expect(written).toBe(false);
				const stdout = await new Response(child.stdout).text();
				expect(await child.exited, await stderr).toBe(0);
				const frames = framesFrom(stdout);
				const bytes = bytesFor(frames, "flood", "stdout");
				expect(bytes).toEqual(Buffer.alloc(8 * 1024 * 1024, 120));
				expect(controls.find(control => control.type === "written")?.sequence).toBe(frames.at(-1)?.sequence);
			} finally {
				child.kill();
			}
		});

		test("returns a finite flush fence while inherited writers are still producing bytes", async () => {
			const result = await collectFixture(runtime, "continuous");
			const frames = framesFrom(result.stdout);
			const fence = result.controls.find(control => control.type === "live-barrier")!;
			expect(fence.childAlive).toBe(true);
			const fencedBytes = bytesFor(
				frames.filter(frame => frame.sequence <= fence.sequence!),
				"continuous",
				"stdout",
			);
			expect(fencedBytes.length).toBeGreaterThanOrEqual(64 * 1024);
			expect(fencedBytes.every(byte => byte === 121)).toBe(true);
			expect(result.controls.find(control => control.type === "final-fence")?.sequence).toBe(
				frames.at(-1)?.sequence,
			);
		});

		test("cancels a pump with unread framed output without waiting for transport or descendant drain", async () => {
			const { child, controls, stderr } = spawnFixture(runtime, "cancel");
			const reader = child.stdout.getReader();
			try {
				// Start real native output, then stop consuming the host pipe entirely.
				const first = await reader.read();
				expect(first.done).toBe(false);
				child.send({ type: "close" });
				expect(await child.exited, await stderr).toBe(0);
				expect(controls.some(control => control.type === "cancelled")).toBe(true);
			} finally {
				await reader.cancel();
				child.kill();
			}
		});

		test("reaps completed captures and closes promptly without waiting for descendant EOF", async () => {
			const result = await collectFixture(runtime, "cleanup");
			const frames = framesFrom(result.stdout);
			expect(frames.filter(frame => frame.runId.startsWith("short-")).length).toBe(512);
			expect(bytesFor(frames, "replacement", "stdout").toString()).toBe("replacement");
			expect(result.controls.some(control => control.type === "closed-with-live-descendant")).toBe(true);
			const resources = result.controls.find(control => control.type === "resources")!;
			expect(resources.after).toBe(resources.before);
		});
	});
}
