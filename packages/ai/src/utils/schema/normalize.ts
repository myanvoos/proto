import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "./equality";
import {
	ALL_CCA_TYPE_SPECIFIC_KEYS,
	CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS,
	CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS,
	COMBINATOR_KEYS,
	LIFTABLE_TO_DESCRIPTION_FIELDS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "./fields";
import { isValidJsonSchema } from "./meta-validator";
import { type DescriptionSpillFormat, spillToDescription } from "./spill";
import { enter, epochNext, exit, once, stamp } from "./stamps";
import { isJsonObject, isJsonObjectEmpty, type JsonObject } from "./types";

export type ResidualSchemaIncompatibility = "type-array" | "type-null" | "nullable" | "combiners" | "not";

export interface NormalizeSchemaOptions {
	coerceBooleanSubschemas?: "standard" | "permissive";
	unsupportedFields: (key: string) => boolean;
	normalizeFieldNames: boolean;
	collapseNullFields: boolean;
	normalizeTypeArrayToNullable: boolean;
	stripNullableKeyword: boolean;
	autoPropertyOrdering: boolean;
	ensureObjectProperties: boolean;
	liftStrippedToDescription:
		| false
		| {
				keys?: (key: string) => boolean;
				format?: DescriptionSpillFormat;
		  };
	mergeObjectCombiners: boolean;
	collapseSameTypeCombiners: boolean;
	collapseMixedTypeCombiners: boolean;
	stripResidualCombinersFixpoint: boolean;
	extractNullableFromUnions: boolean;
	inferTypeForBareEnum: boolean;
	foldOneOfIntoAnyOf: boolean;
	dropNonScalarEnum: boolean;
	stringEnumsOnly?: boolean;
	rejectResidualIncompatibilities?: ReadonlyArray<ResidualSchemaIncompatibility>;
	validateAndFallback?: { fallback: unknown };
}

interface NormalizeSchemaWalkOptions extends NormalizeSchemaOptions {
	insideSchemaMap: boolean;

	booleanIsSubschema: boolean;
}

interface ResidualIncompatibilityChecks {
	typeArray: boolean;
	typeNull: boolean;
	nullable: boolean;
	combiners: boolean;
	not: boolean;
}

const SNAKE_TO_CAMEL_RENAMES = new Map<string, string>([
	["additional_properties", "additionalProperties"],
	["any_of", "anyOf"],
	["prefix_items", "prefixItems"],
	["property_ordering", "propertyOrdering"],
]);

const JSON_SCHEMA_COMBINERS = ["anyOf", "oneOf"] as const;
const CCA_FORBIDDEN_COMBINERS = new Set(["anyOf", "oneOf", "allOf"]);

const SUBSCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	unevaluatedItems: true,
	not: true,
	if: true,

	then: true,
	else: true,
	contains: true,
	propertyNames: true,
	contentSchema: true,
};

const BOOLEAN_OR_SCHEMA_VALUE_KEYS: Record<string, true> = {
	additionalProperties: true,
	unevaluatedProperties: true,
};

const SUBSCHEMA_ARRAY_KEYS: Record<string, true> = {
	anyOf: true,
	oneOf: true,
	allOf: true,
	prefixItems: true,
};

const SUBSCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependencies: true,
	dependentSchemas: true,
	$defs: true,
	definitions: true,
};

type SchemaChildKind = "schema" | "map";

function classifySchemaChild(key: string, value: unknown, insideSchemaMap: boolean): SchemaChildKind | undefined {
	if (insideSchemaMap) return "schema";
	const normalizedKey = SNAKE_TO_CAMEL_RENAMES.get(key) ?? key;
	if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, normalizedKey)) return "map";
	if (Object.hasOwn(SUBSCHEMA_VALUE_KEYS, normalizedKey) || Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, normalizedKey)) {
		return "schema";
	}
	if (Object.hasOwn(BOOLEAN_OR_SCHEMA_VALUE_KEYS, normalizedKey) && isJsonObject(value)) return "schema";
	return undefined;
}

function hasUnrepresentableGoogleEnumConstraint(
	value: unknown,
	insideSchemaMap = false,
	seen = new Set<object>(),
): boolean {
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		return value.some(entry => hasUnrepresentableGoogleEnumConstraint(entry, false, seen));
	}
	if (!isJsonObject(value)) return false;
	if (seen.has(value)) return false;
	seen.add(value);

	if (insideSchemaMap) {
		for (const key in value) {
			if (Object.hasOwn(value, key) && hasUnrepresentableGoogleEnumConstraint(value[key], false, seen)) {
				return true;
			}
		}
		return false;
	}

	if (
		Array.isArray(value.enum) &&
		(value.enum.length === 0 || value.enum.some(enumValue => typeof enumValue !== "string"))
	) {
		return true;
	}
	if (Object.hasOwn(value, "const") && typeof value.const !== "string") return true;

	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const childKind = classifySchemaChild(key, value[key], false);
		if (childKind && hasUnrepresentableGoogleEnumConstraint(value[key], childKind === "map", seen)) {
			return true;
		}
	}
	return false;
}

const CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA = {
	type: "object",
	properties: {},
} as const;

function isGoogleUnsupportedSchemaField(key: string): boolean {
	return Object.hasOwn(UNSUPPORTED_SCHEMA_FIELDS, key);
}

function isMcpUnsupportedSchemaField(key: string): boolean {
	return key === "$schema";
}

function isMoonshotUnsupportedSchemaField(key: string): boolean {
	if (key === "default") return false;
	return Object.hasOwn(NON_STRUCTURAL_SCHEMA_KEYS, key) || key === "prefixItems";
}

function isDefaultLiftableToDescriptionField(key: string): boolean {
	return Object.hasOwn(LIFTABLE_TO_DESCRIPTION_FIELDS, key);
}

function applySnakeCaseRenames(obj: JsonObject): JsonObject {
	let needsRename = false;
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		if (SNAKE_TO_CAMEL_RENAMES.has(k)) {
			needsRename = true;
			break;
		}
	}
	if (!needsRename) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (!Object.hasOwn(obj, k)) continue;
		const renamed = SNAKE_TO_CAMEL_RENAMES.get(k);
		if (renamed !== undefined) {
			out[renamed] = obj[k];
		} else if (!outHasOwn(out, k)) {
			out[k] = obj[k];
		}
	}
	return out;
}

