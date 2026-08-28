import type { Type } from "@oh-my-pi/omptype";
import type { Tool, TSchema } from "../../types";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { stamp } from "./stamps";

export function isArkSchema(value: unknown): value is Type {
	return (
		typeof value === "function" &&
		typeof (value as { toJsonSchema?: unknown }).toJsonSchema === "function" &&
		typeof (value as { assert?: unknown }).assert === "function"
	);
}

function isArkJsonAst(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(isArkJsonAst);
	if (!isSchemaRecord(value)) return false;
	if (typeof value.domain === "string" || Object.hasOwn(value, "unit")) return true;
	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) return true;
	const required = value.required;
	return (
		Array.isArray(required) &&
		required.some(entry => isSchemaRecord(entry) && typeof entry.key === "string" && "value" in entry)
	);
}

function parseArkObjectKey(key: string): { name: string; description?: string } {
	const match = /^(.*?)\s*\/\*\*\s*([\s\S]*?)\s*\*\/\s*$/.exec(key);
	if (!match) return { name: key };
	return { name: match[1].trim(), description: match[2].trim() };
}

function withArkKeyDescription(schema: unknown, description: string | undefined): unknown {
	if (!description) return schema;
	if (isSchemaRecord(schema)) {
		if (typeof schema.description !== "string") schema.description = description;
		return schema;
	}
	return { anyOf: [schema], description };
}

function arkJsonAstToWire(value: unknown): unknown {
	if (typeof value === "string") {
		switch (value) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "object":
				return { type: value };
			case "unknown":
				return {};
			default:
				return {};
		}
	}

	if (Array.isArray(value)) {
		if (value.every(item => isSchemaRecord(item) && Object.hasOwn(item, "unit"))) {
			return { enum: value.map(item => (item as { unit: unknown }).unit) };
		}
		return { anyOf: value.map(arkJsonAstToWire) };
	}

	if (!isSchemaRecord(value)) return {};

	if (Object.hasOwn(value, "unit")) return { const: value.unit };

	if (value.proto === "Array" && Object.hasOwn(value, "sequence")) {
		return { type: "array", items: arkJsonAstToWire(value.sequence) };
	}

	if (value.domain === "object") {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		const addEntry = (entry: unknown, isRequired: boolean): void => {
			if (!isSchemaRecord(entry) || typeof entry.key !== "string" || !("value" in entry)) return;
			const key = parseArkObjectKey(entry.key);
			properties[key.name] = withArkKeyDescription(arkJsonAstToWire(entry.value), key.description);
			if (isRequired) required.push(key.name);
		};
		if (Array.isArray(value.required)) {
			for (const entry of value.required) addEntry(entry, true);
		}
		if (Array.isArray(value.optional)) {
			for (const entry of value.optional) addEntry(entry, false);
		}
		const schema: Record<string, unknown> = { type: "object", properties };
		if (required.length > 0) schema.required = required;
		return schema;
	}

	if (typeof value.domain === "string") return { type: value.domain };
	return {};
}

const kJsonWireSchema = Symbol("pi.schema.json.wire");
const kArkWireSchema = Symbol("pi.schema.ark.wire");
const kStrippedSchema = Symbol("pi.schema.descriptions.stripped");

function postProcessJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	walk(schema);
	normalizeArkPropertyComments(schema);
	normalizeEmptySchemas(schema);
	return schema;
}

const NULLABLE_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

