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

test("constraint failures state the real constraint and the real value", () => {
	const schema = type({
		to: type("string > 0").describe("worker id from orchestrate_spawn / orchestrate_list"),
		lines: type("number > 0").describe("output lines; default 100, max 1000"),
	});

	const errors = schema.run({ to: "", lines: 0 });
	const messages = [...(errors as unknown as Iterable<{ message: string }>)].map(error => error.message);

	expect(messages).toEqual(['to must be at least length 1 (was "")', "lines must be positive (was 0)"]);
});

test("documented descriptions still explain missing values", () => {
	const schema = type({ to: type("string > 0").describe("worker id from orchestrate_spawn / orchestrate_list") });

	let message = "";
	try {
		schema.assert({});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	expect(message).toBe("to is required (worker id from orchestrate_spawn / orchestrate_list)");
});

test("long string values report their length instead of flooding the message", () => {
	const schema = type({ name: type("string < 10") });
	const errors = schema.run({ name: "x".repeat(64) });
	const messages = [...(errors as unknown as Iterable<{ message: string }>)].map(error => error.message);

	expect(messages).toEqual(["name must be at most length 9 (was a string (length 64))"]);
});
