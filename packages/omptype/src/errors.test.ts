import { expect, test } from "bun:test";
import { type } from "./index";

test("required properties describe their expectation without a missing-value clause", () => {
	const schema = type({ message: type("string").describe("message for the worker") });

	let message = "";
	try {
		schema.assert({});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	expect(message).toBe("message is required (message for the worker)");
});
