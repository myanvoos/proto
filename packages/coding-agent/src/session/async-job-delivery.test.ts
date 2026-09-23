import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncJobManager } from "../async";
import {
	type AsyncResultEntry,
	buildAsyncResultBatchMessage,
	formatAsyncJobTextForContext,
} from "./async-job-delivery";

async function settledJob(manager: AsyncJobManager, run: () => Promise<string>) {
	const id = manager.register("bash", "job label", run);
	await manager.waitForAll();
	const job = manager.getJob(id);
	if (!job) throw new Error("job disappeared");
	return job;
}

function entry(job: Awaited<ReturnType<typeof settledJob>>, result: string): AsyncResultEntry {
	return { jobId: job.id, result, job, durationMs: 10, epoch: 0 };
}

test("a failed background job announces its failure even when the tail is truncated", async () => {
	const manager = new AsyncJobManager({});
	try {
		const failing = await settledJob(manager, async () => {
			throw new Error(`${"noise\n".repeat(3_000)}Command exited with code 42`);
		});
		expect(failing.status).toBe("failed");
		const truncated = await formatAsyncJobTextForContext(failing.errorText ?? "");
		expect(truncated).not.toContain("Command exited with code 42");

		const message = buildAsyncResultBatchMessage([entry(failing, truncated)]);
		const content = message?.content ?? "";
		expect(content).toContain(`Background job ${failing.id} FAILED.`);
		expect(content).not.toContain("has completed");
		expect(message?.details?.jobs?.[0]?.status).toBe("failed");
	} finally {
		await manager.dispose();
	}
});

test("a successful background job keeps the completion wording", async () => {
	const manager = new AsyncJobManager({});
	try {
		const ok = await settledJob(manager, async () => "done");
		const message = buildAsyncResultBatchMessage([entry(ok, ok.resultText ?? "")]);
		expect(message?.content).toContain(`Background job ${ok.id} has completed.`);
		expect(message?.content).not.toContain("FAILED");
		expect(message?.details?.jobs?.[0]?.status).toBe("completed");
	} finally {
		await manager.dispose();
	}
});

test("batched deliveries flag which jobs failed", async () => {
	const manager = new AsyncJobManager({});
	try {
		const ok = await settledJob(manager, async () => "fine");
		const failing = await settledJob(manager, async () => {
			throw new Error("boom");
		});
		const message = buildAsyncResultBatchMessage([entry(ok, "fine"), entry(failing, "boom")]);
		const content = message?.content ?? "";
		expect(content).toContain("2 background jobs have finished (some FAILED — see each job header).");
		expect(content).toContain(`── Job ${failing.id} (job label) — FAILED ──`);
		expect(content).toContain(`── Job ${ok.id} (job label) ──`);
	} finally {
		await manager.dispose();
	}
});

test("oversized job text is capped and recoverable through an artifact", async () => {
	const text = `${"x".repeat(20_000)}END`;
	const artifactDir = await mkdtemp(join(tmpdir(), "async-delivery-artifact-"));
	const artifactPath = join(artifactDir, "7.txt");
	try {
		const formatted = await formatAsyncJobTextForContext(text, async toolType => {
			expect(toolType).toBe("async");
			return { id: "7", path: artifactPath };
		});
		expect(formatted).toContain("[Output truncated. Showing first 4,000 characters.]");
		expect(formatted).toContain("Full output: artifact://7");
		expect(formatted).not.toContain("END");
		expect(await readFile(artifactPath, "utf8")).toBe(text);
	} finally {
		await rm(artifactDir, { recursive: true, force: true });
	}
});
