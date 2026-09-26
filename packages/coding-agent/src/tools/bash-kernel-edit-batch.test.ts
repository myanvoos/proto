import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// Host-applied checked edits (edit_batch / editBatch) are kernel mutations: they must surface the
// same `<kernel> note:` lines and status events as raw kernel writes, and leave the kernel's
// stale-write guard armed at the content the batch wrote.
const KERNEL_OWNER = `kernel-edit-batch-test:${process.pid}`;

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `kernel-edit-batch-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

interface Cell {
	isError: boolean;
	output: string;
	writes: unknown[];
}

async function runCell(tool: BashTool, interpreter: string, code: string): Promise<Cell> {
	const result = await tool.execute("kernel-edit-batch-test", {
		command: `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`,
		timeout: 60,
	});
	const output = result.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n");
	const events = (result.details?.statusEvents ?? []) as Array<{ op?: string; path?: string }>;
	return {
		isError: result.isError === true,
		output,
		writes: events.filter(event => event.op === "write").map(event => event.path),
	};
}

function noteLines(output: string): string[] {
	return output
		.split("\n")
		.filter(line => line.startsWith("<kernel> note:"))
		.map(line => line.trim());
}

const jsLanguage = (interpreter: string) => ({
	interpreter,
	batch: [
		"{",
		"  const text = require('node:fs').readFileSync('existing.txt', 'utf8');",
		"  const r = await editBatch([",
		"    { path: 'existing.txt', before: text, after: text.replace('two', 'TWO') },",
		"    { path: 'created.txt', before: null, after: 'x\\ny\\n' },",
		"  ], { apply: true });",
		"  print(r.state, JSON.stringify(Object.keys(r).sort()));",
		"}",
	].join("\n"),
	appliedLine: 'applied ["applied","conflicts","files","state"]',
	rawWrite: "require('node:fs').writeFileSync('existing.txt', 'kernel\\n');",
	readThenBatchThenWrite: [
		"{ const text = require('node:fs').readFileSync('existing.txt', 'utf8');",
		"await editBatch([{ path: 'existing.txt', before: text, after: 'batched\\n' }], { apply: true });",
		"require('node:fs').writeFileSync('existing.txt', 'same-cell\\n'); }",
	].join("\n"),
	rereadThenBatch: [
		"{ const text = require('node:fs').readFileSync('existing.txt', 'utf8');",
		"await editBatch([{ path: 'existing.txt', before: text, after: 'batched\\n' }], { apply: true }); }",
	].join("\n"),
});

const languages = [
	{
		interpreter: "python",
		// Reads arm the guard; the batch then rewrites the read file and creates another.
		batch: [
			"import json",
			"text = Path('existing.txt').read_text()",
			"r = edit_batch([",
			"    {'path': 'existing.txt', 'before': text, 'after': text.replace('two', 'TWO')},",
			"    {'path': 'created.txt', 'before': None, 'after': 'x\\ny\\n'},",
			"], apply=True)",
			"print(r['state'], json.dumps(sorted(r), separators=(',', ':')))",
		].join("\n"),
		appliedLine: 'applied ["applied","conflicts","files","state"]',
		rawWrite: "open('existing.txt', 'w').write('kernel\\n')",
		readThenBatchThenWrite: [
			"text = Path('existing.txt').read_text()",
			"edit_batch([{'path': 'existing.txt', 'before': text, 'after': 'batched\\n'}], apply=True)",
			"open('existing.txt', 'w').write('same-cell\\n')",
		].join("\n"),
		rereadThenBatch: [
			"text = Path('existing.txt').read_text()",
			"edit_batch([{'path': 'existing.txt', 'before': text, 'after': 'batched\\n'}], apply=True)",
		].join("\n"),
	},
	jsLanguage("bun"),
	jsLanguage("node"),
] as const;

for (const language of languages) {
	test(`${language.interpreter} checked edits emit kernel notes and keep the stale-write guard coherent`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-edit-batch-"));
		try {
			const tool = new BashTool(stubSession(dir));
			const existing = path.join(dir, "existing.txt");
			await Bun.write(existing, "one\ntwo\n");

			const batch = await runCell(tool, language.interpreter, language.batch);
			expect(batch.isError, batch.output).toBe(false);
			expect(batch.output).toContain(language.appliedLine);
			expect(noteLines(batch.output)).toEqual([
				"<kernel> note: created created.txt (2 lines)",
				"<kernel> note: wrote existing.txt (+1 \u22121)",
			]);
			expect(batch.writes.sort()).toEqual([path.join(dir, "created.txt"), existing]);

			// The batch wrote what the kernel asked for: a later kernel write is not stale.
			const later = await runCell(tool, language.interpreter, language.rawWrite);
			expect(later.isError, later.output).toBe(false);
			expect(await Bun.file(existing).text()).toBe("kernel\n");

			const sameCell = await runCell(tool, language.interpreter, language.readThenBatchThenWrite);
			expect(sameCell.isError, sameCell.output).toBe(false);
			expect(await Bun.file(existing).text()).toBe("same-cell\n");

			// A genuinely external change after a batch is still caught.
			const reread = await runCell(tool, language.interpreter, language.rereadThenBatch);
			expect(reread.isError, reread.output).toBe(false);
			await Bun.write(existing, "external\n");
			const clobber = await runCell(tool, language.interpreter, language.rawWrite);
			expect(clobber.isError).toBe(true);
			expect(clobber.output).toContain("StaleWriteError");
			expect(await Bun.file(existing).text()).toBe("external\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
