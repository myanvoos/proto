import { describe, expect, test } from "bun:test";
import { buildOutputValidator } from "./output-schema-validator";

describe("buildOutputValidator JTD definitions", () => {
	test("JTD ref resolves against root definitions", () => {
		const { validator, jsonSchema } = buildOutputValidator({
			definitions: { foo: { type: "string" } },
			properties: { x: { ref: "foo" } },
		});
		expect(jsonSchema).toBeDefined();
		expect((jsonSchema as Record<string, unknown>).$defs).toEqual({ foo: { type: "string" } });
		expect(validator).toBeDefined();
		expect(validator!.validate({ x: "ok" }).success).toBe(true);
		expect(validator!.validate({ x: 1 }).success).toBe(false);
	});

	test("root-level JTD ref resolves against definitions", () => {
		const { validator } = buildOutputValidator({ ref: "foo", definitions: { foo: { type: "string" } } });
		expect(validator).toBeDefined();
		expect(validator!.validate("ok").success).toBe(true);
		expect(validator!.validate(1).success).toBe(false);
	});
});

describe("buildOutputValidator JTD numeric types", () => {
	test("int8 enforces its range", () => {
		const { validator } = buildOutputValidator({ type: "int8" });
		expect(validator).toBeDefined();
		expect(validator!.validate(127).success).toBe(true);
		expect(validator!.validate(-128).success).toBe(true);
		expect(validator!.validate(128).success).toBe(false);
		expect(validator!.validate(-129).success).toBe(false);
	});

	test("uint8 rejects negatives and overflow", () => {
		const { validator } = buildOutputValidator({ type: "uint8" });
		expect(validator!.validate(0).success).toBe(true);
		expect(validator!.validate(255).success).toBe(true);
		expect(validator!.validate(-1).success).toBe(false);
		expect(validator!.validate(256).success).toBe(false);
	});

	test("int16 enforces its range", () => {
		const { validator } = buildOutputValidator({ type: "int16" });
		expect(validator!.validate(32767).success).toBe(true);
		expect(validator!.validate(32768).success).toBe(false);
	});

	test("uint32 enforces its range", () => {
		const { validator } = buildOutputValidator({ type: "uint32" });
		expect(validator!.validate(4294967295).success).toBe(true);
		expect(validator!.validate(4294967296).success).toBe(false);
	});

	test("timestamp rejects non-RFC 3339 strings", () => {
		const { validator } = buildOutputValidator({ type: "timestamp" });
		expect(validator!.validate("2026-09-20T12:34:56Z").success).toBe(true);
		expect(validator!.validate("not-a-timestamp").success).toBe(false);
		expect(validator!.validate(1).success).toBe(false);
	});
});

test("tuple normalization removes only optional non-nullable placeholders in each tuple item", () => {
	const { validator } = buildOutputValidator({
		type: "array",
		prefixItems: [{ type: "object", properties: { optional: { type: "string" } }, additionalProperties: false }],
		items: { type: "object", properties: { required: { type: "string" } }, required: ["required"] },
	});
	const normalized = validator!.normalize([{ optional: null }, { required: null }]);
	expect(normalized).toEqual([{}, { required: null }]);
	expect(validator!.validate(normalized).success).toBe(false);
});

test("rebuilding a mutated schema honors the new declaration without changing a prior validator", () => {
	const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
	const first = buildOutputValidator(schema).validator!;
	schema.properties.value.type = "number";
	const second = buildOutputValidator(schema).validator!;
	expect(second.validate({ value: "old" }).success).toBe(false);
	expect(second.validate({ value: 3 }).success).toBe(true);
	expect(first.validate({ value: "old" }).success).toBe(true);
	expect(first.validate({ value: 3 }).success).toBe(false);
});
