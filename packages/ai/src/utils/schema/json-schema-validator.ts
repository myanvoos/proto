import { areJsonValuesEqual } from "./equality";

export interface JsonSchemaValidationIssue {
	path: PropertyKey[];
	message: string;
	expectedTypes?: string[];
	keyword?: string;

	fromUnionBranch?: boolean;
}

export interface JsonSchemaValidationResult {
	success: boolean;
	issues: JsonSchemaValidationIssue[];
}

interface ValidationContext {
	root: unknown;
	seenPairs: Set<string>;
	objectIds: WeakMap<object, number>;
	nextObjectId: { value: number };
	refDepth: number;
}

/** Instance locations a schema successfully evaluated, for unevaluatedProperties/Items. */
interface EvaluatedTracker {
	properties: Set<string>;
	items: Set<number>;
}

const MAX_REF_DEPTH = 64;

const ENFORCED_FORMATS: Record<string, RegExp> = {
	"date-time":
		/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt ]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/,
	date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
	time: /^([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/,
};

function codePointLength(value: string): number {
	let length = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) index++;
		}
		length++;
	}
	return length;
}

function getValueIdentity(ctx: ValidationContext, value: object): number {
	let id = ctx.objectIds.get(value);
	if (id !== undefined) return id;
	id = ctx.nextObjectId.value;
	ctx.nextObjectId.value += 1;
	ctx.objectIds.set(value, id);
	return id;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTagSelectedBranch(branch: unknown, value: unknown): boolean {
	if (!isJsonObject(branch) || !isJsonObject(value)) return false;
	const props = branch.properties;
	if (!isJsonObject(props)) return false;
	let matched = false;
	for (const key in props) {
		const propSchema = props[key];
		if (!isJsonObject(propSchema)) continue;
		const hasConst = Object.hasOwn(propSchema, "const");
		const enumValues = Array.isArray(propSchema.enum) ? propSchema.enum : undefined;
		if (!hasConst && !enumValues) continue;
		if (!Object.hasOwn(value, key)) return false;
		const candidate = value[key];
		if (hasConst) {
			if (!areJsonValuesEqual(candidate, propSchema.const)) return false;
		} else if (enumValues && !enumValues.some(entry => areJsonValuesEqual(entry, candidate))) {
			return false;
		}
		matched = true;
	}
	return matched;
}

function pushIssue(
	issues: JsonSchemaValidationIssue[],
	path: readonly PropertyKey[],
	message: string,
	options: { expectedTypes?: string[]; keyword?: string } = {},
): void {
	issues.push({ path: [...path], message, ...options });
}

function typeOfJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isJsonObject(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return false;
	}
}

