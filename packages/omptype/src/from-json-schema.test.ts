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
