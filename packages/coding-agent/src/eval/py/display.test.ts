import { expect, test } from "bun:test";
import {
	normalizeKernelDisplayOutput,
	normalizePythonDisplayOutputs,
	PYTHON_DISPLAY_MAX_BLOCK_TEXT,
	PYTHON_DISPLAY_MAX_PERSISTED_BYTES,
	PythonDisplayBudget,
	renderKernelDisplay,
} from "./display";

test("JSON display bundles expose one model-visible rendering", async () => {
	const rendered = await renderKernelDisplay({
		"application/json": { a: 1 },
		"text/plain": "{'a': 1}",
	});

	expect(rendered.text).toBe("");
	expect(rendered.outputs).toEqual([{ type: "json", data: { a: 1 } }]);
});

test("plain text display bundles remain model-visible text", async () => {
	const rendered = await renderKernelDisplay({ "text/plain": "hello" });

	expect(rendered.text).toBe("hello\n");
	expect(rendered.outputs).toEqual([]);
});

test("markdown display bundles do not duplicate the text leg as a block", async () => {
	const rendered = await renderKernelDisplay({ "text/markdown": "**bold**" });
	expect(rendered.text).toBe("**bold**\n");
	expect(rendered.outputs).toEqual([]);
	// The single-output normalizer drops markdown for the same reason.
	expect(normalizeKernelDisplayOutput({ type: "markdown", text: "**bold**" })).toBeUndefined();
});

test("display budget enforces per-block clipping and exact persisted bytes", () => {
	const budget = new PythonDisplayBudget();
	const big = "x".repeat(PYTHON_DISPLAY_MAX_BLOCK_TEXT + 1000);
	expect(budget.add({ type: "markdown", text: big })).toBe(true);
	const block = budget.blocks[0];
	if (block?.type !== "markdown") throw new Error("expected markdown block");
	// Clipped to the cap plus an omission notice suffix.
	expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(PYTHON_DISPLAY_MAX_BLOCK_TEXT + 40);
	expect(block.text).toContain("bytes omitted");
	// Aggregate accounting: two half-cap images fit; a third is rejected.
	const half = "A".repeat(Math.floor(PYTHON_DISPLAY_MAX_PERSISTED_BYTES / 2) - 100);
	const aggregate = new PythonDisplayBudget();
	expect(aggregate.add({ type: "image", data: half, mimeType: "image/png" })).toBe(true);
	expect(aggregate.add({ type: "image", data: half, mimeType: "image/png" })).toBe(true);
	expect(aggregate.add({ type: "image", data: half, mimeType: "image/png" })).toBe(false);
	expect(aggregate.blocks.filter(block => block.type === "image")).toHaveLength(2);

	// A single block larger than the whole persistence budget is rejected.
	const huge = new PythonDisplayBudget();
	expect(
		huge.add({ type: "image", data: "A".repeat(PYTHON_DISPLAY_MAX_PERSISTED_BYTES + 1), mimeType: "image/png" }),
	).toBe(false);
	expect(huge.blocks.at(-1)?.type).toBe("notice");
});

test("markdown kernel outputs are skipped by batch normalization", () => {
	const blocks = normalizePythonDisplayOutputs([
		{ type: "markdown", text: "# dup" },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
	]);
	expect(blocks).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
});

test("notice recording never pushes the block list past its cap", () => {
	const budget = new PythonDisplayBudget();
	for (let i = 0; i < 64; i++) {
		expect(budget.add({ type: "json", text: String(i) })).toBe(true);
	}
	// A rejected oversized image at full capacity must not append a 65th
	// notice block.
	expect(
		budget.add({ type: "image", data: "A".repeat(PYTHON_DISPLAY_MAX_PERSISTED_BYTES + 1), mimeType: "image/png" }),
	).toBe(false);
	expect(budget.blocks).toHaveLength(64);
	expect(budget.blocks.every(block => block.type === "json")).toBe(true);
});

test("clipped text blocks stay within the declared per-block byte limit", () => {
	const budget = new PythonDisplayBudget();
	const big = "x".repeat(PYTHON_DISPLAY_MAX_BLOCK_TEXT * 3);
	expect(budget.add({ type: "text", text: big })).toBe(true);
	const block = budget.blocks[0];
	if (block?.type !== "text") throw new Error("expected text block");
	expect(Buffer.byteLength(JSON.stringify(block))).toBeLessThanOrEqual(PYTHON_DISPLAY_MAX_BLOCK_TEXT + 120);
});

test("multibyte text clips on UTF-8 byte budget without splitting code points", () => {
	const budget = new PythonDisplayBudget();
	const emoji = "\u{1F600}".repeat(PYTHON_DISPLAY_MAX_BLOCK_TEXT); // 4 bytes each
	expect(budget.add({ type: "text", text: emoji })).toBe(true);
	const block = budget.blocks[0];
	if (block?.type !== "text") throw new Error("expected text block");
	expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(PYTHON_DISPLAY_MAX_BLOCK_TEXT);
	// The final code point survived intact (no U+FFFD replacement split).
	expect(block.text.endsWith("\u{FFFD}")).toBe(false);
});
