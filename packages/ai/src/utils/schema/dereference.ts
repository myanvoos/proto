import { isJsonObject, type JsonObject } from "./types";

function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
	const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
	if (!match) return undefined;

	const [, defsKey, name] = match;
	const defs = root[defsKey!];
	if (!isJsonObject(defs)) return undefined;

	const resolved = defs[name!];
	return isJsonObject(resolved) ? resolved : undefined;
}

interface DereferenceState {
	// Set when a cyclic $ref was preserved instead of inlined. The caller must
	// then keep $defs/definitions on the root so the preserved refs resolve.
	preservedCyclicRef: boolean;
}

function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>, state: DereferenceState): unknown {
	if (!isJsonObject(node)) return node;
	if (Array.isArray(node)) return node.map(item => dereferenceNode(item, root, visiting, state));

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
		const merged: JsonObject = { ...inlined, ...node };
		delete merged.$ref;
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];

		if (key === "$defs" || key === "definitions") continue;

		if (Array.isArray(value)) {
			result[key] = value.map(item => dereferenceNode(item, root, visiting, state));
		} else if (isJsonObject(value)) {
			result[key] = dereferenceNode(value, root, visiting, state);
		} else {
			result[key] = value;
		}
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
