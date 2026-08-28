import type { SessionEntry } from "../src/session/session-manager";
import { buildSessionContext } from "../src/session/session-manager";

const MSG_COUNT = 100;
const CODE_BLOCKS_PER_MSG = 5;

function makeId(i: number): string {
	return `entry-${i.toString().padStart(6, "0")}`;
}

function makeCodeBlock(idx: number): string {
	return `\`\`\`typescript\nconst x${idx} = ${idx};\nconsole.log(x${idx});\n\`\`\``;
}

function buildEntries(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const now = new Date();

	for (let i = 0; i < MSG_COUNT; i++) {
		const id = makeId(i);
		const parentId = i === 0 ? null : makeId(i - 1);
		const timestamp = new Date(now.getTime() + i * 1000).toISOString();

		const codeBlocks = Array.from({ length: CODE_BLOCKS_PER_MSG }, (_, k) =>
			makeCodeBlock(i * CODE_BLOCKS_PER_MSG + k),
		).join("\n\n");

		if (i % 2 === 0) {
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp,
				message: {
					role: "user",
					content: `User message ${i}: please analyze this code.\n\n${codeBlocks}`,
				},
			} satisfies SessionEntry);
		} else {
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Assistant reply ${i}:\n\n${codeBlocks}` }],
				},
			} satisfies SessionEntry);
		}
	}

	return entries;
}

const WARMUP = 20;
const ITERATIONS = 200;

function bench(name: string, fn: () => void): number {
	for (let i = 0; i < WARMUP; i++) fn();

	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) fn();
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	const perOp = elapsed / ITERATIONS;
	console.log(`  ${name}: ${elapsed.toFixed(2)}ms total  ${perOp.toFixed(4)}ms/op`);
	return perOp;
}

const entries = buildEntries();
const leafId = makeId(MSG_COUNT - 1);

console.log(
	`\nBenchmark: session-tree-nav (${MSG_COUNT} messages, ${CODE_BLOCKS_PER_MSG} code blocks each, ${ITERATIONS} iterations)\n`,
);

const twoWalks = bench("two walks   [BEFORE — old behaviour]", () => {
	buildSessionContext(entries, leafId);
	buildSessionContext(entries, leafId);
});

const oneWalk = bench("one walk    [AFTER  — dedupe fix]    ", () => {
	buildSessionContext(entries, leafId);
});

const savedMs = twoWalks - oneWalk;
const pctSaved = ((savedMs / twoWalks) * 100).toFixed(1);
console.log(`\n  Saved ${savedMs.toFixed(4)}ms/navigation (${pctSaved}% reduction per navigate)\n`);
