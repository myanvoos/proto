import { expect, test } from "bun:test";
import { OmpErrors } from "./errors";
import { Type } from "./typebox";

test("exponent numeric bounds validate and survive nested JSON Schema emission", () => {
	const small = Type.Number({ exclusiveMinimum: -1e-7, maximum: 1e-7 });
	expect(small(-1e-7)).toBeInstanceOf(OmpErrors);
	expect(small(2e-7)).toBeInstanceOf(OmpErrors);
	expect(small(0)).toBe(0);
	const large = Type.Integer({ minimum: 1e21, exclusiveMaximum: 1e22 });
	expect(large(1e21 - 1e6)).toBeInstanceOf(OmpErrors);
	expect(large(1e22)).toBeInstanceOf(OmpErrors);
	expect(large(1e21)).toBe(1e21);
	expect(Type.Object({ small }).toJsonSchema()).toEqual({
		type: "object",
		properties: { small: { type: "number", exclusiveMinimum: -1e-7, maximum: 1e-7 } },
		required: ["small"],
	});
	expect(() => Type.Number({ minimum: 1e21, maximum: 1 })).toThrow();
	expect(() => Type.Number({ minimum: 1e-7, exclusiveMaximum: 1e-7 })).toThrow();
});
