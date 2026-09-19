import { expect, test } from "bun:test";
import { OmpErrors } from "./errors";
import { fromJsonSchema } from "./from-json-schema";

const BOTH_RUNTIMES = [true, true, true, true];

function results(schema: unknown, value: unknown): boolean[] {
	const validator = fromJsonSchema(schema);
	return Array.from({ length: 4 }, () => !(validator(value) instanceof OmpErrors));
}

function expectAccepted(schema: unknown, value: unknown): void {
	expect(results(schema, value)).toEqual(BOTH_RUNTIMES);
}

function expectRejected(schema: unknown, value: unknown): void {
	expect(results(schema, value)).toEqual(BOTH_RUNTIMES.map(() => false));
}

test("JSON Schema const and enum compare object and array values structurally", () => {
	expectAccepted({ type: "array", const: [1, { ok: true }] }, [1, { ok: true }]);
	expectAccepted({ type: "array", enum: [[1], [2]] }, [2]);
	expectAccepted({ const: { nested: [1, { ok: true }] } }, { nested: [1, { ok: true }] });
	expectRejected({ const: { nested: [1, { ok: true }] } }, { nested: [1, { ok: false }] });
	expectRejected({ const: { nested: [1] } }, { nested: [1], extra: true });

	expectAccepted({ enum: [["a", 1], { choice: 2 }] }, ["a", 1]);
	expectAccepted({ enum: [["a", 1], { choice: 2 }] }, { choice: 2 });
	expectRejected({ enum: [["a", 1], { choice: 2 }] }, { choice: 3 });
});

test("JSON Schema required enforces undeclared own keys without declaring them", () => {
	const required = { type: "object", required: ["x"] };
	expectRejected(required, {});
	expectAccepted(required, { x: 1 });
	expectRejected(required, Object.create({ x: 1 }));

	const closed = { type: "object", required: ["x"], additionalProperties: false };
	expectRejected(closed, {});
	expectRejected(closed, { x: 1 });

	const typedExtra = {
		type: "object",
		required: ["x"],
		additionalProperties: { type: "string" },
	};
	expectAccepted(typedExtra, { x: "present" });
	expectRejected(typedExtra, { x: 1 });
});

test("JSON Schema prefixItems keeps positions optional, permits trailing items, and honors bounds", () => {
	const openPrefix = { type: "array", prefixItems: [{ type: "string" }] };
	expectAccepted(openPrefix, []);
	expectAccepted(openPrefix, ["first", 2, { trailing: true }]);
	expectRejected(openPrefix, [1]);

	const bounded = {
		type: "array",
		prefixItems: [{ type: "string" }],
		minItems: 3,
		maxItems: 4,
	};
	expectAccepted(bounded, ["first", 2, 3]);
	expectRejected(bounded, ["first", 2]);
	expectRejected(bounded, ["first", 2, 3, 4, 5]);

	const short = { type: "array", prefixItems: [true, true], maxItems: 1 };
	expectRejected(short, [1, 2]);

	const closedPrefix = { type: "array", prefixItems: [{ type: "string" }], items: false };
	expectAccepted(closedPrefix, []);
	expectRejected(closedPrefix, ["first", "trailing"]);
});

test("JSON Schema oneOf is exact and combines with anyOf and sibling constraints", () => {
	const overlapping = {
		oneOf: [{ type: "number" }, { type: "integer" }],
	};
	expectRejected(overlapping, 1);
	expectAccepted(overlapping, 1.5);
	expectRejected(overlapping, "1");

	const combined = {
		type: "number",
		anyOf: [{ type: "number", minimum: 0 }, { const: -1 }],
		oneOf: [{ const: 1 }, { const: 2 }],
	};
	expectAccepted(combined, 1);
	expectRejected(combined, 3);
	expectRejected(combined, "1");

	const siblingType = { type: "string", oneOf: [true] };
	expectAccepted(siblingType, "value");
	expectRejected(siblingType, 1);
});

test("JSON Schema additionalProperties does not constrain declared properties", () => {
	const mixed = {
		type: "object",
		properties: { x: { type: "number" } },
		additionalProperties: { type: "string" },
	};
	expectAccepted(mixed, { x: 1 });
	expectAccepted(mixed, { x: 1, y: "ok" });
	expectRejected(mixed, { x: "bad" });
	expectRejected(mixed, { x: 1, y: 2 });
});

test("JSON Schema patternProperties constrains matching keys and closes via additionalProperties", () => {
	const pattern = {
		type: "object",
		patternProperties: { "^x-": { type: "string" } },
		additionalProperties: false,
	};
	expectAccepted(pattern, { "x-a": "ok" });
	expectRejected(pattern, { "x-a": 1 });
	expectRejected(pattern, { other: "ok" });
	expectRejected(pattern, { "x-a": "ok", other: 1 });

	const declaredAndPattern = {
		type: "object",
		properties: { x: { type: "number" } },
		patternProperties: { "^x-": { type: "string" } },
	};
	expectAccepted(declaredAndPattern, { x: 1, "x-a": "ok" });
	expectRejected(declaredAndPattern, { x: 1, "x-a": 2 });
});

test("JSON Schema nullable permits null alongside the declared type", () => {
	const nullable = { type: "string", nullable: true };
	expectAccepted(nullable, "ok");
	expectAccepted(nullable, null);
	expectRejected(nullable, 1);

	const nullableObject = { type: "object", properties: { x: { type: "number" } }, nullable: true };
	expectAccepted(nullableObject, { x: 1 });
	expectAccepted(nullableObject, null);
});

test("JSON Schema $ref resolves escaped JSON Pointer tokens", () => {
	const escaped = { $defs: { "a/b": { type: "string" } }, $ref: "#/$defs/a~1b" };
	expectAccepted(escaped, "ok");
	expectRejected(escaped, 1);

	const tilde = { $defs: { "a~b": { type: "string" } }, $ref: "#/$defs/a~0b" };
	expectAccepted(tilde, "ok");
	expectRejected(tilde, 1);
});

test("JSON Schema uniqueItems, contains, minProperties and not are enforced", () => {
	expectRejected({ type: "array", uniqueItems: true }, [1, 1]);
	expectAccepted({ type: "array", uniqueItems: true }, [1, 2]);
	expectRejected({ type: "array", uniqueItems: true }, [[1], [1]]);

	expectRejected({ type: "array", contains: { const: 1 } }, [2]);
	expectAccepted({ type: "array", contains: { const: 1 } }, [2, 1]);
	expectRejected({ type: "array", contains: { const: 1 }, minContains: 2 }, [2, 1]);

	expectRejected({ type: "object", minProperties: 1 }, {});
	expectAccepted({ type: "object", minProperties: 1 }, { a: 1 });
	expectRejected({ type: "object", maxProperties: 1 }, { a: 1, b: 2 });

	expectRejected({ type: "number", not: { minimum: 0 } }, 1);
	expectAccepted({ type: "number", not: { minimum: 0 } }, -1);
	expectRejected({ type: "string", not: {} }, "anything");
});

test("JSON Schema default fills a missing required property but required still applies without one", () => {
	const withDefault = {
		type: "object",
		properties: { x: { type: "string", default: "fallback" } },
		required: ["x"],
	};
	const validator = fromJsonSchema(withDefault);
	const filled = validator({});
	expect(filled).toEqual({ x: "fallback" });
	expectRejected(withDefault, { x: 1 });

	const noDefault = { type: "object", properties: { y: { type: "string" } }, required: ["y"] };
	expectRejected(noDefault, {});
});