function preHandleNullFields(obj: JsonObject): JsonObject {
	if (obj.type === "null") {
		const out: JsonObject = {};
		for (const k in obj) {
			if (!Object.hasOwn(obj, k) || k === "type") continue;
			out[k] = obj[k];
		}
		out.nullable = true;
		return out;
	}
	if (!Array.isArray(obj.anyOf)) return obj;
	const variants = obj.anyOf as unknown[];
	let sawNull = false;
	const kept: unknown[] = [];
	for (const v of variants) {
		if (isJsonObject(v) && v.type === "null") {
			sawNull = true;
			continue;
		}
		kept.push(v);
	}
	if (!sawNull) return obj;
	const out: JsonObject = {};
	for (const k in obj) {
		if (Object.hasOwn(obj, k)) out[k] = obj[k];
	}
	out.nullable = true;
	if (kept.length === 0) {
		delete out.anyOf;
	} else if (kept.length === 1 && isJsonObject(kept[0])) {
		delete out.anyOf;
		const only = kept[0];
		for (const k in only) {
			if (Object.hasOwn(only, k) && !outHasOwn(out, k)) out[k] = only[k];
		}
	} else {
		out.anyOf = kept;
	}
	return out;
}

function outHasOwn(obj: JsonObject, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return undefined;
	}
}

function pushEnumValue(values: unknown[], value: unknown): void {
	if (!values.some(existing => areJsonValuesEqual(existing, value))) {
		values.push(value);
	}
}

function pushStrippedDescriptionEntry(
	spill: Array<[string, unknown]> | undefined,
	key: string,
	value: unknown,
	options: NormalizeSchemaWalkOptions,
): Array<[string, unknown]> | undefined {
	const lift = options.liftStrippedToDescription;
	if (!lift) return spill;
	const isLiftable = lift.keys ?? isDefaultLiftableToDescriptionField;
	if (!isLiftable(key)) return spill;
	const next = spill ?? [];
	next.push([key, value]);
	return next;
}

function applyDescriptionSpill(
	result: JsonObject,
	spill: Array<[string, unknown]> | undefined,
	options: NormalizeSchemaWalkOptions,
): void {
	const lift = options.liftStrippedToDescription;
	if (!lift || spill === undefined) return;
	spillToDescription(result, spill, lift.format ?? "spill");
}

function normalizeSchemaNode(value: unknown, options: NormalizeSchemaWalkOptions): unknown {
	if (Array.isArray(value)) {
		if (!enter(value)) return [];
		try {
			return value.map(entry => normalizeSchemaNode(entry, options));
		} finally {
			exit(value);
		}
	}
	if (typeof value === "boolean") {
		const mode = options.coerceBooleanSubschemas;
		if (!mode || !options.booleanIsSubschema) return value;
		return value || mode === "permissive" ? {} : { not: {} };
	}
	if (!isJsonObject(value)) {
		return value;
	}

	if (!enter(value)) return {};
	try {
		return normalizeSchemaObjectNode(value, options);
	} finally {
		exit(value);
	}
}

function normalizeSchemaObjectNode(value: JsonObject, options: NormalizeSchemaWalkOptions): unknown {
	let obj = options.normalizeFieldNames && !options.insideSchemaMap ? applySnakeCaseRenames(value) : value;
	if (options.collapseNullFields && !options.insideSchemaMap) {
		obj = preHandleNullFields(obj);
	}
	const result: JsonObject = {};
	let spill: Array<[string, unknown]> | undefined;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (!Array.isArray(obj[combiner])) continue;
		const variants = obj[combiner] as JsonObject[];
		const allHaveConst = variants.every(v => isJsonObject(v) && "const" in v);
		if (!allHaveConst || variants.length === 0) continue;

		const dedupedEnum: unknown[] = [];
		for (const variant of variants) {
			pushEnumValue(dedupedEnum, variant.const);
		}
		result.enum = dedupedEnum;

		const explicitTypes = variants
			.map(variant => variant.type)
			.filter((variantType): variantType is string => typeof variantType === "string");
		const allHaveSameExplicitType =
			explicitTypes.length === variants.length &&
			explicitTypes.every(variantType => variantType === explicitTypes[0]);
		if (allHaveSameExplicitType && explicitTypes[0]) {
			result.type = explicitTypes[0];
		} else {
			const inferredTypes = dedupedEnum
				.map(enumValue => inferJsonSchemaTypeFromValue(enumValue))
				.filter((inferredType): inferredType is string => inferredType !== undefined);
			const inferredTypeSet = new Set(inferredTypes);
			if (inferredTypeSet.size === 1) {
				result.type = inferredTypes[0];
			} else {
				const nonNullInferredTypes = inferredTypes.filter(inferredType => inferredType !== "null");
				const nonNullTypeSet = new Set(nonNullInferredTypes);
				if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
					result.type = nonNullInferredTypes[0];
					if (!options.stripNullableKeyword) {
						result.nullable = true;
					}
				}
			}
		}

		for (const key in obj) {
			if (!Object.hasOwn(obj, key) || key === combiner || outHasOwn(result, key)) continue;
			const entry = obj[key];
			if (!options.insideSchemaMap && options.unsupportedFields(key)) {
				spill = pushStrippedDescriptionEntry(spill, key, entry, options);
				continue;
			}
			if (options.stripNullableKeyword && key === "nullable") continue;
			if (
				options.stringEnumsOnly &&
				!options.insideSchemaMap &&
				key === "not" &&
				hasUnrepresentableGoogleEnumConstraint(entry)
			) {
				continue;
			}
			const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
			result[key] = childKind
				? normalizeSchemaNode(entry, {
						...options,
						insideSchemaMap: childKind === "map",
						booleanIsSubschema: childKind === "schema",
					})
				: entry;
		}
		applyDescriptionSpill(result, spill, options);
		return applyNodePostProcessing(result, options);
	}

	let constValue: unknown;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const entry = obj[key];
		if (!options.insideSchemaMap && options.unsupportedFields(key)) {
			spill = pushStrippedDescriptionEntry(spill, key, entry, options);
			continue;
		}
		if (options.stripNullableKeyword && key === "nullable") continue;
		if (key === "const") {
			constValue = entry;
			continue;
		}
		if (
			options.stringEnumsOnly &&
			!options.insideSchemaMap &&
			key === "not" &&
			hasUnrepresentableGoogleEnumConstraint(entry)
		) {
			continue;
		}
		const childKind = classifySchemaChild(key, entry, options.insideSchemaMap);
		result[key] = childKind
			? normalizeSchemaNode(entry, {
					...options,
					insideSchemaMap: childKind === "map",
					booleanIsSubschema: childKind === "schema",
				})
			: entry;
	}

	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
	if (constValue !== undefined) {
		const existingEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(existingEnum, constValue);
		result.enum = existingEnum;
		if (!result.type) {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}

	if (
		options.inferTypeForBareEnum &&
		!result.type &&
		!Array.isArray(result.anyOf) &&
		!Array.isArray(result.oneOf) &&
		Array.isArray(result.enum) &&
		result.enum.length > 0
	) {
		const enumTypes = (result.enum as unknown[]).map(inferJsonSchemaTypeFromValue);
		if (enumTypes.every((t): t is string => typeof t === "string") && new Set(enumTypes).size === 1) {
			result.type = enumTypes[0];
		}
	}

	if (options.collapseNullFields && result.type === "null") {
		delete result.type;
		if (!options.stripNullableKeyword) result.nullable = true;
	}

	if (
		options.autoPropertyOrdering &&
		result.type === "object" &&
		!outHasOwn(result, "propertyOrdering") &&
		isJsonObject(result.properties)
	) {
		const props = result.properties;
		const keys: string[] = [];
		for (const k in props) {
			if (Object.hasOwn(props, k)) keys.push(k);
		}
		if (keys.length > 1) result.propertyOrdering = keys;
	}

	if (options.ensureObjectProperties && result.type === "object" && !outHasOwn(result, "properties")) {
		result.properties = {};
	}

	applyDescriptionSpill(result, spill, options);
	return applyNodePostProcessing(result, options);
}

