import { expect, test } from "bun:test";
import { type } from "./index";

const Op = type('"init" | "start" | "done"').describe("operation to apply");

test("a described enum reports its allowed values when a present value is wrong", () => {
	const schema = type({ op: Op });
	const result = schema({ op: "create" });
	expect(result instanceof type.errors).toBe(true);
	if (!(result instanceof type.errors)) return;
	expect(result.summary).toBe('op must be "init", "start" or "done" (was "create")');
});

test("a described enum still cites its description when the value is missing", () => {
	const schema = type({ op: Op });
	const result = schema({});
	expect(result instanceof type.errors).toBe(true);
	if (!(result instanceof type.errors)) return;
	expect(result.summary).toBe("op is required (operation to apply)");
});

test("describing a non-enum member keeps the description as the expectation", () => {
	const schema = type({ task: type("string").describe("task content") });
	const result = schema({ task: 5 });
	expect(result instanceof type.errors).toBe(true);
	if (!(result instanceof type.errors)) return;
	expect(result.summary).toBe("task must be a string (was a number)");
});

test("a described union that is not an enum keeps its description", () => {
	const schema = type({ id: type("string|number").describe("an identifier") });
	const result = schema({ id: true });
	expect(result instanceof type.errors).toBe(true);
	if (!(result instanceof type.errors)) return;
	expect(result.summary).toBe("id must be an identifier (was true)");
});

test("a nested literal union is expanded through every level", () => {
	const schema = type({ op: type('"a" | "b"').or(type('"c"')).describe("op") });
	const result = schema({ op: true });
	expect(result instanceof type.errors).toBe(true);
	if (!(result instanceof type.errors)) return;
	expect(result.summary).toBe('op must be "a", "b" or "c" (was true)');
});