const SCHEMA_DEFINING_SIBLING_KEYS = new Set([
	"$ref",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"enum",
	"if",
	"items",
	"not",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDefiningSibling(schema: Record<string, unknown>): boolean {
	for (const key in schema) {
		if (key !== "anyOf" && SCHEMA_DEFINING_SIBLING_KEYS.has(key)) return true;
	}
	return false;
}

function isNullVariant(schema: Record<string, unknown>): boolean {
	return schema.type === "null" && Object.keys(schema).length === 1;
}

function isScalarVariant(schema: Record<string, unknown>): schema is Record<string, unknown> & { type: string } {
	return typeof schema.type === "string" && NULLABLE_SCALAR_TYPES.has(schema.type);
}
function copyNullableScalarConstraints(schema: Record<string, unknown>, scalarVariant: Record<string, unknown>): void {
	for (const key in scalarVariant) {
		if (key === "type" || key === "enum" || key === "const" || Object.hasOwn(schema, key)) continue;
		schema[key] = scalarVariant[key];
	}

	if (Object.hasOwn(scalarVariant, "const")) {
		schema.enum = [scalarVariant.const, null];
		return;
	}

	const enumValues = scalarVariant.enum;
	if (Array.isArray(enumValues)) {
		schema.enum = enumValues.includes(null) ? enumValues : [...enumValues, null];
	}
}

function rewriteNullableScalarAnyOf(schema: Record<string, unknown>): void {
	if (hasSchemaDefiningSibling(schema)) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return;

	let scalarVariant: Record<string, unknown> | undefined;
	let scalarType: string | undefined;
	let sawNull = false;
	for (const variant of variants) {
		if (!isSchemaRecord(variant)) return;
		if (isNullVariant(variant)) {
			if (sawNull) return;
			sawNull = true;
			continue;
		}
		if (!isScalarVariant(variant) || scalarVariant) return;
		scalarVariant = variant;
		scalarType = variant.type;
	}
	if (!sawNull || !scalarVariant || !scalarType) return;

	delete schema.anyOf;
	copyNullableScalarConstraints(schema, scalarVariant);
	schema.type = [scalarType, "null"];
}

function isExclusiveRequiredBranch(branch: unknown): boolean {
	if (!isSchemaRecord(branch)) return false;
	if (Object.hasOwn(branch, "type")) return false;
	if (!Array.isArray(branch.required) || branch.required.length === 0) return false;
	if (!branch.required.every(name => typeof name === "string" && name.length > 0)) return false;
	for (const key in branch) {
		if (!Object.hasOwn(branch, key)) continue;
		if (key === "required" || key === "description" || key === "title") continue;
		return false;
	}
	return true;
}

export function flattenExclusiveRequiredRootUnion(schema: Record<string, unknown>): Record<string, unknown> {
	const unionKey = Array.isArray(schema.anyOf) ? "anyOf" : Array.isArray(schema.oneOf) ? "oneOf" : undefined;
	if (!unionKey) return schema;
	const union = schema[unionKey];
	if (!Array.isArray(union) || union.length === 0) return schema;
	const typedObject = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
	if (!typedObject && !isSchemaRecord(schema.properties)) return schema;
	if (!union.every(isExclusiveRequiredBranch)) return schema;
	const flattened = { ...schema };
	delete flattened[unionKey];
	return flattened;
}

const SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

function normalizeArkPropertyComments(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeArkPropertyComments(child);
		return;
	}
	if (!isSchemaRecord(node)) return;
	const obj = node as Record<string, unknown>;

	const properties = obj.properties;
	if (isSchemaRecord(properties)) {
		const required = Array.isArray(obj.required) ? obj.required : undefined;
		if (required) {
			obj.required = required.map(key => (typeof key === "string" ? parseArkObjectKey(key).name : key));
		}
		for (const key of Object.keys(properties)) {
			const parsed = parseArkObjectKey(key);
			const targetKey = parsed.name;
			let propertySchema = properties[key];
			if (parsed.description) {
				propertySchema = withArkKeyDescription(propertySchema, parsed.description);
				delete properties[key];
				properties[targetKey] = propertySchema;
			}
			normalizeArkPropertyComments(propertySchema);
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) normalizeArkPropertyComments(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		if (mapKey === "properties") continue;
		const map = obj[mapKey];
		if (isSchemaRecord(map)) {
			for (const key in map) normalizeArkPropertyComments(map[key]);
		}
	}
	for (const arrayKey of SCHEMA_ARRAY_KEYS) {
		const array = obj[arrayKey];
		if (Array.isArray(array)) {
			for (const child of array) normalizeArkPropertyComments(child);
		}
	}
}

function isEmptyObject(val: unknown): val is Record<string, never> {
	if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
	return Object.keys(val).length === 0;
}

function homogeneousEnumScalarType(values: readonly unknown[]): string | undefined {
	if (values.length === 0) return undefined;
	let inferred: string | undefined;
	for (const value of values) {
		let scalar: string | undefined;
		switch (typeof value) {
			case "string":
				scalar = "string";
				break;
			case "boolean":
				scalar = "boolean";
				break;
			case "number":
				scalar = "number";
				break;
			default:
				return undefined;
		}
		if (inferred === undefined) inferred = scalar;
		else if (inferred !== scalar) return undefined;
	}
	return inferred;
}

function inferBareEnumScalarType(obj: Record<string, unknown>): void {
	if ("type" in obj || !Array.isArray(obj.enum)) return;
	const inferred = homogeneousEnumScalarType(obj.enum);
	if (inferred !== undefined) obj.type = inferred;
}

function collapseConstUnionAnyOf(obj: Record<string, unknown>): void {
	if (hasSchemaDefiningSibling(obj) || "type" in obj) return;
	const variants = obj.anyOf;
	if (!Array.isArray(variants) || variants.length < 2) return;

	const values: unknown[] = [];
	let branchDescription: string | undefined;
	let describedCount = 0;
	for (const variant of variants) {
		if (!isSchemaRecord(variant) || !Object.hasOwn(variant, "const")) return;
		for (const key in variant) {
			if (key !== "const" && key !== "description") return;
		}
		const desc = variant.description;
		if (typeof desc === "string") {
			if (describedCount === 0) branchDescription = desc;
			else if (desc !== branchDescription) return;
			describedCount++;
		}
		values.push(variant.const);
	}
	if (describedCount !== 0 && describedCount !== variants.length) return;

	if (
		describedCount === variants.length &&
		typeof obj.description === "string" &&
		obj.description !== branchDescription
	) {
		return;
	}

	const scalarType = homogeneousEnumScalarType(values);
	if (scalarType === undefined) return;

	delete obj.anyOf;
	obj.type = scalarType;
	obj.enum = values;
	if (typeof obj.description !== "string" && branchDescription !== undefined) {
		obj.description = branchDescription;
	}
}

function walk(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	rewriteNullableScalarAnyOf(obj);
	inferBareEnumScalarType(obj);
	collapseConstUnionAnyOf(obj);
	for (const k in obj) walk(obj[k]);
}

export function normalizeEmptySchemas(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeEmptySchemas(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key) && isEmptyObject(obj[key])) obj[key] = true;
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const k in map as Record<string, unknown>) {
				if (isEmptyObject((map as Record<string, unknown>)[k])) (map as Record<string, unknown>)[k] = true;
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) {
			for (let i = 0; i < arr.length; i++) {
				if (isEmptyObject(arr[i])) arr[i] = true;
			}
		}
	}

	for (const k in obj) normalizeEmptySchemas(obj[k]);
}

