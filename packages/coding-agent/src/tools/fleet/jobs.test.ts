import { expect, test } from "bun:test";
import { AsyncJobManager } from "../../async";
import type { ToolSession } from "..";
import { executeCancel } from "./jobs";

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
