import { expect, test } from "bun:test";
import type { Tool, ToolCall } from "../../types";
import { validateToolArguments } from "../validation";
import { schemaDefinesProperty, validateJsonSchemaValue } from "./json-schema-validator";

test("JSON Schema $ref validates adjacent sibling keywords (2020-12)", () => {
	const schema = {
		$defs: { name: { type: "string", minLength: 3 } },
		$ref: "#/$defs/name",
		maxLength: 5,
	};
	expect(validateJsonSchemaValue(schema, "abc").success).toBe(true);
	expect(validateJsonSchemaValue(schema, "toolong").success).toBe(false);
	expect(validateJsonSchemaValue(schema, "no").success).toBe(false);

	const refOnly = { $defs: { name: { type: "string" } }, $ref: "#/$defs/name" };
	expect(validateJsonSchemaValue(refOnly, "ok").success).toBe(true);
	expect(validateJsonSchemaValue(refOnly, 1).success).toBe(false);
});

test("JSON Schema unevaluatedProperties rejects keys no schema evaluated", () => {
	const schema = {
		type: "object",
		properties: { x: { type: "number" } },
		unevaluatedProperties: false,
	};
	expect(validateJsonSchemaValue(schema, { x: 1 }).success).toBe(true);
	const result = validateJsonSchemaValue(schema, { x: 1, y: 2 });
	expect(result.success).toBe(false);
	expect(result.issues.some(issue => issue.path.join(".") === "y")).toBe(true);

	const patternEvaluated = {
		type: "object",
		patternProperties: { "^x-": { type: "string" } },
		unevaluatedProperties: false,
	};
	expect(validateJsonSchemaValue(patternEvaluated, { "x-a": "ok" }).success).toBe(true);
	expect(validateJsonSchemaValue(patternEvaluated, { "x-a": "ok", other: 1 }).success).toBe(false);

	const branchEvaluated = {
		type: "object",
		anyOf: [{ properties: { a: { type: "string" } }, required: ["a"] }],
		unevaluatedProperties: false,
	};
	expect(validateJsonSchemaValue(branchEvaluated, { a: "ok" }).success).toBe(true);
	expect(validateJsonSchemaValue(branchEvaluated, { a: "ok", b: 1 }).success).toBe(false);
});

test("JSON Schema unevaluatedItems rejects indices no schema evaluated", () => {
	const schema = {
		type: "array",
		prefixItems: [{ type: "number" }],
		unevaluatedItems: false,
	};
	expect(validateJsonSchemaValue(schema, [1]).success).toBe(true);
	expect(validateJsonSchemaValue(schema, [1, "two"]).success).toBe(false);
});

test("JSON Schema minLength and maxLength count code points, not UTF-16 units", () => {
	const maxLength = { type: "string", maxLength: 1 };
	expect(validateJsonSchemaValue(maxLength, "💩").success).toBe(true);
	expect(validateJsonSchemaValue(maxLength, "ab").success).toBe(false);

	const minLength = { type: "string", minLength: 2 };
	expect(validateJsonSchemaValue(minLength, "💩💩").success).toBe(true);
	// one astral character is one code point: UTF-16 counting would wrongly accept it
	expect(validateJsonSchemaValue(minLength, "💩").success).toBe(false);
	expect(validateJsonSchemaValue(minLength, "a").success).toBe(false);
});

test("JSON Schema date-time format is enforced for RFC 3339 family", () => {
	const schema = { type: "string", format: "date-time" };
	expect(validateJsonSchemaValue(schema, "2026-09-20T12:34:56Z").success).toBe(true);
	expect(validateJsonSchemaValue(schema, "2026-09-20T12:34:56.123+02:00").success).toBe(true);
	expect(validateJsonSchemaValue(schema, "not-a-timestamp").success).toBe(false);
	expect(validateJsonSchemaValue(schema, "2026-13-45T99:00:00Z").success).toBe(false);
});

test("failed union with no matching branch reports the alternatives, not one arbitrary branch", () => {
	const schema = {
		oneOf: [
			{ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
			{ type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false },
		],
	};
	const result = validateJsonSchemaValue(schema, {});
	expect(result.success).toBe(false);
	const messages = result.issues.map(issue => `${issue.path.map(String).join(".")}: ${issue.message}`);
	expect(messages.some(message => message.startsWith("a:"))).toBe(true);
	expect(messages.some(message => message.startsWith("b:"))).toBe(true);
});

test("failed union skips unsatisfiable false branches when describing alternatives", () => {
	const schema = {
		oneOf: [
			false,
			{ type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false },
		],
	};
	const result = validateJsonSchemaValue(schema, {});
	expect(result.success).toBe(false);
	expect(result.issues.some(issue => issue.keyword === "false")).toBe(false);
	expect(result.issues.some(issue => issue.path.join(".") === "b")).toBe(true);
});

test("validateToolArguments error names every viable union alternative", () => {
	const tool = {
		name: "pick",
		description: "pick a or b",
		parameters: {
			oneOf: [
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
				{ type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false },
			],
		},
	} as unknown as Tool;
	const toolCall = { name: "pick", arguments: {} } as unknown as ToolCall;
	expect(() => validateToolArguments(tool, toolCall)).toThrow(/a: is required[\s\S]*b: is required/);
});

test.each([
	["composed branch declares it", { anyOf: [{ properties: { i: { type: "string" } } }, { properties: {} }] }, true],
	["conditional predicate reads it", { if: { properties: { i: { const: "x" } } }, then: {} }, true],
	["legacy dependency requires it", { dependencies: { mode: ["i"] } }, true],
	["object const carries it", { const: { i: "x" } }, true],
	["propertyNames admits it", { propertyNames: { const: "i" } }, true],
	[
		"propertyNames admits it but the object is closed",
		{ propertyNames: { const: "i" }, additionalProperties: false },
		false,
	],
	["a false property schema forbids it", { properties: { i: false } }, false],
	["not-required prohibits its presence", { not: { required: ["i"] } }, false],
	["not constrains its value", { not: { properties: { i: { const: "x" } } } }, true],
	["only an unused definition mentions it", { $defs: { unused: { properties: { i: {} } } }, properties: {} }, false],
	["a local $ref declares it", { $defs: { base: { properties: { i: {} } } }, $ref: "#/$defs/base" }, true],
	["a nested object declares it", { properties: { nested: { properties: { i: {} } } } }, false],
])("schemaDefinesProperty: %s", (_label, schema, owned) => {
	expect(schemaDefinesProperty(schema, "i")).toBe(owned);
});

test("union repair keeps required nullable data another candidate needs while coercing", () => {
	const tool: Tool = {
		name: "union-required-null",
		description: "",
		parameters: {
			type: "object",
			properties: {
				payload: {
					oneOf: [
						{
							type: "object",
							additionalProperties: false,
							properties: { count: { type: "number" } },
							required: ["count"],
						},
						{
							type: "object",
							additionalProperties: false,
							properties: { count: { type: "number" }, keep: { type: "null" } },
							required: ["count", "keep"],
						},
					],
				},
			},
			required: ["payload"],
		} as never,
	};
	const args = { payload: { count: "1", keep: null } };
	const toolCall: ToolCall = { type: "toolCall", id: "required-null", name: tool.name, arguments: args };
	expect(validateToolArguments(tool, toolCall)).toEqual({ payload: { count: 1, keep: null } });
	expect(args).toEqual({ payload: { count: "1", keep: null } });
});
