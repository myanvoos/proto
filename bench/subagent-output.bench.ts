import { TailAccumulator, truncateTail } from "../packages/coding-agent/src/session/streaming-output";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../packages/coding-agent/src/task/types";
import { formatArtifact, runSuite } from "./harness";

// A subagent's assistant text arrives as many message_end blocks. The executor used to retain every block
// and join them all before applying the 500 KB / 5000 line cap; it now retains only a bounded tail.
const BLOCK = `${"subagent output line with some realistic width to it".repeat(4)}\n`;
const RETAIN = MAX_OUTPUT_BYTES * 8;

function blocksFor(totalBytes: number): number {
	return Math.ceil(totalBytes / Buffer.byteLength(BLOCK, "utf-8"));
}

function accumulateAll(blocks: number): number {
	const chunks: string[] = [];
	for (let i = 0; i < blocks; i++) chunks.push(BLOCK);
	const raw = chunks.join("");
	return truncateTail(raw, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES }).content.length;
}

function accumulateBounded(blocks: number): number {
	const tail = new TailAccumulator(RETAIN);
	for (let i = 0; i < blocks; i++) tail.push(BLOCK);
	const raw = tail.text();
	return truncateTail(raw, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES }).content.length;
}

const sizes = [
	["8MB", 8 * 1024 * 1024],
	["32MB", 32 * 1024 * 1024],
	["128MB", 128 * 1024 * 1024],
] as const;

const cases = sizes.flatMap(([label, bytes]) => {
	const blocks = blocksFor(bytes);
	return [
		{ name: `retain-all-${label}`, runs: 5, warmup: 1, run: () => accumulateAll(blocks) },
		{ name: `bounded-tail-${label}`, runs: 5, warmup: 1, run: () => accumulateBounded(blocks) },
	];
});

const artifact = await runSuite("subagent-output", cases);
process.stdout.write(`${formatArtifact(artifact)}\n`);

// Peak retained bytes, which is the point of the change.
for (const [label, bytes] of sizes) {
	const blocks = blocksFor(bytes);
	const tail = new TailAccumulator(RETAIN);
	for (let i = 0; i < blocks; i++) tail.push(BLOCK);
	process.stdout.write(
		`${label}: produced ${bytes} B, retained ${Buffer.byteLength(tail.text(), "utf-8")} B, dropped ${tail.droppedBytes} B\n`,
	);
}
