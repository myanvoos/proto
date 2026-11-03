import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationIssue,
	type JsonSchemaValidationResult,
	validateJsonSchemaValue,
} from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

interface OutputValidator {
	validate(value: unknown): JsonSchemaValidationResult;
	normalize(value: unknown): unknown;
	normalizeSection(label: string, value: unknown): unknown;

	readonly requiredFields: readonly string[];

	readonly validateSection: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult>;

	readonly rejectUnknownSections: boolean;

	readonly knownSectionLabels: readonly string[];

	isKnownSection(label: string): boolean;
}

interface BuildOutputValidatorResult {
	validator?: OutputValidator;

	jsonSchema?: Record<string, unknown>;

	normalized?: unknown;

	error?: string;
}

const schemaResults = new LRUCache<string, BuildOutputValidatorResult>({ max: 32 });

export function buildOutputValidator(schema: unknown): BuildOutputValidatorResult {
	let key: string | undefined;
	if (typeof schema === "string") key = `s${schema}`;
	else if (schema !== null && typeof schema === "object") {
		try {
			key = `o${JSON.stringify(schema)}`;
		} catch {
			// The uncached builder reports malformed or cyclic declarations.
		}
	}
	if (key === undefined) return buildOutputValidatorUncached(schema);
	let cached = schemaResults.get(key);
	if (!cached) {
		cached = buildOutputValidatorUncached(typeof schema === "string" ? schema : JSON.parse(key.slice(1)));
		schemaResults.set(key, cached);
	}
	return cached;
}

function buildOutputValidatorUncached(schema: unknown): BuildOutputValidatorResult {
	const { normalized, error: normalizeError } = normalizeSchema(schema);
	if (normalizeError) return { error: normalizeError, normalized };
	if (normalized === undefined) return {};
	if (normalized === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (normalized === true) return { normalized };

	const jsonSchema = jtdToJsonSchema(normalized);
	if (jsonSchema === undefined) return { normalized };
	if (jsonSchema === false) return { error: "boolean false schema rejects all outputs", normalized };
	if (jsonSchema === true) return { normalized };
	if (typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
		return { error: "invalid JSON schema", normalized };
	}
	if (!isValidJsonSchema(jsonSchema)) return { error: "invalid JSON schema", normalized };

	const jsonSchemaRecord = jsonSchema as Record<string, unknown>;

	const dereferenced = dereferenceJsonSchema(jsonSchemaRecord);
	const labelSchema =
		dereferenced && typeof dereferenced === "object" && !Array.isArray(dereferenced)
			? (dereferenced as Record<string, unknown>)
			: jsonSchemaRecord;
	const required = extractRequiredFields(labelSchema);
	const sectionLabels = buildSectionLabelMetadata(labelSchema);
	const sectionSchemas = buildSectionSchemas(labelSchema);
	const sectionValidators = new Map<string, (value: unknown) => JsonSchemaValidationResult>();
	for (const [label, sectionSchema] of sectionSchemas) {
		sectionValidators.set(label, value => validateJsonSchemaValue(sectionSchema, value));
	}
	return {
		normalized,
		jsonSchema: jsonSchemaRecord,
		validator: {
			requiredFields: required,
			validate: value => validateJsonSchemaValue(jsonSchemaRecord, value),
			normalize: value => normalizeStrictOutput(value, labelSchema),
			normalizeSection: (label, value) => normalizeStrictOutput(value, sectionSchemas.get(label)),
			validateSection: sectionValidators,
			rejectUnknownSections: sectionLabels.rejectUnknownSections,
			knownSectionLabels: sectionLabels.labels,
			isKnownSection: sectionLabels.isKnown,
		},
	};
}

function buildSectionSchemas(jsonSchema: Record<string, unknown>): ReadonlyMap<string, unknown> {
	const schemas = new Map<string, unknown>();
	const properties = jsonSchema.properties;
	if (!isRecord(properties)) return schemas;
	for (const label in properties) {
		const raw = properties[label];
		const propRecord = isRecord(raw) ? raw : undefined;
		schemas.set(
			label,
			propRecord?.type === "array" && propRecord.items !== undefined && propRecord.items !== null
				? propRecord.items
				: raw,
		);
	}
	return schemas;
}

// Remove provider-injected nulls only when the declared property schema rejects null.
function normalizeStrictOutput(value: unknown, schema: unknown): unknown {
	if (!isRecord(schema)) return value;
	if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
		const [first, second] = schema.anyOf;
		if (isRecord(first) && first.type === "null") return normalizeStrictOutput(value, second);
		if (isRecord(second) && second.type === "null") return normalizeStrictOutput(value, first);
	}
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) value = normalizeStrictOutput(value, branch);
	}
	// For unions, accept a candidate only when it satisfies the entire original schema.
	for (const keyword of ["oneOf", "anyOf"]) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (validateJsonSchemaValue(schema, value).success) return value;
		for (const branch of branches) {
			const candidate = normalizeStrictOutput(value, branch);
			if (candidate !== value && validateJsonSchemaValue(schema, candidate).success) return candidate;
		}
	}
	const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
	if (Array.isArray(value) && (prefixItems !== undefined || schema.items !== undefined)) {
		let normalized: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const itemSchema = prefixItems && index < prefixItems.length ? prefixItems[index] : schema.items;
			const item = normalizeStrictOutput(value[index], itemSchema);
			if (item === value[index]) continue;
			normalized ??= value.slice();
			normalized[index] = item;
		}
		return normalized ?? value;
	}
	if (!isRecord(value) || !isRecord(schema.properties)) return value;
	let normalized: Record<string, unknown> | undefined;
	for (const key in schema.properties) {
		if (!Object.hasOwn(value, key)) continue;
		const propertySchema = schema.properties[key];
		if (
			value[key] === null &&
			!(Array.isArray(schema.required) && schema.required.includes(key)) &&
			!validateJsonSchemaValue(propertySchema, null).success
		) {
			normalized ??= { ...value };
			delete normalized[key];
			continue;
		}
		const property = normalizeStrictOutput(value[key], propertySchema);
		if (property === value[key]) continue;
		normalized ??= { ...value };
		normalized[key] = property;
	}
	return normalized ?? value;
}

