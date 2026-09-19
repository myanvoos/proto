import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	convertMessageToLlm,
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
	renderHandoffSummaryContext,
} from "./messages";

describe("pruned tool-result conversion", () => {
	test("retains images that shake deliberately preserved", () => {
		const image = { type: "image" as const, data: "IMAGE_DATA", mimeType: "image/png" };
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "capture",
			content: [{ type: "text", text: "caption" }, image],
			isError: false,
			timestamp: 0,
			prunedAt: 1,
		};

		const converted = convertMessageToLlm(message);
		if (!converted || !Array.isArray(converted.content)) throw new Error("expected converted content blocks");
		expect(converted.content).toEqual([{ type: "text", text: "caption" }, image]);
	});
});

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