function schemaTypes(schema: Record<string, unknown>): string[] {
	const raw = schema.type;
	const types =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: [];
	if (schema.nullable === true && !types.includes("null")) {
		return [...types, "null"];
	}
	return types;
}

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: unknown, ref: string): unknown | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawToken of ref.slice(2).split("/")) {
		const token = decodePointerToken(rawToken);
		if (!isJsonObject(current) && !Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

function isRequiredSet(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function validateSchemaNode(
	schema: unknown,
	value: unknown,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
	evaluated?: EvaluatedTracker,
): boolean {
	if (schema === true) return true;
	if (schema === false) {
		pushIssue(issues, path, "must not match false schema", { keyword: "false" });
		return false;
	}
	if (!isJsonObject(schema)) {
		pushIssue(issues, path, "schema must be an object or boolean", { keyword: "schema" });
		return false;
	}

	// A node carrying unevaluatedProperties/Items needs to know everything its
	// subschemas evaluated, so it validates its children against a fresh tracker.
	const tracker: EvaluatedTracker | undefined =
		schema.unevaluatedProperties !== undefined || schema.unevaluatedItems !== undefined
			? { properties: new Set(), items: new Set() }
			: evaluated;

	let refValid = true;
	if (typeof schema.$ref === "string") {
		const resolved = resolveLocalRef(ctx.root, schema.$ref);
		if (resolved === undefined) {
			pushIssue(issues, path, `unresolved reference ${schema.$ref}`, { keyword: "$ref" });
			return false;
		}

		let pairKey: string | undefined;
		if (value !== null && typeof value === "object") {
			pairKey = `${schema.$ref}:${getValueIdentity(ctx, value)}`;
			if (!ctx.seenPairs.has(pairKey)) {
				ctx.seenPairs.add(pairKey);
				refValid = validateSchemaNode(resolved, value, path, ctx, issues, tracker);
				ctx.seenPairs.delete(pairKey);
			}
			// A ref/value pair already being validated is treated as satisfied; its
			// adjacent keywords still apply below.
		} else {
			if (ctx.refDepth >= MAX_REF_DEPTH) {
				pushIssue(issues, path, "reference depth exceeded", { keyword: "$ref" });
				refValid = false;
			} else {
				ctx.refDepth += 1;
				refValid = validateSchemaNode(resolved, value, path, ctx, issues, tracker);
				ctx.refDepth -= 1;
			}
		}
		// JSON Schema 2020-12: keywords adjacent to $ref apply alongside the reference,
		// so validation falls through to the local keywords instead of returning here.
	}

	if (value === null && schema.nullable === true) return refValid;

	let valid = true;
	const types = schemaTypes(schema);
	if (types.length > 0 && !types.some(type => matchesJsonSchemaType(value, type))) {
		pushIssue(issues, path, `expected ${types.join(" or ")}, received ${typeOfJsonValue(value)}`, {
			keyword: "type",
			expectedTypes: types,
		});
		return false;
	}

	if ("const" in schema && !areJsonValuesEqual(value, schema.const)) {
		pushIssue(issues, path, "must equal const value", { keyword: "const" });
		valid = false;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some(entry => areJsonValuesEqual(entry, value))) {
		pushIssue(issues, path, "must be one of the allowed enum values", { keyword: "enum" });
		valid = false;
	}

	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (keyword === "allOf") {
			for (const branch of branches) {
				valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
			}
			continue;
		}

		let matches = 0;
		let selectedIssues: JsonSchemaValidationIssue[] | undefined;
		let selectedCount = 0;
		const branchIssuesList: JsonSchemaValidationIssue[][] = [];
		for (const branch of branches) {
			const branchIssues: JsonSchemaValidationIssue[] = [];
			const branchEvaluated: EvaluatedTracker | undefined = tracker
				? { properties: new Set(), items: new Set() }
				: undefined;
			if (validateSchemaNode(branch, value, path, ctx, branchIssues, branchEvaluated)) {
				matches += 1;
				mergeEvaluated(branchEvaluated, tracker);
				continue;
			}
			branchIssuesList.push(branchIssues);
			if (isTagSelectedBranch(branch, value)) {
				selectedCount += 1;
				if (selectedCount === 1) selectedIssues = branchIssues;
			}
		}
		const branchValid = keyword === "anyOf" ? matches > 0 : matches === 1;
		if (!branchValid) {
			if (matches === 0 && selectedCount === 1 && selectedIssues && selectedIssues.length > 0) {
				issues.push(...selectedIssues);
			} else if (matches === 0) {
				// No branch matched and no tag selected one: report every satisfiable
				// alternative's failures so the model can pick a workable branch, instead of
				// an arbitrary first branch it may not be able to satisfy at all.
				const MAX_REPORTED_BRANCHES = 8;
				const viable = branches
					.map((branch, index) => ({ branch, issues: branchIssuesList[index] ?? [] }))
					.filter(entry => entry.branch !== false);
				if (viable.length === 1) {
					for (const branchIssue of viable[0].issues) {
						issues.push(branchIssue.fromUnionBranch ? branchIssue : { ...branchIssue, fromUnionBranch: true });
					}
				} else if (viable.length > 1 && viable.some(entry => entry.issues.length > 0)) {
					const reported = viable.slice(0, MAX_REPORTED_BRANCHES);
					pushIssue(
						issues,
						path,
						keyword === "anyOf"
							? `must match at least one of ${viable.length} alternatives; each viable branch's failures follow`
							: `must match exactly one of ${viable.length} alternatives; each viable branch's failures follow`,
						{ keyword },
					);
					for (const entry of reported) {
						for (const branchIssue of entry.issues) {
							issues.push(branchIssue.fromUnionBranch ? branchIssue : { ...branchIssue, fromUnionBranch: true });
						}
					}
				} else {
					pushIssue(
						issues,
						path,
						keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema",
						{
							keyword,
						},
					);
				}
			} else {
				pushIssue(
					issues,
					path,
					keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema",
					{
						keyword,
					},
				);
			}
			valid = false;
		}
	}

	if ("not" in schema) {
		const notIssues: JsonSchemaValidationIssue[] = [];
		// A failing `not` branch evaluates nothing, so it validates against a throwaway.
		if (validateSchemaNode(schema.not, value, path, ctx, notIssues)) {
			pushIssue(issues, path, "must not match excluded schema", { keyword: "not" });
			valid = false;
		}
	}

	if ("if" in schema) {
		const ifIssues: JsonSchemaValidationIssue[] = [];
		const ifOk = validateSchemaNode(schema.if, value, path, ctx, ifIssues);
		const branch = ifOk ? schema.then : schema.else;
		if (branch !== undefined) {
			valid = validateSchemaNode(branch, value, path, ctx, issues, tracker) && valid;
		}
	}

	if (isJsonObject(value)) {
		valid = validateObjectKeywords(schema, value, path, ctx, issues, tracker) && valid;
	}
	if (Array.isArray(value)) {
		valid = validateArrayKeywords(schema, value, path, ctx, issues, tracker) && valid;
	}
	if (typeof value === "string") {
		valid = validateStringKeywords(schema, value, path, issues) && valid;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		valid = validateNumberKeywords(schema, value, path, issues) && valid;
	}

	if (tracker !== evaluated && evaluated !== undefined) mergeEvaluated(tracker, evaluated);
	return valid && refValid;
}

function mergeEvaluated(source: EvaluatedTracker | undefined, target: EvaluatedTracker | undefined): void {
	if (!source || !target) return;
	for (const key of source.properties) target.properties.add(key);
	for (const index of source.items) target.items.add(index);
}

function validateObjectKeywords(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
	evaluated?: EvaluatedTracker,
): boolean {
	let valid = true;
	const properties = isJsonObject(schema.properties) ? schema.properties : {};
	if (isRequiredSet(schema.required)) {
		for (const key of schema.required) {
			if (!(key in value)) {
				pushIssue(issues, [...path, key], "is required", { keyword: "required" });
				valid = false;
			}
		}
	}

	for (const key in properties) {
		if (!(key in value)) continue;
		const propertyValid = validateSchemaNode(properties[key], value[key], [...path, key], ctx, issues, evaluated);
		if (propertyValid) evaluated?.properties.add(key);
		valid = propertyValid && valid;
	}

	if (schema.propertyNames !== undefined) {
		for (const key of Object.keys(value)) {
			valid = validateSchemaNode(schema.propertyNames, key, [...path, key], ctx, issues) && valid;
		}
	}

	const known = new Set(Object.keys(properties));
	if (isJsonObject(schema.patternProperties)) {
		const patternProperties = schema.patternProperties;
		for (const pattern in patternProperties) {
			const patternSchema = patternProperties[pattern];
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch {
				pushIssue(issues, path, `invalid patternProperties regex ${pattern}`, { keyword: "patternProperties" });
				valid = false;
				continue;
			}
			for (const key in value) {
				if (!re.test(key)) continue;
				known.add(key);
				const patternValid = validateSchemaNode(patternSchema, value[key], [...path, key], ctx, issues, evaluated);
				if (patternValid) evaluated?.properties.add(key);
				valid = patternValid && valid;
			}
		}
	}

	if (isJsonObject(schema.dependentRequired)) {
		const dependentRequired = schema.dependentRequired;
		for (const key in dependentRequired) {
			const deps = dependentRequired[key];
			if (!(key in value)) continue;
			if (!Array.isArray(deps)) continue;
			for (const dep of deps) {
				if (typeof dep !== "string") continue;
				if (!(dep in value)) {
					pushIssue(issues, [...path, dep], `is required when "${key}" is present`, {
						keyword: "dependentRequired",
					});
					valid = false;
				}
			}
		}
	}

	if (isJsonObject(schema.dependentSchemas)) {
		const dependentSchemas = schema.dependentSchemas;
		for (const key in dependentSchemas) {
			if (!(key in value)) continue;
			valid = validateSchemaNode(dependentSchemas[key], value, path, ctx, issues, evaluated) && valid;
		}
	}

	const additional = schema.additionalProperties;
	if (additional === false) {
		for (const key of Object.keys(value)) {
			if (known.has(key)) continue;
			pushIssue(issues, [...path, key], "must not be present", { keyword: "additionalProperties" });
			valid = false;
		}
	} else if (additional !== undefined && additional !== true) {
		for (const key in value) {
			if (known.has(key)) continue;
			const additionalValid = validateSchemaNode(additional, value[key], [...path, key], ctx, issues, evaluated);
			if (additionalValid) evaluated?.properties.add(key);
			valid = additionalValid && valid;
		}
	}

	if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
		pushIssue(issues, path, `must have at least ${schema.minProperties} properties`, { keyword: "minProperties" });
		valid = false;
	}
	if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
		pushIssue(issues, path, `must have at most ${schema.maxProperties} properties`, { keyword: "maxProperties" });
		valid = false;
	}

	const unevaluatedProperties = schema.unevaluatedProperties;
	if (unevaluatedProperties !== undefined && evaluated) {
		for (const key of Object.keys(value)) {
			if (evaluated.properties.has(key)) continue;
			if (unevaluatedProperties === false) {
				pushIssue(issues, [...path, key], "must not be present", { keyword: "unevaluatedProperties" });
				valid = false;
				continue;
			}
			const unevaluatedValid = validateSchemaNode(
				unevaluatedProperties,
				value[key],
				[...path, key],
				ctx,
				issues,
				evaluated,
			);
			if (unevaluatedValid) evaluated.properties.add(key);
			valid = unevaluatedValid && valid;
		}
	}

	return valid;
}