interface SectionLabelMetadata {
	readonly labels: readonly string[];
	readonly rejectUnknownSections: boolean;
	isKnown(label: string): boolean;
}

function buildSectionLabelMetadata(jsonSchema: Record<string, unknown>): SectionLabelMetadata {
	const closedConjuncts = collectClosedTopLevelSchemas(jsonSchema);
	const closedUnions = collectClosedTopLevelUnions(jsonSchema);
	const closed = closedConjuncts.length > 0 || closedUnions.length > 0;
	const acceptedByAll = (conjuncts: readonly Record<string, unknown>[], label: string): boolean =>
		conjuncts.every(schema => schemaAcceptsSectionLabel(schema, label));
	const labels = [
		...new Set([
			...closedConjuncts.flatMap(schema => declaredPropertyLabels(schema)),
			...closedUnions.flatMap(variants =>
				variants.flatMap(conjuncts => conjuncts.flatMap(schema => declaredPropertyLabels(schema))),
			),
		]),
	];
	return {
		labels,
		rejectUnknownSections: closed,
		isKnown: label =>
			!closed ||
			(acceptedByAll(closedConjuncts, label) &&
				closedUnions.every(variants => variants.some(conjuncts => acceptedByAll(conjuncts, label)))),
	};
}

function collectClosedTopLevelSchemas(jsonSchema: Record<string, unknown>): Record<string, unknown>[] {
	const schemas: Record<string, unknown>[] = [];
	if (jsonSchema.additionalProperties === false) schemas.push(jsonSchema);
	const allOf = jsonSchema.allOf;
	if (Array.isArray(allOf)) {
		for (const raw of allOf) {
			if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
				schemas.push(...collectClosedTopLevelSchemas(raw as Record<string, unknown>));
			}
		}
	}
	return schemas;
}

type ClosedUnionVariants = Record<string, unknown>[][];

function collectClosedTopLevelUnions(jsonSchema: Record<string, unknown>): ClosedUnionVariants[] {
	const unions: ClosedUnionVariants[] = [];
	for (const key of ["oneOf", "anyOf"] as const) {
		const rawVariants = jsonSchema[key];
		if (!Array.isArray(rawVariants) || rawVariants.length === 0) continue;
		const variants: ClosedUnionVariants = [];
		let allClosed = true;
		for (const raw of rawVariants) {
			const conjuncts = isRecord(raw) ? collectClosedTopLevelSchemas(raw) : [];
			if (conjuncts.length === 0) {
				allClosed = false;
				break;
			}
			variants.push(conjuncts);
		}
		if (allClosed) unions.push(variants);
	}
	const allOf = jsonSchema.allOf;
	if (Array.isArray(allOf)) {
		for (const raw of allOf) {
			if (isRecord(raw)) unions.push(...collectClosedTopLevelUnions(raw));
		}
	}
	return unions;
}

function declaredPropertyLabels(jsonSchema: Record<string, unknown>): string[] {
	const properties = jsonSchema.properties;
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return [];
	const labels: string[] = [];
	for (const label in properties) labels.push(label);
	return labels;
}

function schemaAcceptsSectionLabel(jsonSchema: Record<string, unknown>, label: string): boolean {
	const properties = jsonSchema.properties;
	if (properties !== null && typeof properties === "object" && !Array.isArray(properties) && label in properties) {
		return true;
	}
	const patternProperties = jsonSchema.patternProperties;
	if (patternProperties !== null && typeof patternProperties === "object" && !Array.isArray(patternProperties)) {
		for (const pattern in patternProperties) {
			try {
				if (new RegExp(pattern).test(label)) return true;
			} catch {}
		}
	}
	return jsonSchema.additionalProperties !== false;
}

export function summarizeValidationFailure(
	result: JsonSchemaValidationResult,
	value: unknown,
	requiredFields: readonly string[],
): { message: string; missingRequired: string[] } {
	if (result.success) return { message: "", missingRequired: [] };
	const missing = computeMissingRequired(requiredFields, value);
	const message = formatValidationIssueHeadline(result.issues[0]) ?? "schema validation failed";
	return { message, missingRequired: missing };
}

export function extractRequiredFields(jsonSchema: unknown): string[] {
	if (!jsonSchema || typeof jsonSchema !== "object") return [];
	const required = (jsonSchema as { required?: unknown }).required;
	return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

export function computeMissingRequired(required: readonly string[], value: unknown): string[] {
	if (required.length === 0) return [];
	if (value === null || value === undefined) return [...required];
	if (typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	return required.filter(key => !(key in record) || record[key] === undefined);
}

export function formatValidationIssueHeadline(issue: JsonSchemaValidationIssue | undefined): string | undefined {
	if (!issue) return undefined;
	const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
	return `${path}: ${issue.message}`;
}

export function formatAllValidationIssues(issues: ReadonlyArray<JsonSchemaValidationIssue> | undefined): string {
	if (!issues || issues.length === 0) return "Unknown schema validation error.";
	return issues
		.map(issue => {
			const path = issue.path.length === 0 ? "" : `${issue.path.map(seg => String(seg)).join("/")}: `;
			return `${path}${issue.message}`;
		})
		.join("; ");
}