function applyNodePostProcessing(schema: JsonObject, options: NormalizeSchemaWalkOptions): JsonObject {
	let current = schema;
	for (const combiner of JSON_SCHEMA_COMBINERS) {
		if (options.mergeObjectCombiners) current = mergeObjectCombinerVariants(current, combiner);
		if (options.collapseMixedTypeCombiners) current = collapseMixedTypeCombinerVariants(current, combiner);
		if (options.collapseSameTypeCombiners) current = collapseSameTypeCombinerVariants(current, combiner);
	}
	if (options.foldOneOfIntoAnyOf) current = foldOneOfIntoAnyOf(current);
	if (options.dropNonScalarEnum) current = dropNonScalarEnumForMfjs(current);
	if (options.stringEnumsOnly && options.booleanIsSubschema) current = dropNonStringEnumForGoogle(current);
	return current;
}

function foldOneOfIntoAnyOf(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.oneOf)) return schema;
	const rest = copySchemaWithout(schema, "oneOf");
	const existing = Array.isArray(rest.anyOf) ? (rest.anyOf as unknown[]) : [];
	rest.anyOf = [...existing, ...(schema.oneOf as unknown[])];
	return rest;
}

function dropNonScalarEnumForMfjs(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.enum)) return schema;
	const allScalar = (schema.enum as unknown[]).every(v => typeof v === "string" || typeof v === "number");
	if (allScalar) return schema;
	return copySchemaWithout(schema, "enum");
}

function dropNonStringEnumForGoogle(schema: JsonObject): JsonObject {
	if (!Array.isArray(schema.enum)) return schema;
	const isStringEnum = schema.enum.length > 0 && schema.enum.every(value => typeof value === "string");
	return isStringEnum ? schema : copySchemaWithout(schema, "enum");
}

export function copySchemaWithout(schema: JsonObject, combiner: string): JsonObject {
	const { [combiner]: _, ...rest } = schema;
	return rest;
}

function mergeObjectCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry)) {
			return schema;
		}
		const variantType = entry.type;
		const hasObjectShape =
			isJsonObject(entry.properties) ||
			Array.isArray(entry.required) ||
			Object.hasOwn(entry, "additionalProperties");
		if (variantType === undefined && !hasObjectShape) {
			return schema;
		}
		if (variantType !== undefined && variantType !== "object") {
			return schema;
		}
		if (entry.properties !== undefined && !isJsonObject(entry.properties)) {
			return schema;
		}
		if (entry.required !== undefined && !Array.isArray(entry.required)) {
			return schema;
		}
		variants.push(entry);
	}

	const mergedProperties: JsonObject = {};
	const ownProperties = isJsonObject(schema.properties) ? schema.properties : {};
	for (const name in ownProperties) {
		if (Object.hasOwn(ownProperties, name)) mergedProperties[name] = ownProperties[name];
	}

	for (const variant of variants) {
		const properties = isJsonObject(variant.properties) ? variant.properties : {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const propertySchema = properties[name];
			const existingSchema = mergedProperties[name];
			mergedProperties[name] =
				existingSchema === undefined ? propertySchema : mergePropertySchemas(existingSchema, propertySchema);
		}
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	nextSchema.type = "object";
	nextSchema.properties = mergedProperties;

	let requiredIntersection: string[] | undefined;
	for (const variant of variants) {
		const variantRequired = Array.isArray(variant.required)
			? variant.required.filter((r): r is string => typeof r === "string")
			: [];
		if (requiredIntersection === undefined) {
			requiredIntersection = [...variantRequired];
		} else {
			const reqSet = new Set(variantRequired);
			requiredIntersection = requiredIntersection.filter(r => reqSet.has(r));
		}
	}
	const parentRequired = Array.isArray(schema.required)
		? schema.required.filter((r): r is string => typeof r === "string")
		: [];
	const safeRequired = new Set<string>();
	for (const name of requiredIntersection ?? []) {
		if (Object.hasOwn(mergedProperties, name)) safeRequired.add(name);
	}
	for (const name of parentRequired) {
		if (Object.hasOwn(ownProperties, name) && Object.hasOwn(mergedProperties, name)) {
			safeRequired.add(name);
		}
	}
	const requiredInPropertyOrder: string[] = [];
	for (const name in mergedProperties) {
		if (Object.hasOwn(mergedProperties, name) && safeRequired.has(name)) requiredInPropertyOrder.push(name);
	}
	if (requiredInPropertyOrder.length > 0) {
		nextSchema.required = requiredInPropertyOrder;
	} else {
		delete nextSchema.required;
	}

	return nextSchema;
}

function collapseMixedTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
		return schema;
	}

	const seenTypes = new Set<string>();
	const variantTypes: string[] = [];
	const mergedVariantFields: JsonObject = {};
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") {
			return schema;
		}

		const variantType = entry.type;
		if (seenTypes.has(variantType)) {
			return schema;
		}

		const allowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[variantType];
		if (!allowedKeys) {
			return schema;
		}

		for (const key in entry) {
			if (!Object.hasOwn(entry, key)) continue;
			const variantValue = entry[key];
			if (key === "type") continue;
			if (!Object.hasOwn(allowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
				return schema;
			}

			const existingValue = mergedVariantFields[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, variantValue)) {
				if (key !== "description") return schema;

				mergedVariantFields[key] = mergeSchemaDescriptions(existingValue, variantValue);
				continue;
			}
			mergedVariantFields[key] = variantValue;
		}

		seenTypes.add(variantType);
		variantTypes.push(variantType);
	}

	if (variantTypes.length < 2 || variantTypes.every(type => type === "object")) {
		return schema;
	}
	const nextSchema = copySchemaWithout(schema, combiner);
	const nonNullTypes = variantTypes.filter(t => t !== "null");
	const chosenType: string = nonNullTypes[0] ?? variantTypes[0];
	nextSchema.type = chosenType;
	const chosenTypeAllowedKeys = CLOUD_CODE_ASSIST_TYPE_SPECIFIC_KEYS[chosenType] ?? {};

	for (const key in nextSchema) {
		if (!Object.hasOwn(nextSchema, key)) continue;
		if (key === "type") continue;
		if (
			Object.hasOwn(ALL_CCA_TYPE_SPECIFIC_KEYS, key) &&
			!Object.hasOwn(chosenTypeAllowedKeys, key) &&
			!Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)
		) {
			delete nextSchema[key];
		}
	}

	for (const key in mergedVariantFields) {
		if (!Object.hasOwn(mergedVariantFields, key)) continue;

		if (!Object.hasOwn(chosenTypeAllowedKeys, key) && !Object.hasOwn(CLOUD_CODE_ASSIST_SHARED_SCHEMA_KEYS, key)) {
			continue;
		}
		const value = mergedVariantFields[key];
		const existingValue = nextSchema[key];
		if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
			if (key !== "description") return schema;
			nextSchema[key] = mergeSchemaDescriptions(existingValue, value);
			continue;
		}
		if (existingValue === undefined) {
			nextSchema[key] = value;
		}
	}
	return nextSchema;
}

function mergeSchemaDescriptions(existing: unknown, incoming: unknown): string {
	if (typeof existing !== "string") return typeof incoming === "string" ? incoming : "";
	if (typeof incoming !== "string" || incoming.length === 0 || existing === incoming) return existing;
	if (existing.length === 0) return incoming;
	return `${existing}\n\n${incoming}`;
}

function collapseSameTypeCombinerVariants(schema: JsonObject, combiner: "anyOf" | "oneOf"): JsonObject {
	const variantsRaw = schema[combiner];
	if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return schema;
	let commonType: string | undefined;
	const variants: JsonObject[] = [];
	for (const entry of variantsRaw) {
		if (!isJsonObject(entry) || typeof entry.type !== "string") return schema;
		if (commonType === undefined) commonType = entry.type;
		else if (entry.type !== commonType) return schema;
		variants.push(entry);
	}
	const firstEntry = variants[0];
	if (!firstEntry) return schema;

	const enumVariantCount = variants.reduce((n, variant) => n + (Array.isArray(variant.enum) ? 1 : 0), 0);

	let collapsed: JsonObject;
	if (enumVariantCount === variants.length) {
		let merged: JsonObject | null = firstEntry;
		for (let i = 1; i < variants.length && merged !== null; i++) {
			merged = mergeCompatibleEnumSchemas(merged, variants[i]);
		}
		if (merged === null) return schema;
		collapsed = merged;
	} else if (enumVariantCount > 0) {
		collapsed = variants.find(variant => !Array.isArray(variant.enum)) ?? firstEntry;
	} else {
		collapsed = firstEntry;
	}

	const nextSchema = copySchemaWithout(schema, combiner);
	for (const key in collapsed) {
		if (Object.hasOwn(collapsed, key) && !outHasOwn(nextSchema, key)) nextSchema[key] = collapsed[key];
	}
	return nextSchema;
}

export function stripResidualCombiners(value: unknown, epoch: number = epochNext()): unknown {
	return stripResidualCombinersNode(value, epoch, false);
}

function stripResidualCombinersNode(value: unknown, epoch: number, insideSchemaMap: boolean): unknown {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return [];
		return value.map(entry => stripResidualCombinersNode(entry, epoch, false));
	}
	if (!isJsonObject(value)) return value;
	if (!once(value, epoch)) return {};
	const result: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		result[key] = childKind ? stripResidualCombinersNode(entry, epoch, childKind === "map") : entry;
	}
	if (insideSchemaMap) return result;

	let current: JsonObject = result;
	let changed = true;
	while (changed) {
		changed = false;
		for (const combiner of JSON_SCHEMA_COMBINERS) {
			const sameType = collapseSameTypeCombinerVariants(current, combiner);
			if (sameType !== current) {
				current = sameType;
				changed = true;
			}
			const mixed = collapseMixedTypeCombinerVariants(current, combiner);
			if (mixed !== current) {
				current = mixed;
				changed = true;
			}
		}
	}
	return current;
}

interface NullableExtractionResult {
	schema: unknown;
	nullable: boolean;
}

function extractNullableUnionSchema(schema: unknown): NullableExtractionResult {
	if (!isJsonObject(schema)) {
		return { schema, nullable: false };
	}

	if (schema.nullable === true) {
		const nextSchema = { ...schema };
		delete nextSchema.nullable;
		return { schema: nextSchema, nullable: true };
	}

	if (Array.isArray(schema.type)) {
		const typeVariants = schema.type.filter((entry): entry is string => typeof entry === "string");
		const nonNullTypes = typeVariants.filter(entry => entry !== "null");
		if (typeVariants.includes("null") && nonNullTypes.length === 1) {
			const nextSchema = { ...schema, type: nonNullTypes[0] };
			return { schema: nextSchema, nullable: true };
		}
	}

	for (const combiner of JSON_SCHEMA_COMBINERS) {
		const variantsRaw = schema[combiner];
		if (!Array.isArray(variantsRaw)) continue;

		let hasNullVariant = false;
		const nonNullVariants: unknown[] = [];
		for (const variant of variantsRaw) {
			if (isJsonObject(variant) && variant.type === "null") {
				let keyCount = 0;
				for (const k in variant) {
					if (!Object.hasOwn(variant, k)) continue;
					if (++keyCount > 1) break;
				}
				if (keyCount === 1) {
					hasNullVariant = true;
					continue;
				}
			}
			nonNullVariants.push(variant);
		}

		if (!hasNullVariant || nonNullVariants.length !== 1 || !isJsonObject(nonNullVariants[0])) {
			continue;
		}

		const nextSchema = copySchemaWithout(schema, combiner);
		const nonNullVariant = nonNullVariants[0];
		for (const key in nonNullVariant) {
			if (!Object.hasOwn(nonNullVariant, key)) continue;
			const value = nonNullVariant[key];
			const existingValue = nextSchema[key];
			if (existingValue !== undefined && !areJsonValuesEqual(existingValue, value)) {
				return { schema, nullable: false };
			}
			if (existingValue === undefined) {
				nextSchema[key] = value;
			}
		}
		return { schema: nextSchema, nullable: true };
	}

	return { schema, nullable: false };
}

