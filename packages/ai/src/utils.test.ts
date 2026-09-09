import { describe, expect, it } from "bun:test";
import {
	normalizeResponsesToolCallId,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
	stripOpenAIResponsesOutputOnlyStatusesForReplay,
} from "./utils";

function sanitize(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return sanitizeOpenAIResponsesHistoryItemsForReplay(items) as unknown as Array<Record<string, unknown>>;
}

describe("OpenAI Responses replay hygiene", () => {
	it("drops a function call with truncated JSON arguments without dropping surrounding history", () => {
		const replay = sanitize([
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_1" },
			{
				type: "function_call",
				id: "fc_bad",
				call_id: "call_bad",
				name: "bash",
				arguments: '{"command":"printf unfinished',
			},
			{ type: "function_call_output", call_id: "call_bad", output: "durable result" },
		]);

		expect(replay.map(item => item.type)).toEqual(["reasoning", "function_call_output"]);
		expect(replay.some(item => item.type === "function_call")).toBe(false);
	});

	it("retains valid JSON arguments byte-for-byte", () => {
		const argumentsValue = '{"command":"echo ok"}';
		const replay = sanitize([
			{ type: "function_call", id: "fc_ok", call_id: "call_ok", name: "bash", arguments: argumentsValue },
		]);

		expect(replay).toEqual([{ type: "function_call", call_id: "call_ok", name: "bash", arguments: argumentsValue }]);
	});

	it("strips output-only status from compaction replay items", () => {
		const items: Array<Record<string, unknown>> = [
			{ type: "compaction", encrypted_content: "encrypted", status: "completed" },
			{ type: "compaction_summary", summary: "summary", status: "completed" },
		];
		const replay = stripOpenAIResponsesOutputOnlyStatusesForReplay(items);

		expect(replay).toEqual([
			{ type: "compaction", encrypted_content: "encrypted" },
			{ type: "compaction_summary", summary: "summary" },
		]);
	});

	it("preserves opaque call ids through normalization and native-history replay", () => {
		const opaqueCallId = `googleai-ts1:${"opaque/signature+token=.".repeat(8)}`;
		const itemId = `fcr_${"i".repeat(100)}`;

		expect(normalizeResponsesToolCallId(`${opaqueCallId}|${itemId}`).callId).toBe(opaqueCallId);
		expect(normalizeResponsesToolCallId(opaqueCallId).callId).toBe(opaqueCallId);

		const replay = sanitize([
			{
				type: "function_call",
				id: "fc_opaque",
				call_id: opaqueCallId,
				name: "lookup",
				arguments: "{}",
			},
			{ type: "function_call_output", call_id: opaqueCallId, output: "result" },
		]);

		expect(replay.map(item => item.call_id)).toEqual([opaqueCallId, opaqueCallId]);
	});
});
