import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createMockModel } from "../providers/mock";
import type { AssistantMessage } from "../types";
import { isDsmlLeakRecoveryTarget, removeDsmlToolMarkupLeak, stripDsmlToolMarkup } from "./dsml-leak";

const leaked = 'keep\n\nbash\n<｜DSML｜parameter name="command">rm -rf</｜DSML｜parameter>\n\nafter';

test("unquoted broken calls are removed while quoted markup remains literal", () => {
	expect(stripDsmlToolMarkup(leaked)).toBe("keep\n\nafter");
	expect(stripDsmlToolMarkup('`<｜DSML｜invoke name="bash">`')).toBeUndefined();
	expect(stripDsmlToolMarkup("before <｜tool▁calls▁begin｜>broken<｜tool▁calls▁end｜> after")).toBe("before\n\nafter");
});

test.each(["openai-completions", "openrouter"] as const)(
	"%s preserves reasoning replay markers but drops rewritten opaque signatures",
	api => {
		const message = {
			role: "assistant",
			api,
			content: [
				{ type: "thinking", thinking: leaked, thinkingSignature: "opaque-signed-content" },
				{ type: "thinking", thinking: leaked, thinkingSignature: "reasoning_content" },
			],
		} as AssistantMessage;
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "keep\n\nafter", thinkingSignature: "reasoning_content" },
		]);
	},
);

test("DeepSeek leak recovery recognizes retained model ids, wire ids and display names without removed identity metadata", () => {
	const model = createMockModel({ id: "unclassified", provider: "custom" });
	expect(isDsmlLeakRecoveryTarget({ ...model, id: "deepseek/deepseek-v4-flash" })).toBe(true);
	expect(isDsmlLeakRecoveryTarget({ ...model, requestModelId: "DeepSeek-V3.2" })).toBe(true);
	expect(isDsmlLeakRecoveryTarget({ ...model, name: "DeepSeek Hosted" })).toBe(true);
	expect(isDsmlLeakRecoveryTarget(model)).toBe(false);
	expect(
		isDsmlLeakRecoveryTarget(
			buildModel({ ...model, api: "openai-completions", compat: { streamMarkupHealingPattern: "dsml" } }),
		),
	).toBe(true);
});

test("leaked DSML tails are cut from structured tool-call string arguments while quoted DSML is kept", () => {
	const quoted = 'grep "<｜DSML｜parameter"';
	const message = {
		role: "assistant",
		api: "openai-completions",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: {
					command: "ls</｜DSML｜ parameter><｜DSML｜ parameter name=",
					nested: { list: ["ok", "cat</｜｜DSML｜｜parameter>"] },
					pattern: quoted,
				},
			},
		],
	} as unknown as AssistantMessage;
	expect(removeDsmlToolMarkupLeak(message)).toBe(true);
	expect(message.content).toEqual([
		{
			type: "toolCall",
			id: "call_1",
			name: "bash",
			arguments: { command: "ls", nested: { list: ["ok", "cat"] }, pattern: quoted },
		},
	]);
});

test("native Responses replay payload is cleaned of leaked DSML in text, reasoning and arguments", () => {
	const leakedArgs = { i: "Read the struct</｜DSML｜ parameter><｜DSML｜ parameter name=", path: "src/dict.rs" };
	const untouched = { type: "function_call", call_id: "call_2", name: "read", arguments: '{"path":"a"}' };
	const message = {
		role: "assistant",
		api: "openai-responses",
		content: [{ type: "text", text: "Checking." }],
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "reasoning",
					id: "rs_1",
					summary: [],
					content: [{ type: "reasoning_text", text: "Plan.</｜｜DSML｜｜parameter>" }],
				},
				{
					type: "reasoning",
					id: "rs_2",
					summary: [],
					content: [{ type: "reasoning_text", text: "</｜｜DSML｜｜parameter>" }],
				},
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					content: [{ type: "output_text", text: "Checking.</｜｜DSML｜｜invoke>" }],
				},
				{ type: "function_call", call_id: "call_1", name: "read", arguments: JSON.stringify(leakedArgs) },
				untouched,
			],
		},
	} as unknown as AssistantMessage;
	expect(removeDsmlToolMarkupLeak(message)).toBe(true);
	const payload = message.providerPayload;
	expect(payload?.type).toBe("openaiResponsesHistory");
	if (payload?.type !== "openaiResponsesHistory") return;
	expect(JSON.stringify(payload.items)).not.toContain("DSML");
	expect(payload.items).toEqual([
		{ type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "Plan." }] },
		{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
		{
			type: "function_call",
			call_id: "call_1",
			name: "read",
			arguments: JSON.stringify({ i: "Read the struct", path: "src/dict.rs" }),
		},
		untouched,
	]);
	expect(payload.items[3]).toBe(untouched);
});