interface NullableNormalizationResult {
	schema: unknown;
	nullable: boolean;
}

function normalizeNullablePropertiesForCloudCodeAssist(
	value: unknown,
	isPropertySchema = false,
	epoch: number = epochNext(),
	insideSchemaMap = false,
): NullableNormalizationResult {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) {
			return { schema: [], nullable: false };
		}
		return {
			schema: value.map(entry => normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch).schema),
			nullable: false,
		};
	}
	if (!isJsonObject(value)) {
		return { schema: value, nullable: false };
	}
	if (!once(value, epoch)) {
		return { schema: {}, nullable: false };
	}

	const normalized: JsonObject = {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		normalized[key] = childKind
			? normalizeNullablePropertiesForCloudCodeAssist(entry, false, epoch, childKind === "map").schema
			: entry;
	}
	if (insideSchemaMap) return { schema: normalized, nullable: false };

	if (isJsonObject(normalized.properties)) {
		const properties = normalized.properties;
		const required = new Set(
			Array.isArray(normalized.required)
				? normalized.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const nextProperties: JsonObject = {};
		for (const name in properties) {
			if (!Object.hasOwn(properties, name)) continue;
			const normalizedProperty = normalizeNullablePropertiesForCloudCodeAssist(properties[name], true, epoch);
			nextProperties[name] = normalizedProperty.schema;
			if (normalizedProperty.nullable) {
				required.delete(name);
			}
		}
		normalized.properties = nextProperties;
		if (Array.isArray(normalized.required)) {
			normalized.required = Array.from(required);
		}
	}

	if (!isPropertySchema) {
		return { schema: normalized, nullable: false };
	}

	return extractNullableUnionSchema(normalized);
}

function createResidualIncompatibilityChecks(
	checks: ReadonlyArray<ResidualSchemaIncompatibility> | undefined,
): ResidualIncompatibilityChecks | undefined {
	if (!checks || checks.length === 0) return undefined;
	const result: ResidualIncompatibilityChecks = {
		typeArray: false,
		typeNull: false,
		nullable: false,
		combiners: false,
		not: false,
	};
	for (const check of checks) {
		switch (check) {
			case "type-array":
				result.typeArray = true;
				break;
			case "type-null":
				result.typeNull = true;
				break;
			case "nullable":
				result.nullable = true;
				break;
			case "not":
				result.not = true;
				break;
			case "combiners":
				result.combiners = true;
				break;
		}
	}
	return result;
}

function hasResidualSchemaIncompatibilities(
	value: unknown,
	checks: ResidualIncompatibilityChecks,
	epoch: number = epochNext(),
	insideSchemaMap = false,
): boolean {
	if (Array.isArray(value)) {
		if (!once(value, epoch)) return false;
		return value.some(entry => hasResidualSchemaIncompatibilities(entry, checks, epoch, false));
	}
	if (!isJsonObject(value)) {
		return false;
	}
	if (!once(value, epoch)) {
		return false;
	}

	if (!insideSchemaMap) {
		if (checks.typeArray && Array.isArray(value.type)) return true;
		if (checks.typeNull && value.type === "null") return true;
		if (checks.nullable && Object.hasOwn(value, "nullable")) return true;
		if (checks.not && Object.hasOwn(value, "not")) return true;
		if (checks.combiners) {
			for (const combiner of CCA_FORBIDDEN_COMBINERS) {
				if (Array.isArray(value[combiner])) return true;
			}
		}
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const entry = value[key];
		const childKind = classifySchemaChild(key, entry, insideSchemaMap);
		if (childKind && hasResidualSchemaIncompatibilities(entry, checks, epoch, childKind === "map")) {
			return true;
		}
	}
	return false;
}

export function normalizeSchema(value: unknown, options: NormalizeSchemaOptions): unknown {
	const upgraded = upgradeJsonSchemaTo202012(value);
	const dereferenced = dereferenceJsonSchema(upgraded);
	let normalized = normalizeSchemaNode(dereferenced, {
		...options,
		insideSchemaMap: false,
		booleanIsSubschema: true,
	});
	if (options.stripResidualCombinersFixpoint) {
		normalized = stripResidualCombiners(normalized);
	}
	if (options.extractNullableFromUnions) {
		normalized = normalizeNullablePropertiesForCloudCodeAssist(normalized).schema;
	}
	const residualChecks = createResidualIncompatibilityChecks(options.rejectResidualIncompatibilities);
	if (residualChecks && hasResidualSchemaIncompatibilities(normalized, residualChecks)) {
		logger.debug("Schema has residual provider incompatibilities, using fallback");
		return options.validateAndFallback?.fallback ?? normalized;
	}
	if (options.validateAndFallback && !isValidJsonSchema(normalized)) {
		logger.debug("Schema failed validation, using fallback");
		return options.validateAndFallback.fallback;
	}
	return normalized;
}

export function normalizeSchemaForGoogle(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "standard",
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: true,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: false,
		autoPropertyOrdering: true,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		stringEnumsOnly: true,
		foldOneOfIntoAnyOf: false,
	});
}

export function normalizeSchemaForCCA(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "standard",
		unsupportedFields: isGoogleUnsupportedSchemaField,
		normalizeFieldNames: true,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: true,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: true,
		collapseSameTypeCombiners: true,
		collapseMixedTypeCombiners: true,
		stripResidualCombinersFixpoint: true,
		extractNullableFromUnions: true,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: false,
		foldOneOfIntoAnyOf: false,
		rejectResidualIncompatibilities: ["type-array", "type-null", "nullable", "combiners", "not"],
		validateAndFallback: { fallback: CLOUD_CODE_ASSIST_CLAUDE_FALLBACK_SCHEMA },
	});
}

export function normalizeSchemaForMCP(value: unknown): unknown {
	return normalizeSchema(value, {
		unsupportedFields: isMcpUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: false,
		foldOneOfIntoAnyOf: false,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: false,
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: false,
		dropNonScalarEnum: false,
	});
}

export function normalizeSchemaForMoonshot(value: unknown): unknown {
	return normalizeSchema(value, {
		coerceBooleanSubschemas: "permissive",
		unsupportedFields: isMoonshotUnsupportedSchemaField,
		normalizeFieldNames: false,
		collapseNullFields: false,
		normalizeTypeArrayToNullable: true,
		stripNullableKeyword: true,
		autoPropertyOrdering: false,
		ensureObjectProperties: false,
		liftStrippedToDescription: { format: "spill" },
		mergeObjectCombiners: false,
		collapseSameTypeCombiners: false,
		collapseMixedTypeCombiners: false,
		stripResidualCombinersFixpoint: false,
		extractNullableFromUnions: false,
		inferTypeForBareEnum: true,
		dropNonScalarEnum: true,
		foldOneOfIntoAnyOf: true,
	});
}

