import { expect, it } from "bun:test";
import { enforceStrictSchema, schemaNeedsDraft202012Upgrade, toolWireSchema } from ".";

it("normalizes frozen tool parameters without modifying caller-owned required fields", () => {
	const parameters = Object.freeze({
		type: "object",
		properties: Object.freeze({ extra: Object.freeze({}) }),
		required: Object.freeze(["extra"]),
	});
	expect(toolWireSchema({ name: "t", description: "", parameters })).toEqual({
		type: "object",
		properties: { extra: true },
		required: ["extra"],
	});
	expect(parameters.properties.extra).toEqual({});
});

it("sends schemas carrying non-cloneable metadata to the wire without the metadata", () => {
	const parameters: Record<string, unknown> = {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		"x-proto-coerce": (value: unknown) => value,
	};
	expect(toolWireSchema({ name: "t", description: "", parameters })).toEqual({
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	});
	expect(typeof parameters["x-proto-coerce"]).toBe("function");
});

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
	Object.freeze(value);
}

it("keeps traversal state off caller graphs that are deep-frozen after a first visit", () => {
	const schema: Record<string, unknown> = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
	const expected = { ...schema, additionalProperties: false };
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	expect(enforceStrictSchema(schema)).toEqual(expected);
	deepFreeze(schema);
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	expect(enforceStrictSchema(schema)).toEqual(expected);
});
