import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../async";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { handleKernelControl } from "../eval/kernel-control";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

async function fixture(run: (session: ToolSession, manager: AsyncJobManager) => Promise<void>) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-cell-termination-"));
	const owner = `kernel-cell-termination-${crypto.randomUUID()}`;
	const manager = new AsyncJobManager({});
	const session = {
		cwd,
		asyncJobManager: manager,
		settings: {
			get: (key: string) => (key === "async.enabled" ? true : undefined),
			getShellConfig: () => ({ env: {} }),
		},
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => {
			const id = crypto.randomUUID();
			return { id, path: path.join(cwd, "artifacts", id) };
		},
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession;
	try {
		await run(session, manager);
	} finally {
		await manager.dispose();
		await Promise.all([
			disposeBashSessions(owner),
			disposeKernelSessionsByOwner(owner),
			disposeVmContextsByOwner(owner),
		]);
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

afterEach(() => vi.restoreAllMocks());

function text(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

const hungCell = {
	node: `node -e 'globalThis.survivor = 1; console.log("long cell start"); await new Promise(() => {})'`,
	bun: `bun -e 'globalThis.survivor = 1; console.log("long cell start"); await new Promise(() => {})'`,
	python: `python -c 'survivor = 1\nprint("long cell start", flush=True)\nimport threading\nthreading.Event().wait()'`,
};
const survivorProbe = {
	node: `node -e 'console.log(typeof globalThis.survivor)'`,
	bun: `bun -e 'console.log(typeof globalThis.survivor)'`,
	python: `python -c 'print(type(globals().get("survivor")).__name__)'`,
};
const freshSurvivor = { node: "undefined", bun: "undefined", python: "NoneType" };

// Python's force-close is covered in bash-kernel-runtime.test.ts; its reset shares the replace-kernel path.
const cases = [
	{ language: "node", kernel: "node", control: { op: "close", force: true }, cause: "was force-closed" },
	{ language: "node", kernel: "node", control: { op: "reset" }, cause: "was reset" },
	{ language: "bun", kernel: "bun", control: { op: "close", force: true }, cause: "was force-closed" },
	{ language: "bun", kernel: "bun", control: { op: "reset" }, cause: "was reset" },
	{ language: "python", kernel: "py", control: { op: "reset" }, cause: "was reset" },
] as const;

for (const { language, kernel, control, cause } of cases) {
	test(`a background ${language} cell that ${cause} mid-run fails with that cause and the lane restarts fresh`, async () => {
		await fixture(async (session, manager) => {
			const bash = new BashTool(session);
			const running = Promise.withResolvers<void>();
			const started = await manager.withJobObserver(
				observation => {
					if (observation.kind === "progress" && observation.text.includes("long cell start")) running.resolve();
				},
				() => bash.execute("hung-cell", { async: true, lane: "kx", command: hungCell[language] }),
			);
			await running.promise;
			await handleKernelControl(session, { ...control, language, lane: "kx" });
			await manager.waitForAll();
			const job = manager.getJob(started.details!.async!.jobId)!;
			expect(job.status).toBe("failed");
			expect(job.errorText).toBe(`kernel ${kernel}:kx ${cause}; cell cancelled`);
			expect(job.resultText).toContain("long cell start");
			expect(job.resultText).toContain(`<kernel> ${kernel}:kx ${cause}; cell cancelled`);
			expect(job.resultText).toContain("Command exited with code 130");

			const next = await bash.execute("after-lifecycle", { lane: "kx", command: survivorProbe[language] });
			expect(next.isError).not.toBe(true);
			expect(text(next)).toContain(freshSurvivor[language]);
			expect(text(next)).toContain(`<kernel> state lost: ${kernel}:kx restarted`);
		});
	}, 60_000);
}