const OLLAMA_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

const OPEN_SUBSCHEMA_WIDENING = Object.freeze({
	anyOf: [
		{ type: "string" },
		{ type: "number" },
		{ type: "boolean" },
		{ type: "object" },
		{ type: "array" },
		{ type: "null" },
	],
});

export function sanitizeSchemaForOllama(schema: JsonObject): JsonObject {
	const normalizeNode = (value: unknown): unknown => {
		if (value === true) return OPEN_SUBSCHEMA_WIDENING;
		if (value === false) return { not: OPEN_SUBSCHEMA_WIDENING };
		if (!isJsonObject(value)) {
			if (!Array.isArray(value)) return value;
			let changed = false;
			const output = value.map(item => {
				const next = normalizeNode(item);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? output : value;
		}

		let changed = false;
		const output: JsonObject = {};
		let typeAlternatives: JsonObject[] | undefined;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const child = value[key];
			if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") {
				changed = true;
				continue;
			}
			if (key === "type" && Array.isArray(child)) {
				const variants = child.filter((entry): entry is string => typeof entry === "string");
				const uniqueVariants = [...new Set(variants)];
				const nonNull = uniqueVariants.filter(entry => entry !== "null");
				if (nonNull.length <= 1) {
					output.type = nonNull[0] ?? uniqueVariants[0] ?? child[0];
				} else {
					typeAlternatives = uniqueVariants.map(entry => ({ type: entry }));
				}
				changed = true;
				continue;
			}

			let next = child;
			if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
				let mapChanged = false;
				const mapOutput: JsonObject = {};
				for (const childKey in child) {
					if (!Object.hasOwn(child, childKey)) continue;
					const mapChild = child[childKey];
					const normalizedChild = normalizeNode(mapChild);
					if (normalizedChild !== mapChild) mapChanged = true;
					mapOutput[childKey] = normalizedChild;
				}
				next = mapChanged ? mapOutput : child;
			} else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
				let arrayChanged = false;
				const arrayOutput = child.map(item => {
					const normalizedItem = normalizeNode(item);
					if (normalizedItem !== item) arrayChanged = true;
					return normalizedItem;
				});
				next = arrayChanged ? arrayOutput : child;
			} else if (OLLAMA_SCHEMA_VALUE_KEYS.has(key)) {
				next = normalizeNode(child);
			}
			if (next !== child) changed = true;
			output[key] = next;
		}

		if (typeAlternatives) {
			const existingAllOf = output.allOf;
			const typeUnion = { anyOf: typeAlternatives };
			output.allOf = Array.isArray(existingAllOf) ? [typeUnion, ...existingAllOf] : [typeUnion];
		}

		return changed ? output : value;
	};
	return normalizeNode(schema) as JsonObject;
}

const GRAMMAR_SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	contains: true,
	contentSchema: true,
	propertyNames: true,
	if: true,

	then: true,
	else: true,
	not: true,
	unevaluatedItems: true,
};

export function sanitizeSchemaForGrammar(schema: JsonObject): JsonObject {
	const normalizeNode = (value: unknown, isSubschema: boolean): unknown => {
		if (value === true) return isSubschema ? OPEN_SUBSCHEMA_WIDENING : value;
		if (value === false) return isSubschema ? { not: OPEN_SUBSCHEMA_WIDENING } : value;
		if (Array.isArray(value)) {
			let changed = false;
			const output = value.map(item => {
				const next = normalizeNode(item, isSubschema);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? output : value;
		}
		if (!isJsonObject(value)) return value;

		let changed = false;
		const output: JsonObject = {};
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const child = value[key];
			let next = child;
			if (Object.hasOwn(SUBSCHEMA_MAP_KEYS, key) && isJsonObject(child)) {
				let mapChanged = false;
				const mapOutput: JsonObject = {};
				for (const childKey in child) {
					if (!Object.hasOwn(child, childKey)) continue;
					const mapChild = child[childKey];
					const normalizedChild = normalizeNode(mapChild, true);
					if (normalizedChild !== mapChild) mapChanged = true;
					mapOutput[childKey] = normalizedChild;
				}
				next = mapChanged ? mapOutput : child;
			} else if (Object.hasOwn(SUBSCHEMA_ARRAY_KEYS, key) && Array.isArray(child)) {
				let arrayChanged = false;
				const arrayOutput = child.map(item => {
					const normalizedItem = normalizeNode(item, true);
					if (normalizedItem !== item) arrayChanged = true;
					return normalizedItem;
				});
				next = arrayChanged ? arrayOutput : child;
			} else if (Object.hasOwn(GRAMMAR_SCHEMA_VALUE_KEYS, key)) {
				next = normalizeNode(child, true);
			} else if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child !== "boolean") {
				next = normalizeNode(child, true);
			}
			if (next !== child) changed = true;
			output[key] = next;
		}
		return changed ? output : value;
	};
	return normalizeNode(schema, true) as JsonObject;
}

const OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const OPENAI_RESPONSES_SCHEMA_MAP_KEYS = new Set([
	"properties",
	"patternProperties",

	"dependencies",
	"dependentSchemas",
	"$defs",
	"definitions",
]);
const OPENAI_RESPONSES_SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"contains",
	"contentSchema",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

export function sanitizeSchemaForOpenAIResponses(schema: JsonObject): JsonObject {
	return normalizeOpenAIResponsesSchemaNode(schema, new WeakMap()) as JsonObject;
}

export const normalizeSchemaForOpenAIResponses: (schema: JsonObject) => JsonObject = sanitizeSchemaForOpenAIResponses;
const OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS = new Set(["=", "!", "<=", "<!"]);
const OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK = ".*";

function hasOpenAIUnsupportedRegexLookaround(pattern: string): boolean {
	let groupStart = pattern.indexOf("(?");
	while (groupStart !== -1) {
		let escapes = 0;
		for (let i = groupStart - 1; i >= 0 && pattern[i] === "\\"; i--) escapes++;
		if (escapes % 2 === 0) {
			const operator =
				pattern[groupStart + 2] === "<" ? pattern.slice(groupStart + 2, groupStart + 4) : pattern[groupStart + 2];
			if (OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has(operator)) return true;
		}
		groupStart = pattern.indexOf("(?", groupStart + 2);
	}
	return false;
}

