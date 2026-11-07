import { expect, test } from "bun:test";
import { OmpErrors } from "./errors";
import { fromJsonSchema } from "./from-json-schema";
import { type } from "./type";

test("local definition references decode URI fragments before JSON Pointer escapes", () => {
	const imported = fromJsonSchema({
		$defs: { "a%2Fb /~1 空\n": { type: "string" }, "a/b /~1 空\n": { type: "boolean" } },
		$ref: "#/$defs/a%252Fb%20~1~01%20%E7%A9%BA%0A",
	});
	expect(imported(false)).toBeInstanceOf(OmpErrors);
	expect(imported("value")).toBe("value");
	const empty = fromJsonSchema({ definitions: { "": { type: "integer" } }, $ref: "#/definitions/" });
	expect(empty(2.5)).toBeInstanceOf(OmpErrors);
	expect(empty(2)).toBe(2);
	for (const ref of ["#/$defs/%E0%A4%A", "https://example.com/schema#/$defs/value"]) {
		expect(() => fromJsonSchema({ $ref: ref })).toThrow(
			ref.startsWith("#") ? `invalid $ref: ${ref}` : `unresolved $ref: ${ref}`,
		);
	}
	const remote = fromJsonSchema(
		{ $ref: "https://example.com/schema#/$defs/value" },
		{ schemas: { "https://example.com/schema": { $defs: { value: { type: "string" } } } } },
	);
	expect(remote("value")).toBe("value");
	expect(remote(1)).toBeInstanceOf(OmpErrors);
});

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

	const strict = fromJsonSchema(withDefault, { fillDefaultedRequired: false });
	expect(strict({})).toBeInstanceOf(OmpErrors);
});

test("JSON Schema formats keep their built-in checks and accept caller overrides", () => {
	const email = { type: "string", format: "email" };
	expect(fromJsonSchema(email)("a@omp.sh")).toBe("a@omp.sh");
	expect(fromJsonSchema(email)("nope")).toBeInstanceOf(OmpErrors);
	expect(fromJsonSchema(email, { formats: { email: value => value.includes("@") } })("nope@")).toBe("nope@");
	expect(fromJsonSchema({ format: "custom" })("anything")).toBe("anything");
	expect(fromJsonSchema({ type: "number", format: "email" }, { formats: { email: () => false } })(42)).toBe(42);
});

test("JSON Schema recursive references terminate and report nested paths", () => {
	const node = fromJsonSchema({
		$defs: {
			node: {
				type: "object",
				properties: { value: { type: "number" }, next: { $ref: "#/$defs/node" } },
				required: ["value"],
			},
		},
		$ref: "#/$defs/node",
	});
	expect(node({ value: 1, next: { value: 2 } })).toEqual({ value: 1, next: { value: 2 } });
	const invalid = node({ value: 1, next: { value: "two" } });
	expect(invalid).toBeInstanceOf(OmpErrors);
	if (invalid instanceof OmpErrors) expect(invalid[0].path).toEqual(["next", "value"]);
});

test("JSON Schema draft selects $ref sibling semantics", () => {
	const schema = { $defs: { text: { type: "string" } }, $ref: "#/$defs/text", maxLength: 1 };
	expect(fromJsonSchema(schema)("long")).toBeInstanceOf(OmpErrors);
	expect(fromJsonSchema(schema, { draft: "7" })("long")).toBe("long");
});

test("JSON Schema validation stays consistent once the generated validator takes over", () => {
	const validator = fromJsonSchema({
		type: "object",
		properties: { id: { type: "string", pattern: "^[a-z]+$" }, n: { type: "integer", minimum: 0 } },
		required: ["id"],
	});
	for (let i = 0; i < 100; i++) {
		expect(validator.allows({ id: "abc", n: i })).toBe(true);
		expect(validator.allows({ id: "ABC", n: i })).toBe(false);
	}
	expect(validator({ id: "abc" })).toEqual({ id: "abc" });
	expect(validator({ id: 1 })).toBeInstanceOf(OmpErrors);
});

test("JSON Schema import round-trips the source document and its constraints", () => {
	const original = type({
		name: "1 <= string <= 32",
		"retries?": "number.integer >= 0",
		mode: "'read' | 'write'",
		tags: "string[]",
	});
	const emitted = original.toJsonSchema();
	const imported = fromJsonSchema(emitted);
	expect(imported.toJsonSchema()).toEqual(emitted);
	const valid = { name: "job", mode: "read", tags: ["a"] };
	expect(imported(valid)).toEqual(valid);
	expect(imported({ name: "job", mode: "delete", tags: [] })).toBeInstanceOf(OmpErrors);
	expect(imported({ name: "", mode: "read", tags: [] })).toBeInstanceOf(OmpErrors);
	expect(imported({ mode: "read", tags: [] })).toBeInstanceOf(OmpErrors);
});
