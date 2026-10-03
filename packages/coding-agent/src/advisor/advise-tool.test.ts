/**
 * The advise tool's acknowledgment must match what reaches the primary: every note told "Queued" is delivered at the
 * flush, a dropped note is never described as delivered, and blockers always interrupt.
 */
import { describe, expect, it } from "bun:test";
import { AdviseTool, type AdvisorSeverity } from "./advise-tool";

function harness() {
	const delivered: { note: string; severity?: AdvisorSeverity }[] = [];
	const tool = new AdviseTool((note, severity) => delivered.push({ note, severity }));
	const advise = async (note: string, severity?: AdvisorSeverity): Promise<string> => {
		const result = await tool.execute("call", { note, severity });
		const first = result.content[0];
		return first?.type === "text" ? first.text : "";
	};
	return { tool, advise, delivered };
}

describe("AdviseTool admission", () => {
	it("delivers every note deferred across in-progress updates when the turn completes", async () => {
		const { tool, advise, delivered } = harness();
		tool.beginUpdate(true);
		expect(await advise("check the retry path", "concern")).toStartWith("Queued");
		tool.beginUpdate(true);
		expect(await advise("the cache key ignores cwd")).toStartWith("Queued");
		expect(delivered).toEqual([]);

		tool.beginUpdate(false);
		expect(delivered.map(item => item.note)).toEqual(["check the retry path", "the cache key ignores cwd"]);
	});

	it("flushes deferred notes at the terminal boundary without opening a new budget", async () => {
		const { tool, advise, delivered } = harness();
		tool.beginUpdate(true);
		await advise("first finding");
		tool.flushDeferredNotes();
		expect(delivered.map(item => item.note)).toEqual(["first finding"]);
		expect(await advise("second finding")).toBe("Dropped: this update's advice budget is spent.");
	});

	it("lets a blocker past a spent budget and reports rejected notes truthfully", async () => {
		const { tool, advise, delivered } = harness();
		tool.beginUpdate(false);
		expect(await advise("rename the helper")).toBe("Delivered.");
		expect(await advise("another nit")).toBe("Dropped: this update's advice budget is spent.");
		expect(await advise("the migration deletes user data", "blocker")).toBe("Delivered.");
		expect(await advise("Rename the helper!")).toBe("Dropped: already raised.");
		expect(await advise("looks good")).toBe("Dropped: nothing actionable.");
		expect(delivered.map(item => item.note)).toEqual(["rename the helper", "the migration deletes user data"]);
	});

	it("lets a higher-severity note displace a pending one from the same update only", async () => {
		const { tool, advise, delivered } = harness();
		tool.beginUpdate(true);
		await advise("earlier update nit");
		tool.beginUpdate(true);
		await advise("minor style nit");
		expect(await advise("the lock is never released", "concern")).toStartWith("Queued");
		tool.beginUpdate(false);
		expect(delivered.map(item => item.note)).toEqual(["earlier update nit", "the lock is never released"]);
	});

	it("interrupts at blocker severity when a queued note is re-raised as a blocker", async () => {
		const { tool, advise, delivered } = harness();
		tool.beginUpdate(true);
		await advise("tests never ran");
		expect(await advise("tests never ran", "blocker")).toBe("Delivered.");
		tool.beginUpdate(false);
		expect(delivered).toEqual([{ note: "tests never ran", severity: "blocker" }]);
	});
});
