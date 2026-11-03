import { expect, spyOn, test } from "bun:test";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { tinyModelClient } from "../tiny/title-client";
import { classifyUnexpectedStop } from "./unexpected-stop-classifier";

test("stop classification supplies the operator request and bounds long pasted context", async () => {
	let input = "";
	const complete = spyOn(tinyModelClient, "complete").mockImplementation(async (_model, prompt) => {
		input = prompt;
		return "NO";
	});
	try {
		const result = await classifyUnexpectedStop(
			{ message: "The fix is done.", request: `  Implement cache eviction ${"x".repeat(3000)}  ` },
			{
				settings: Settings.isolated({ "providers.unexpectedStopModel": "qwen2.5-1.5b" }),
				registry: {} as ModelRegistry,
				sessionId: "classifier-test",
			},
		);
		expect(result).toBe(false);
		expect(input).toContain("Operator request:\nImplement cache eviction");
		expect(input).toContain("Message:\nThe fix is done.");
		expect(input).not.toContain("x".repeat(2001));
	} finally {
		complete.mockRestore();
	}
});
