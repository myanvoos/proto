import { parseLocalRefPointer } from "@oh-my-pi/omptype";
import { isJsonObject, type JsonObject } from "./types";

const SCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependencies: true,
	dependentSchemas: true,
};
const SCHEMA_ARRAY_KEYS: Record<string, true> = { anyOf: true, oneOf: true, allOf: true, prefixItems: true };
const SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	contains: true,
	contentSchema: true,
	propertyNames: true,
	if: true,
	then: true,
	else: true,
	not: true,
	additionalProperties: true,
	unevaluatedItems: true,
	unevaluatedProperties: true,
};

function dereferenceKeyword(
	key: string,
	value: unknown,
	root: JsonObject,
	visiting: Set<string>,
	state: DereferenceState,
): unknown {
	if (Object.hasOwn(SCHEMA_MAP_KEYS, key) && isJsonObject(value)) {
		const result: JsonObject = {};
		for (const name in value) result[name] = dereferenceNode(value[name], root, visiting, state);
		return result;
	}
	if ((Object.hasOwn(SCHEMA_ARRAY_KEYS, key) || key === "items") && Array.isArray(value)) {
		return value.map(item => dereferenceNode(item, root, visiting, state));
	}
	if (Object.hasOwn(SCHEMA_VALUE_KEYS, key)) return dereferenceNode(value, root, visiting, state);
	return value;
}

function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
	// Only handle local refs: #/$defs/Name or #/definitions/Name
	const pointer = parseLocalRefPointer(ref);
	if (pointer === undefined || pointer.length !== 2) return undefined;
	const defsKey = pointer[0];
	if (defsKey !== "$defs" && defsKey !== "definitions") return undefined;
	const defs = root[defsKey];
	if (!isJsonObject(defs)) return undefined;
	const resolved = defs[pointer[1]!];
	return isJsonObject(resolved) ? resolved : undefined;
}

interface DereferenceState {
	// Set when a cyclic $ref was preserved instead of inlined. The caller must
	// then keep $defs/definitions on the root so the preserved refs resolve.
	preservedCyclicRef: boolean;
}

function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>, state: DereferenceState): unknown {
	if (!isJsonObject(node)) return node;

	const ref = node.$ref;
	if (typeof ref === "string") {
		if (visiting.has(ref)) {
			// Cyclic reference: inlining would recurse forever, and replacing the
			// edge with {} would silently accept anything. Keep the $ref (with any
			// siblings) verbatim so the schema stays constrained and resolvable.
			state.preservedCyclicRef = true;
			return node;
		}
		const resolved = resolveLocalRef(ref, root);
		if (!resolved) return node;
		visiting.add(ref);
		const inlined = dereferenceNode(resolved, root, visiting, state);
		visiting.delete(ref);

		let hasSiblings = false;
		for (const k in node) {
			if (k !== "$ref") {
				hasSiblings = true;
				break;
			}
		}
		if (!hasSiblings || !isJsonObject(inlined)) return inlined;
		const merged: JsonObject = { ...inlined };
		for (const key in node) {
			if (key === "$ref" || key === "$defs" || key === "definitions") continue;
			merged[key] = dereferenceKeyword(key, node[key], root, visiting, state);
		}
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];

		if (key === "$defs" || key === "definitions") continue;

		result[key] = dereferenceKeyword(key, value, root, visiting, state);
	}
	return result;
}

export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isJsonObject(schema)) return schema;

	const hasDefs = schema.$defs !== undefined || schema.definitions !== undefined;
	if (!hasDefs) return schema;

	const state: DereferenceState = { preservedCyclicRef: false };
	const result = dereferenceNode(schema, schema, new Set(), state);

	// Cyclic schemas keep their $ref/$defs graph: drop the defs only when every
	// reference was fully inlined.
	if (state.preservedCyclicRef && isJsonObject(result)) {
		for (const key of ["$defs", "definitions"] as const) {
			if (schema[key] !== undefined && !Object.hasOwn(result, key)) {
				result[key] = schema[key];
			}
		}
	}
	return result;
}
