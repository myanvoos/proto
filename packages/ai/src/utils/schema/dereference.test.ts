import { describe, expect, test } from "bun:test";
import { dereferenceJsonSchema } from "./dereference";
import { normalizeSchemaForMCP } from "./normalize";

interface SchemaNode {
	type?: string;
	required?: string[];
	properties?: Record<string, SchemaNode & { $ref?: string; enum?: string[] }>;
	$ref?: string;
	$defs?: Record<string, SchemaNode>;
	enum?: string[];
}

const RECURSIVE_SCHEMA = {
	type: "object",
	properties: { root: { $ref: "#/$defs/node" } },
	required: ["root"],
	$defs: {
		node: {
			type: "object",
			properties: {
				next: { $ref: "#/$defs/node" },
				value: { type: "string", enum: ["a", "b"] },
			},
			required: ["value"],
		},
	},
};

describe("dereferenceJsonSchema with recursive $defs", () => {
	test("non-cyclic edges are inlined with their constraints intact", () => {
		const out = dereferenceJsonSchema(RECURSIVE_SCHEMA) as SchemaNode;
		const root = out.properties?.root;
		expect(root?.type).toBe("object");
		expect(root?.required).toEqual(["value"]);
		expect(root?.properties?.value?.enum).toEqual(["a", "b"]);
	});

	test("the cyclic edge keeps a resolvable $ref instead of an unconstrained hole", () => {
		const out = dereferenceJsonSchema(RECURSIVE_SCHEMA) as SchemaNode;
		const next = out.properties?.root?.properties?.next;
		expect(next).toEqual({ $ref: "#/$defs/node" });
		expect(out.$defs?.node?.type).toBe("object");
		expect(out.$defs?.node?.required).toEqual(["value"]);
	});

	test("normalized MCP tool schema keeps the recursive constraints", () => {
		const normalized = normalizeSchemaForMCP(RECURSIVE_SCHEMA) as SchemaNode;
		expect(normalized.properties?.root?.required).toEqual(["value"]);
		expect(normalized.properties?.root?.properties?.value?.enum).toEqual(["a", "b"]);
		expect(normalized.properties?.root?.properties?.next).toEqual({ $ref: "#/$defs/node" });
		expect(normalized.$defs?.node?.type).toBe("object");
	});
});
