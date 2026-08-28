import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLspWritethrough, writethroughNoop } from "../src/lsp";

const REPO = path.resolve(import.meta.dir, "../../..");
const target = path.join(REPO, "packages/coding-agent/src/__bench_lsp_tmp.ts");

function body(n: number): string {
	return `// bench scratch file with an intentional type diagnostic
export function benchAdd_${n}(a: number, b: number): number {
	const result = a + b;
	return result;
}
export const benchValue_${n}: string = benchAdd_${n}(${n}, ${n + 1});
`;
}

async function timeCall(label: string, fn: () => Promise<unknown>): Promise<void> {
	const t0 = Bun.nanoseconds();
	await fn();
	console.log(`  ${label.padEnd(46)} ${((Bun.nanoseconds() - t0) / 1e6).toFixed(1).padStart(9)} ms`);
}

function makeDeferred(label: string) {
	const controller = new AbortController();
	const lateAt = { t: 0 };
	const startedAt = Bun.nanoseconds();
	return {
		handle: {
			onDeferredDiagnostics: (_d: unknown) => {
				lateAt.t = (Bun.nanoseconds() - startedAt) / 1e6;
				console.log(`      └─ ${label}: late diagnostics injected at +${lateAt.t.toFixed(0)} ms`);
			},
			signal: controller.signal,
			finalize: (_d: unknown) => {},
		},
		controller,
	};
}

await fs.writeFile(target, body(0));
try {
	console.log("\n--- writethroughNoop (LSP off — default edit path) ---");
	for (let i = 1; i <= 3; i++) {
		await timeCall(`noop write #${i}`, () => writethroughNoop(target, body(i), undefined, Bun.file(target)));
	}

	console.log("\n--- diagnostics, NO deferred channel (blocks until settle/timeout) ---");
	const wtDiag = createLspWritethrough(REPO, { enableDiagnostics: true, enableFormat: false });
	for (let i = 10; i <= 14; i++) {
		const label = i === 10 ? "write #1 (COLD: spawn+warm)" : `write #${i - 9} (warm)`;
		await timeCall(label, () => wtDiag(target, body(i), undefined, Bun.file(target)));
	}

	console.log("\n--- diagnostics, WITH deferred channel (short inline wait, then late) ---");
	for (let i = 30; i <= 34; i++) {
		const { handle } = makeDeferred(`write #${i - 29}`);
		await timeCall(`write #${i - 29} (inline)`, () =>
			wtDiag(target, body(i), undefined, Bun.file(target), undefined, () => handle),
		);
	}

	await Bun.sleep(6000);

	console.log("\n--- format writethrough (formatOnWrite) ---");
	const wtFmt = createLspWritethrough(REPO, { enableDiagnostics: false, enableFormat: true });
	for (let i = 20; i <= 22; i++) {
		await timeCall(`write #${i - 19}`, () => wtFmt(target, body(i), undefined, Bun.file(target)));
	}
} finally {
	await fs.rm(target, { force: true });
}

console.log("\n(done)");
process.exit(0);