function closeDeclaredObjects(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) closeDeclaredObjects(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	const isObjectType = obj.type === "object" || (Array.isArray(obj.type) && obj.type.includes("object"));
	if (
		isObjectType &&
		obj.properties !== undefined &&
		!("additionalProperties" in obj) &&
		!("patternProperties" in obj)
	) {
		obj.additionalProperties = false;
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) closeDeclaredObjects(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const k in map as Record<string, unknown>) closeDeclaredObjects((map as Record<string, unknown>)[k]);
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) closeDeclaredObjects(child);
	}
}

function isUnconstrainedSchema(val: unknown): boolean {
	return val === true || isEmptyObject(val);
}

function pruneArkUndefinedUnionBranches(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) pruneArkUndefinedUnionBranches(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	for (const unionKey of ["anyOf", "oneOf"] as const) {
		const branches = obj[unionKey];
		if (!Array.isArray(branches)) continue;
		const concrete = branches.filter(branch => !isUnconstrainedSchema(branch));
		if (concrete.length === branches.length || concrete.length === 0) continue;
		const only = concrete.length === 1 ? concrete[0] : undefined;
		if (only !== undefined && isSchemaRecord(only)) {
			delete obj[unionKey];
			for (const key in only) {
				if (!(key in obj)) obj[key] = only[key];
			}
		} else {
			obj[unionKey] = concrete;
		}
	}

	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(obj, key)) pruneArkUndefinedUnionBranches(obj[key]);
	}
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = obj[mapKey];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const key in map as Record<string, unknown>) {
				pruneArkUndefinedUnionBranches((map as Record<string, unknown>)[key]);
			}
		}
	}
	for (const arrKey of SCHEMA_ARRAY_KEYS) {
		const arr = obj[arrKey];
		if (Array.isArray(arr)) for (const child of arr) pruneArkUndefinedUnionBranches(child);
	}
}

export function arkToWireSchema(schema: Type): Record<string, unknown> {
	return stamp(schema, kArkWireSchema, s => {
		const raw = s.toJsonSchema({ target: "draft-2020-12", fallback: ctx => ctx.base }) as Record<string, unknown>;
		delete raw.$schema;
		pruneArkUndefinedUnionBranches(raw);
		const upgraded = postProcessJsonSchema(upgradeJsonSchemaTo202012(raw) as Record<string, unknown>);
		closeDeclaredObjects(upgraded);
		return upgraded;
	});
}

export function toolWireSchema(tool: Tool): Record<string, unknown> {
	const params: TSchema = tool.parameters;
	if (isArkSchema(params)) return arkToWireSchema(params);
	return stamp(params as Record<string, unknown>, kJsonWireSchema, p => {
		const raw = isArkJsonAst(p) ? arkJsonAstToWire(p) : p;
		const upgraded = upgradeJsonSchemaTo202012(raw) as Record<string, unknown>;
		return postProcessJsonSchema(upgraded);
	});
}

const STRIP_SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"additionalItems",
	"contains",
	"propertyNames",
	"contentSchema",
	"if",
	"then",
	"else",
	"not",
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
] as const;

const STRIP_SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

function stripSchemaDescriptionsInPlace(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) stripSchemaDescriptionsInPlace(child);
		return;
	}
	if (!isSchemaRecord(node)) return;
	delete node.description;
	for (const key of STRIP_SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(node, key)) stripSchemaDescriptionsInPlace(node[key]);
	}
	for (const mapKey of STRIP_SCHEMA_MAP_KEYS) {
		const map = node[mapKey];
		if (isSchemaRecord(map)) {
			for (const key in map) stripSchemaDescriptionsInPlace(map[key]);
		}
	}
}

export function stripSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
	return stamp(schema, kStrippedSchema, source => {
		const clone = structuredClone(source);
		stripSchemaDescriptionsInPlace(clone);
		return clone;
	});
}

export function stripToolDescriptions(tools: readonly Tool[]): Tool[] {
	return tools.map(tool => ({
		...tool,
		description: "",
		parameters: stripSchemaDescriptions(toolWireSchema(tool)),
	}));
}