function validateArrayKeywords(
	schema: Record<string, unknown>,
	value: unknown[],
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
	evaluated?: EvaluatedTracker,
): boolean {
	let valid = true;
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		pushIssue(issues, path, `must have at least ${schema.minItems} items`, { keyword: "minItems" });
		valid = false;
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		pushIssue(issues, path, `must have at most ${schema.maxItems} items`, { keyword: "maxItems" });
		valid = false;
	}
	if (schema.uniqueItems === true) {
		for (let i = 0; i < value.length; i += 1) {
			for (let j = i + 1; j < value.length; j += 1) {
				if (!areJsonValuesEqual(value[i], value[j])) continue;
				pushIssue(issues, [...path, j], "must be unique", { keyword: "uniqueItems" });
				valid = false;
			}
		}
	}

	const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
	const items = schema.items;
	if (Array.isArray(items)) {
		pushIssue(issues, path, "array-valued items is not valid in JSON Schema 2020-12; use prefixItems", {
			keyword: "items",
		});
		valid = false;
	} else if (prefixItems) {
		const limit = Math.min(prefixItems.length, value.length);
		for (let i = 0; i < limit; i += 1) {
			const itemValid = validateSchemaNode(prefixItems[i], value[i], [...path, i], ctx, issues, evaluated);
			if (itemValid) evaluated?.items.add(i);
			valid = itemValid && valid;
		}
		if (items !== undefined) {
			for (let i = prefixItems.length; i < value.length; i += 1) {
				const itemValid = validateSchemaNode(items, value[i], [...path, i], ctx, issues, evaluated);
				if (itemValid) evaluated?.items.add(i);
				valid = itemValid && valid;
			}
		}
	} else if (items !== undefined) {
		for (let i = 0; i < value.length; i += 1) {
			const itemValid = validateSchemaNode(items, value[i], [...path, i], ctx, issues, evaluated);
			if (itemValid) evaluated?.items.add(i);
			valid = itemValid && valid;
		}
	}

	if (schema.contains !== undefined) {
		const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
		const maxContains = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
		let count = 0;
		for (let i = 0; i < value.length; i += 1) {
			const containsIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(schema.contains, value[i], [...path, i], ctx, containsIssues)) {
				count += 1;
			}
		}
		if (count < minContains) {
			pushIssue(issues, path, `must contain at least ${minContains} matching item(s)`, { keyword: "contains" });
			valid = false;
		}
		if (count > maxContains) {
			pushIssue(issues, path, `must contain at most ${maxContains} matching item(s)`, { keyword: "maxContains" });
			valid = false;
		}
		// contains only evaluates indices when its count bounds hold
		if (valid && evaluated) {
			for (let i = 0; i < value.length; i += 1) {
				if (validateSchemaNode(schema.contains, value[i], [...path, i], ctx, issues)) evaluated.items.add(i);
			}
		}
	}

	const unevaluatedItems = schema.unevaluatedItems;
	if (unevaluatedItems !== undefined && evaluated) {
		for (let i = 0; i < value.length; i += 1) {
			if (evaluated.items.has(i)) continue;
			if (unevaluatedItems === false) {
				pushIssue(issues, [...path, i], "must not be present", { keyword: "unevaluatedItems" });
				valid = false;
				continue;
			}
			const unevaluatedValid = validateSchemaNode(unevaluatedItems, value[i], [...path, i], ctx, issues, evaluated);
			if (unevaluatedValid) evaluated.items.add(i);
			valid = unevaluatedValid && valid;
		}
	}

	return valid;
}