function normalizeOpenAIResponsesSchemaNode(value: unknown, cache: WeakMap<JsonObject, unknown>): unknown {
	if (!isJsonObject(value)) return value;

	if (isJsonObjectEmpty(value)) return true;

	const cached = cache.get(value);
	if (cached) return cached;

	const output: JsonObject = {};
	cache.set(value, output);

	let changed = false;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;

		if (key === "oneOf" && Array.isArray(value.oneOf)) {
			changed = true;
			continue;
		}
		if (
			key === "pattern" &&
			typeof value.pattern === "string" &&
			hasOpenAIUnsupportedRegexLookaround(value.pattern)
		) {
			changed = true;
			continue;
		}

		const child = value[key];
		let next: unknown = child;
		if (key === "patternProperties" && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, true);
		} else if (OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has(key) && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaMap(child, cache, false);
		} else if (OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
			next = normalizeOpenAIResponsesSchemaArray(child, cache);
		} else if (OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has(key) && isJsonObject(child)) {
			next = normalizeOpenAIResponsesSchemaNode(child, cache);
		}

		if (next !== child) changed = true;
		output[key] = next;
	}

	if (Array.isArray(value.oneOf)) {
		const rewrittenOneOf = normalizeOpenAIResponsesSchemaArray(value.oneOf, cache);
		const existingAnyOf = output.anyOf;
		output.anyOf = Array.isArray(existingAnyOf)
			? [...existingAnyOf, ...(rewrittenOneOf as unknown[])]
			: rewrittenOneOf;
	}

	if (declaresObjectType(value.type) && !Object.hasOwn(value, "properties")) {
		output.properties = {};
		changed = true;
	}

	const result = changed ? (isJsonObjectEmpty(output) ? true : output) : value;
	cache.set(value, result);
	return result;
}

function declaresObjectType(type: unknown): boolean {
	if (type === "object") return true;
	if (!Array.isArray(type)) return false;
	for (const variant of type) {
		if (variant === "object") return true;
	}
	return false;
}

function normalizeOpenAIResponsesSchemaArray(value: unknown[], cache: WeakMap<JsonObject, unknown>): unknown[] {
	let changed = false;
	const output = value.map(item => {
		const next = normalizeOpenAIResponsesSchemaNode(item, cache);
		if (next !== item) changed = true;
		return next;
	});
	return changed ? output : value;
}

function normalizeOpenAIResponsesSchemaMap(
	schemaMap: JsonObject,
	cache: WeakMap<JsonObject, unknown>,
	stripUnsupportedRegexKeys: boolean,
): JsonObject {
	let changed = false;
	const output: JsonObject = {};
	for (const key in schemaMap) {
		if (!Object.hasOwn(schemaMap, key)) continue;
		const child = schemaMap[key];
		const next = normalizeOpenAIResponsesSchemaNode(child, cache);
		if (next !== child) changed = true;
		if (stripUnsupportedRegexKeys && hasOpenAIUnsupportedRegexLookaround(key)) {
			changed = true;
			appendOpenAIResponsesFallbackPatternProperty(output, next);
			continue;
		}
		output[key] = next;
	}
	return changed ? output : schemaMap;
}

function appendOpenAIResponsesFallbackPatternProperty(output: JsonObject, schema: unknown): void {
	const existing = output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK];
	if (existing === undefined) {
		output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = schema;
		return;
	}
	if (isJsonObject(existing) && Array.isArray(existing.anyOf) && Object.keys(existing).length === 1) {
		existing.anyOf = [...existing.anyOf, schema];
		return;
	}
	output[OPENAI_RESPONSES_PATTERN_PROPERTIES_FALLBACK] = { anyOf: [existing, schema] };
}

type StrictPrimitiveType = "null" | "string" | "number" | "boolean";

function primitiveJsonTypeOf(value: unknown): StrictPrimitiveType | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return undefined;
	}
}
function jsonSchemaTypeAcceptsValue(type: string, value: unknown): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isJsonObject(value);
		default:
			return true;
	}
}

function narrowEnumToType(schema: Record<string, unknown>, type: string): boolean {
	const enumValues = schema.enum;
	if (!Array.isArray(enumValues)) return true;

	const narrowed = enumValues.filter(value => jsonSchemaTypeAcceptsValue(type, value));
	if (narrowed.length === 0) return false;
	if (narrowed.length !== enumValues.length) schema.enum = narrowed;
	return true;
}

function inferStrictPrimitiveTypeFromEnumOrConst(node: Record<string, unknown>): StrictPrimitiveType | undefined {
	const values: unknown[] = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];
	if (values.length === 0) return undefined;
	let inferred: StrictPrimitiveType | undefined;
	for (const value of values) {
		const t = primitiveJsonTypeOf(value);
		if (t === undefined) return undefined;
		if (inferred === undefined) inferred = t;
		else if (inferred !== t) return undefined;
	}
	return inferred;
}

const kStrictSchema = Symbol("pi.schema.strict");

function isUnrepresentableStrictBranch(value: unknown): boolean {
	return typeof value === "boolean" || (isJsonObject(value) && isJsonObjectEmpty(value));
}

function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, epoch: number = epochNext()): boolean {
	if (!once(schema, epoch)) return false;

	let hasPatternProperties = false;
	if (isJsonObject(schema.patternProperties)) {
		for (const _ in schema.patternProperties) {
			hasPatternProperties = true;
			break;
		}
	}
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isJsonObject(schema.properties)) {
		const properties = schema.properties;
		for (const k in properties) {
			const propertySchema = properties[k];
			if (isUnrepresentableStrictBranch(propertySchema)) return true;
			if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
				return true;
			}
		}
	}

	if (isUnrepresentableStrictBranch(schema.items)) {
		return true;
	}
	if (isJsonObject(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}
	if (Array.isArray(schema.prefixItems)) {
		for (const itemSchema of schema.prefixItems) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isUnrepresentableStrictBranch(variant)) return true;
			if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isJsonObject(defs)) continue;
		for (const k in defs) {
			const defSchema = defs[k];
			if (isUnrepresentableStrictBranch(defSchema)) return true;
			if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
				return true;
			}
		}
	}

	return false;
}

