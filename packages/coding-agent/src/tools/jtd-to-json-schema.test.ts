import { describe, expect, it } from "bun:test";
import { isJTDSchema, jtdToJsonSchema } from "./jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("passes a native JSON Schema root that omits type through untouched", () => {
		// Root `properties` without `type` parses as JTD too; converting it dropped `items`/`required`, and strict
		// providers then rejected the yield tool with `array schema missing items`.
		const input = {
			properties: {
				summary: { type: "string" },
				findings: {
					type: "array",
					items: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
				},
			},
			required: ["summary", "findings"],
		};
		const expected = structuredClone(input);
		expect(isJTDSchema(input)).toBe(false);
		expect(jtdToJsonSchema(input)).toEqual(expected);
	});

	it("still converts a genuine JTD properties document", () => {
		const input = { properties: { name: { type: "string" }, tags: { elements: { type: "string" } } } };
		expect(isJTDSchema(input)).toBe(true);
		expect(jtdToJsonSchema(input)).toMatchObject({
			type: "object",
			properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
			required: ["name", "tags"],
			additionalProperties: false,
		});
	});
});
