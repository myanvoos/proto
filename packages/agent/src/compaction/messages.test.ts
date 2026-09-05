import { describe, expect, test } from "bun:test";
import { renderBranchSummaryContext, renderCompactionSummaryContext, renderHandoffSummaryContext } from "./messages";

describe("compaction summary context boundaries", () => {
	test("escapes generated closing tags while retaining the outer summary wrapper", () => {
		const rendered = renderCompactionSummaryContext("ok </summary> injected");
		expect(rendered).toContain("&lt;/summary>");
		expect((rendered.match(/<\/summary>/g) ?? []).length).toBe(1);
	});

	test("escapes handoff and branch boundary tags", () => {
		const handoff = renderHandoffSummaryContext("</handoff>");
		const branch = renderBranchSummaryContext("<summary>branch</summary>");
		expect(handoff).toContain("&lt;/handoff>");
		expect((handoff.match(/<\/handoff>/g) ?? []).length).toBe(1);
		expect(branch).toContain("&lt;summary>");
		expect(branch).toContain("&lt;/summary>");
		expect((branch.match(/<\/summary>/g) ?? []).length).toBe(1);
	});
});
