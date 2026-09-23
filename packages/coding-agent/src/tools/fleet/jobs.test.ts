import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncJobManager } from "../../async";
import type { ToolSession } from "..";
import { executeCancel, executeJobsSnapshot } from "./jobs";

test("cancelling an unknown id reports no successful cancellations", async () => {
	const manager = new AsyncJobManager({});
	try {
		const session = { asyncJobManager: manager } as ToolSession;
		const result = await executeCancel(session, manager, undefined, ["missing-id"]);
		expect(result.content).toEqual([
			{ type: "text", text: "## Not cancelled (1)\n\n- Background job not found: missing-id" },
		]);
		expect(result.details?.cancelled).toEqual([{ id: "missing-id", status: "not_found" }]);
	} finally {
		await manager.dispose();
	}
});

test("mixed cancellation results count only successful cancellations", async () => {
	const manager = new AsyncJobManager({});
	const release = Promise.withResolvers<string>();
	try {
		const completed = manager.register("bash", "already done", async () => "done");
		await manager.waitForAll();
		const running = manager.register("bash", "pending", async () => release.promise);
		const session = { asyncJobManager: manager } as ToolSession;
		const result = await executeCancel(session, manager, undefined, [running, completed, "missing-id"]);
		const text = result.content.find(part => part.type === "text")?.text;
		expect(text).toContain(`## Cancelled (1)\n\n- Cancelled background job ${running}.`);
		expect(text).toContain(
			`## Not cancelled (2)\n\n- Background job ${completed} is already completed.\n- Background job not found: missing-id`,
		);
		expect(result.details?.cancelled).toEqual([
			{ id: running, status: "cancelled" },
			{ id: completed, status: "already_completed" },
			{ id: "missing-id", status: "not_found" },
		]);
		expect(manager.getJob(running)?.status).toBe("cancelled");
	} finally {
		release.resolve("finished");
		await manager.waitForAll();
		await manager.dispose();
	}
});

async function withArtifactSession(
	manager: AsyncJobManager,
	run: (session: ToolSession, artifactDir: string) => Promise<void>,
): Promise<void> {
	const artifactDir = await mkdtemp(join(tmpdir(), "fleet-jobs-artifact-"));
	let next = 0;
	const session = {
		asyncJobManager: manager,
		allocateOutputArtifact: async () => {
			const id = String(next++);
			return { id, path: join(artifactDir, `${id}.txt`) };
		},
	} as unknown as ToolSession;
	try {
		await run(session, artifactDir);
	} finally {
		await rm(artifactDir, { recursive: true, force: true });
	}
}

test("jobs snapshot caps oversized job output and points at an artifact", async () => {
	const manager = new AsyncJobManager({});
	const big = `${"result-line\n".repeat(4_000)}TAIL_MARKER`;
	expect(big.length).toBeGreaterThan(12_000);
	try {
		manager.register("bash", "big output", async () => big);
		await manager.waitForAll();
		await withArtifactSession(manager, async (session, artifactDir) => {
			const result = await executeJobsSnapshot(session, manager, undefined);
			const text = result.content.find(part => part.type === "text")?.text ?? "";
			expect(text).toContain("[Output truncated. Showing first 4,000 characters.]");
			expect(text).toContain("Full output: artifact://0");
			expect(text).not.toContain("TAIL_MARKER");
			expect(text.length).toBeLessThan(big.length);
			expect(await readFile(join(artifactDir, "0.txt"), "utf8")).toBe(big);
			expect(result.details?.jobs?.[0]?.resultText).toBe(big);
		});
	} finally {
		await manager.dispose();
	}
});

test("jobs snapshot caps oversized job failures while keeping the failed status", async () => {
	const manager = new AsyncJobManager({});
	const big = `${"error-line\n".repeat(4_000)}Command exited with code 42`;
	try {
		manager.register("bash", "big failure", async () => {
			throw new Error(big);
		});
		await manager.waitForAll();
		await withArtifactSession(manager, async (session, artifactDir) => {
			const result = await executeJobsSnapshot(session, manager, undefined);
			const text = result.content.find(part => part.type === "text")?.text ?? "";
			expect(text).toContain("— failed");
			expect(text).toContain("[Output truncated. Showing first 4,000 characters.]");
			expect(text).toContain("Full output: artifact://0");
			expect(text).not.toContain("Command exited with code 42");
			expect(await readFile(join(artifactDir, "0.txt"), "utf8")).toBe(big);
		});
	} finally {
		await manager.dispose();
	}
});

test("repeated jobs snapshots reuse one artifact for the same job output", async () => {
	const manager = new AsyncJobManager({});
	const big = "poll-line\n".repeat(4_000);
	try {
		manager.register("bash", "polled output", async () => big);
		await manager.waitForAll();
		await withArtifactSession(manager, async session => {
			const first = await executeJobsSnapshot(session, manager, undefined);
			const second = await executeJobsSnapshot(session, manager, undefined);
			const firstText = first.content.find(part => part.type === "text")?.text ?? "";
			const secondText = second.content.find(part => part.type === "text")?.text ?? "";
			expect(firstText).toContain("Full output: artifact://0");
			expect(secondText).toBe(firstText);
			expect(secondText).not.toContain("artifact://1");
		});
	} finally {
		await manager.dispose();
	}
});

test("jobs snapshot leaves small job output inline", async () => {
	const manager = new AsyncJobManager({});
	try {
		manager.register("bash", "small output", async () => "all done");
		await manager.waitForAll();
		await withArtifactSession(manager, async session => {
			const result = await executeJobsSnapshot(session, manager, undefined);
			const text = result.content.find(part => part.type === "text")?.text ?? "";
			expect(text).toContain("all done");
			expect(text).not.toContain("artifact://");
		});
	} finally {
		await manager.dispose();
	}
});
