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

function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (!isJsonObject(node)) return node;
	if (Array.isArray(node)) return node.map(item => dereferenceNode(item, root, visiting));

	const ref = node.$ref;
	if (typeof ref === "string") {
		if (visiting.has(ref)) return {};
		const resolved = resolveLocalRef(ref, root);
		if (!resolved) return node;
		visiting.add(ref);
		const inlined = dereferenceNode(resolved, root, visiting);
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
			result[key] = value.map(item => dereferenceNode(item, root, visiting));
		} else if (isJsonObject(value)) {
			result[key] = dereferenceNode(value, root, visiting);
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

	return dereferenceNode(schema, schema, new Set());
}
