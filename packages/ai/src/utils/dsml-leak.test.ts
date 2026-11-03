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
