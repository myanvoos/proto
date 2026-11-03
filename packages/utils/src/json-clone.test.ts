import { describe, expect, it } from "bun:test";
import { cloneJsonTree } from "./index";

describe("JSON tree cloning", () => {
	it("isolates nested request mutation while preserving unsafe JSON keys as own data", () => {
		const source = JSON.parse('{"input":[{"arguments":{"nested":[1]}}],"__proto__":{"unsafe":true}}');
		const cloned = cloneJsonTree(source);
		cloned.input[0].arguments.nested.push(2);
		expect(source.input[0].arguments.nested).toEqual([1]);
		expect(cloned.input[0].arguments.nested).toEqual([1, 2]);
		expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
		expect(Object.hasOwn(cloned, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(cloned, "__proto__")?.value).toEqual({ unsafe: true });
	});

	it("uses the established JSON conversion for non-JSON class instances", () => {
		const cloned: unknown = cloneJsonTree({ date: new Date(0) });
		expect(cloned).toEqual({ date: "1970-01-01T00:00:00.000Z" });
	});
});