export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
	root: Record<string, unknown> = schema,
): Record<string, unknown> {
	const cached = cache.get(schema);
	if (cached) return cached;
	if (!once(schema, epoch)) return {};

	if (typeof schema.$ref === "string") {
		let hasSibling = false;
		for (const k in schema) {
			if (k !== "$ref" && Object.hasOwn(schema, k)) {
				hasSibling = true;
				break;
			}
		}
		if (hasSibling) {
			const resolved = resolveStrictRef(root, schema.$ref);
			if (resolved !== undefined) {
				const merged: Record<string, unknown> = { ...resolved };
				for (const k in schema) {
					if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
					merged[k] = schema[k];
				}
				const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
				cache.set(schema, result);
				return result;
			}
		}
	}

	{
		const allOf = schema.allOf;
		if (Array.isArray(allOf) && allOf.length === 1 && isJsonObject(allOf[0])) {
			const merged: Record<string, unknown> = { ...schema };
			delete merged.allOf;
			const sole = allOf[0] as Record<string, unknown>;
			for (const k in sole) {
				if (Object.hasOwn(sole, k)) merged[k] = sole[k];
			}
			const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
			cache.set(schema, result);
			return result;
		}
	}

	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}

		const { description, ...variantBase } = sanitizedWithoutType;
		const variants: Record<string, unknown>[] = [];
		for (const variantType of typeVariants) {
			const variantSchema: Record<string, unknown> = { ...variantBase, type: variantType };
			if (variantType !== "object") {
				delete variantSchema.properties;
				delete variantSchema.required;
				delete variantSchema.additionalProperties;
			}
			if (variantType !== "array") {
				delete variantSchema.items;
			}
			if (!narrowEnumToType(variantSchema, variantType)) continue;
			variants.push(sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root));
		}

		if (variants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}

		if (variants.length === 1) {
			const sole = variants[0] as Record<string, unknown>;
			if (description !== undefined && !Object.hasOwn(sole, "description")) {
				sole.description = description;
			}
			cache.set(schema, sole);
			return sole;
		}

		const result: JsonObject = { anyOf: variants };
		if (description !== undefined) result.description = description;
		cache.set(schema, result);
		return result;
	}

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const key in schema) {
		const value = schema[key];
		if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
			continue;
		}

		if (key === "properties" && isJsonObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const propertyName in value) {
				const propertySchema = value[propertyName];
				properties[propertyName] = isJsonObject(propertySchema)
					? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
					: propertySchema;
			}
			sanitized.properties = properties;
			continue;
		}

		if (key === "items") {
			if (isJsonObject(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}

		if (key === "prefixItems" && Array.isArray(value)) {
			sanitized.prefixItems = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}

		if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
			const defs: Record<string, unknown> = {};
			for (const definitionName in value) {
				const definitionSchema = value[definitionName];
				defs[definitionName] = isJsonObject(definitionSchema)
					? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
					: definitionSchema;
			}
			sanitized[key] = defs;
			continue;
		}

		if (key === "additionalProperties") {
			continue;
		}

		if (key === "description" && typeof value === "string" && schema.default !== undefined) {
			const defaultVal = schema.default;
			const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
			sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
			continue;
		}

		sanitized[key] = value;
	}

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
		sanitized.type = "array";
	}

	if (sanitized.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(sanitized);
		if (inferred !== undefined) sanitized.type = inferred;
	}

	if (schema.nullable === true) {
		const { nullable: _, description, ...withoutNullable } = sanitized;
		const wrapper: JsonObject = { anyOf: [withoutNullable, { type: "null" }] };
		if (description !== undefined) wrapper.description = description;
		return wrapper;
	}

	return sanitized;
}

function isPureAnyOfNode(value: unknown): value is Record<string, unknown> & { anyOf: unknown[] } {
	if (!isJsonObject(value) || !Array.isArray(value.anyOf)) return false;
	for (const key in value) {
		if (key !== "anyOf" && key !== "description") return false;
	}
	return true;
}

export function enforceStrictSchema(
	schema: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
	if (!enter(schema)) {
		throw new AIError.ValidationError("Schema contains a circular object graph — cannot enforce strict mode");
	}
	try {
		const cached = cache.get(schema);
		if (cached) return cached;
		const result = { ...schema };
		cache.set(schema, result);
		return enforceStrictSchemaBody(schema, result, cache);
	} finally {
		exit(schema);
	}
}

function enforceStrictSchemaBody(
	_schema: Record<string, unknown>,
	result: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set<string>(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties: Record<string, unknown> = {};
		for (const key in props) {
			const value = props[key];
			const processed =
				value != null && typeof value === "object" && !Array.isArray(value)
					? enforceStrictSchema(value as Record<string, unknown>, cache)
					: value;

			if (!originalRequired.has(key)) {
				if (
					isJsonObject(processed) &&
					Array.isArray(processed.anyOf) &&
					processed.anyOf.some(v => isJsonObject(v) && v.type === "null")
				) {
					strictProperties[key] = processed;
					continue;
				}
				if (isPureAnyOfNode(processed)) {
					strictProperties[key] = { ...processed, anyOf: [...processed.anyOf, { type: "null" }] };
					continue;
				}
				if (isJsonObject(processed) && typeof processed.description === "string") {
					const { description, ...withoutDescription } = processed;
					strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
					continue;
				}
				strictProperties[key] = { anyOf: [processed, { type: "null" }] };
				continue;
			}
			strictProperties[key] = processed;
		}
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
		}
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(entry =>
			entry != null && typeof entry === "object" && !Array.isArray(entry)
				? enforceStrictSchema(entry as Record<string, unknown>, cache)
				: entry,
		);
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		}
	}

	if (Array.isArray(result.anyOf) && result.anyOf.some(isPureAnyOfNode)) {
		const flattened: unknown[] = [];
		for (const branch of result.anyOf) {
			if (!isPureAnyOfNode(branch)) {
				flattened.push(branch);
				continue;
			}
			flattened.push(...branch.anyOf);

			if (typeof branch.description === "string" && result.description === undefined) {
				result.description = branch.description;
			}
		}
		result.anyOf = flattened;
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			const nextDefs: Record<string, unknown> = {};
			for (const name in defs) {
				const def = defs[name];
				nextDefs[name] =
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, cache)
						: def;
			}
			result[defsKey] = nextDefs;
		}
	}

	if (result.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(result);
		if (inferred !== undefined) result.type = inferred;
	}

	if (
		result.type === undefined &&
		result.$ref === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isJsonObject(result.not)
	) {
		throw new AIError.ValidationError("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict: boolean;
} {
	return stamp(schema, kStrictSchema, s => {
		const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
		if (hasUnrepresentableStrictObjectMap(upgraded)) {
			return { schema: upgraded, strict: false };
		}
		try {
			const sanitized = sanitizeSchemaForStrictMode(upgraded);
			return { schema: enforceStrictSchema(sanitized), strict: true };
		} catch {
			return { schema: upgraded, strict: false };
		}
	});
}

function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	if (!ref.startsWith("#/")) return undefined;
	const segments = ref.slice(2).split("/");
	let cursor: unknown = root;
	for (const raw of segments) {
		if (!isJsonObject(cursor)) return undefined;

		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		cursor = cursor[segment];
	}
	return isJsonObject(cursor) ? cursor : undefined;
}