function validateStringKeywords(
	schema: Record<string, unknown>,
	value: string,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	// JSON Schema counts string length in code points, not UTF-16 code units
	if (typeof schema.minLength === "number" && codePointLength(value) < schema.minLength) {
		pushIssue(issues, path, `must be at least ${schema.minLength} characters`, { keyword: "minLength" });
		valid = false;
	}
	if (typeof schema.maxLength === "number" && codePointLength(value) > schema.maxLength) {
		pushIssue(issues, path, `must be at most ${schema.maxLength} characters`, { keyword: "maxLength" });
		valid = false;
	}
	if (typeof schema.format === "string") {
		const formatPattern = ENFORCED_FORMATS[schema.format];
		if (formatPattern && !formatPattern.test(value)) {
			pushIssue(issues, path, `must be a valid ${schema.format} string`, { keyword: "format" });
			valid = false;
		}
	}
	if (typeof schema.pattern === "string") {
		try {
			if (!new RegExp(schema.pattern).test(value)) {
				pushIssue(issues, path, "must match pattern", { keyword: "pattern" });
				valid = false;
			}
		} catch {
			pushIssue(issues, path, "schema pattern is invalid", { keyword: "pattern" });
			valid = false;
		}
	}
	return valid;
}

function validateNumberKeywords(
	schema: Record<string, unknown>,
	value: number,
	path: readonly PropertyKey[],
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		pushIssue(issues, path, `must be >= ${schema.minimum}`, { keyword: "minimum" });
		valid = false;
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		pushIssue(issues, path, `must be <= ${schema.maximum}`, { keyword: "maximum" });
		valid = false;
	}
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		pushIssue(issues, path, `must be > ${schema.exclusiveMinimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		pushIssue(issues, path, `must be < ${schema.exclusiveMaximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
		pushIssue(issues, path, `must be > ${schema.minimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
		pushIssue(issues, path, `must be < ${schema.maximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
		const quotient = value / schema.multipleOf;
		if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10) {
			pushIssue(issues, path, `must be a multiple of ${schema.multipleOf}`, { keyword: "multipleOf" });
			valid = false;
		}
	}
	return valid;
}

export function validateJsonSchemaValue(schema: unknown, value: unknown): JsonSchemaValidationResult {
	const issues: JsonSchemaValidationIssue[] = [];
	const success = validateSchemaNode(
		schema,
		value,
		[],
		{ root: schema, seenPairs: new Set(), objectIds: new WeakMap(), nextObjectId: { value: 0 }, refDepth: 0 },
		issues,
	);
	return { success, issues };
}

export function isJsonSchemaValueValid(schema: unknown, value: unknown): boolean {
	return validateJsonSchemaValue(schema, value).success;
}
