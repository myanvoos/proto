import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { PYTHON_DISPLAY_MAX_PERSISTED_BYTES } from "../../eval/py/display";
import { DEFAULT_MAX_BYTES } from "../../session/streaming-output";
import { RunOutput } from "./run-output";

test("worker text spills while ingesting and returns a bounded tail with its artifact", async () => {
	using directory = TempDir.createSync("@run-output-");
	const artifactPath = path.join(directory.path(), "output.log");
	const output = new RunOutput({ path: artifactPath, id: "worker-output" });
	for (let index = 0; index < 16; index++) {
		output.pushText(`${index}:${"x".repeat(1024 * 1024)}:${index}\n`);
		expect(output.retainedBytes()).toBeLessThan(2 * 1024 * 1024);
	}
	expect(await Bun.file(artifactPath).exists()).toBe(true);
	const result = await output.finish();
	const inline = result.displays.map(block => (block.type === "text" ? block.text : "")).join("\n");
	expect(Buffer.byteLength(inline)).toBeLessThan(DEFAULT_MAX_BYTES + 1024);
	expect(inline).toContain("Output truncated");
	expect(inline).toContain("artifact://worker-output");
	expect(inline).toContain(":15");
	const artifact = await Bun.file(artifactPath).text();
	expect(artifact.startsWith("0:")).toBe(true);
	expect(artifact.endsWith(":15\n")).toBe(true);
	expect(artifact).toContain("ARTIFACT TRUNCATED");
	expect(Buffer.byteLength(artifact)).toBeLessThan(4 * 1024 * 1024 + 256);
	expect(output.retainedBytes()).toBe(0);
});

test("worker image admission is aggregate and screenshot metadata cannot grow without limit", async () => {
	const output = new RunOutput();
	for (let index = 0; index < 100; index++) {
		output.push({ type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png" });
	}
	const screenshots = Array.from({ length: 100 }, (_, index) =>
		output.admitMetadata({ path: `shot-${index}.png` }),
	).filter(Boolean);
	const result = await output.finish();
	expect(screenshots.length).toBeLessThanOrEqual(64);
	expect(result.displays.filter(block => block.type === "image")).toHaveLength(3);
	expect(Buffer.byteLength(JSON.stringify(result.displays))).toBeLessThanOrEqual(PYTHON_DISPLAY_MAX_PERSISTED_BYTES);
	expect(result.displays.some(block => block.type === "text" && block.text.includes("truncated"))).toBe(true);
});

test("normal worker output preserves interleaved display order and snapshots return values", async () => {
	const output = new RunOutput();
	output.pushText("one\n");
	output.pushText("two\n");
	output.push({ type: "image", data: "YQ==", mimeType: "image/png" });
	output.pushDisplay({ type: "json", data: { done: true } });
	const returned = { count: 3 };
	const result = await output.finish(returned);
	returned.count = 4;
	expect(result.displays).toEqual([
		{ type: "text", text: "one\ntwo" },
		{ type: "image", data: "YQ==", mimeType: "image/png" },
		{ type: "text", text: '{\n  "done": true\n}' },
	]);
	expect(result.returnValue).toEqual({ count: 3 });
});

test("oversized return values spill rather than crossing worker IPC as raw objects", async () => {
	using directory = TempDir.createSync("@run-output-return-");
	const artifactPath = path.join(directory.path(), "output.log");
	const output = new RunOutput({ path: artifactPath, id: "returned-output" });
	const result = await output.finish({ payload: "r".repeat(1024 * 1024) });
	expect(result.returnValue).toBeUndefined();
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(DEFAULT_MAX_BYTES + 1024);
	expect(JSON.stringify(result.displays)).toContain("artifact://returned-output");
	expect(await Bun.file(artifactPath).text()).toContain('"payload":');
});

test("non-JSON returns retain their rendered text without retaining unbounded raw clones", async () => {
	const bigint = await new RunOutput().finish(42n);
	expect(bigint.returnValue).toBe("42");
	const date = await new RunOutput().finish(new Date("2026-01-01T00:00:00Z"));
	expect(date.returnValue).toBe('"2026-01-01T00:00:00.000Z"');
	const hidden = await new RunOutput().finish(new Map([[{ id: 1 }, "x".repeat(8 * 1024 * 1024)]]));
	expect(hidden.returnValue).toEqual({});
	expect(Buffer.byteLength(JSON.stringify(hidden))).toBeLessThan(256);
});

test("browser runs show user displays and return values but never the runtime's internal status events", async () => {
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: `browser-status-${crypto.randomUUID()}` });
	const output = new RunOutput();
	const hooks: RuntimeHooks = {
		onText: chunk => output.pushText(chunk),
		onDisplay: displayed => output.pushDisplay(displayed),
		callTool: async () => undefined,
	};
	try {
		const value = await runtime.run('log("progress"); display({ shown: true }); 42', "status-cell.js", hooks);
		const result = await output.finish(value);
		expect(result.displays).toEqual([{ type: "text", text: '{\n  "shown": true\n}' }]);
		expect(result.returnValue).toBe(42);
	} finally {
		runtime.dispose();
	}
});
