import { isRecord } from "@oh-my-pi/pi-utils";
import type { JTDPrimitive } from "./jtd-utils.js";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "./jtd-utils.js";

const primitiveMap: Record<JTDPrimitive, string> = {
	boolean: "boolean",
	string: "string",
	timestamp: "string",
	float32: "number",
	float64: "number",
	int8: "integer",
	uint8: "integer",
	int16: "integer",
	uint16: "integer",
	int32: "integer",
	uint32: "integer",
};

function convertSchema(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object") {
		return {};
	}

	if (isJTDEnum(schema)) {
		return { enum: schema.enum };
	}

	if (isJTDElements(schema)) {
		return {
			type: "array",
			items: convertSchema(schema.elements),
		};
	}

	if (isJTDType(schema)) {
		const jsonType = primitiveMap[schema.type as JTDPrimitive];
		if (!jsonType) {
			return { type: schema.type };
		}
		return { type: jsonType };
	}

	if (isJTDValues(schema)) {
		return {
			type: "object",
			additionalProperties: convertSchema(schema.values),
		};
	}

	if (isJTDProperties(schema)) {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				properties[key] = convertSchema(value);
				required.push(key);
			}
		}

		if (schema.optionalProperties) {
			for (const [key, value] of Object.entries(schema.optionalProperties)) {
				properties[key] = convertSchema(value);
			}
		}

		const result: Record<string, unknown> = {
			type: "object",
			properties,
			additionalProperties: false,
		};

		if (required.length > 0) {
			result.required = required;
		}

		return result;
	}

	if (isJTDDiscriminator(schema)) {
		const oneOf: unknown[] = [];

		for (const [tag, props] of Object.entries(schema.mapping)) {
			const converted = convertSchema(props) as Record<string, unknown>;

			const properties = (converted.properties || {}) as Record<string, unknown>;
			properties[schema.discriminator] = { const: tag };

			const required = ((converted.required as string[]) || []).slice();
			if (!required.includes(schema.discriminator)) {
				required.push(schema.discriminator);
			}

			oneOf.push({
				...converted,
				properties,
				required,
			});
		}

		return { oneOf };
	}

	if (isJTDRef(schema)) {
		return { $ref: `#/$defs/${schema.ref}` };
	}

	return {};
}

const jtdOnlyPrimitiveTypes: Record<string, true> = {
	timestamp: true,
	float32: true,
	float64: true,
	int8: true,
	uint8: true,
	int16: true,
	uint16: true,
	int32: true,
	uint32: true,
};

export function isJTDSchema(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") {
		return false;
	}

	const obj = schema as Record<string, unknown>;

	if ("elements" in obj) return true;
	if ("values" in obj) return true;
	if ("optionalProperties" in obj) return true;
	if ("discriminator" in obj) return true;
	if ("ref" in obj) return true;

	if (typeof obj.type === "string" && Object.hasOwn(jtdOnlyPrimitiveTypes, obj.type)) {
		return true;
	}

	if ("properties" in obj && !("type" in obj)) {
		return true;
	}

	return false;
}

function isUnambiguousJTDSchema(schema: unknown): boolean {
	if (!isRecord(schema)) return false;

	if (isRecord(schema.elements) || isRecord(schema.values) || isRecord(schema.optionalProperties)) {
		return true;
	}
	if (typeof schema.ref === "string") return true;
	if (typeof schema.type === "string" && Object.hasOwn(jtdOnlyPrimitiveTypes, schema.type)) {
		return true;
	}
	if (typeof schema.discriminator !== "string" || !isRecord(schema.mapping)) {
		return false;
	}

	for (const key in schema.mapping) {
		if (!Object.hasOwn(schema.mapping, key)) continue;
		const mapping = schema.mapping[key];
		if (!isRecord(mapping)) return false;

		let hasSchemaProperties = false;
		if (Object.hasOwn(mapping, "properties")) {
			if (!isRecord(mapping.properties)) return false;
			hasSchemaProperties = true;
		}
		if (Object.hasOwn(mapping, "optionalProperties")) {
			if (!isRecord(mapping.optionalProperties)) return false;
			hasSchemaProperties = true;
		}
		if (!hasSchemaProperties) return false;
	}

	return true;
}

function normalizeJsonSchemaArray(value: unknown): unknown {
	if (!Array.isArray(value)) return value;

	let normalized: unknown[] | undefined;
	for (let index = 0; index < value.length; index++) {
		const item = value[index];
		const converted = normalizeJsonSchemaNode(item);
		if (converted === item) continue;
		normalized ??= value.slice();
		normalized[index] = converted;
	}
	return normalized ?? value;
}

function normalizeJsonSchemaMap(value: unknown): unknown {
	if (!isRecord(value)) return value;

	let normalized: Record<string, unknown> | undefined;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const item = value[key];
		const converted = normalizeJsonSchemaNode(item);
		if (converted === item) continue;
		normalized ??= { ...value };
		normalized[key] = converted;
	}
	return normalized ?? value;
}

function normalizeJsonSchemaNode(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	if (isUnambiguousJTDSchema(schema)) return convertSchema(schema);

	let normalized: Record<string, unknown> | undefined;
	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;

		const value = schema[key];
		let converted: unknown;
		switch (key) {
			case "not":
			case "if":
			case "then":
			case "else":
			case "items":
			case "contains":
			case "propertyNames":
			case "additionalProperties":
			case "unevaluatedProperties":
			case "unevaluatedItems":
			case "contentSchema":
				converted = normalizeJsonSchemaNode(value);
				break;
			case "allOf":
			case "anyOf":
			case "oneOf":
			case "prefixItems":
				converted = normalizeJsonSchemaArray(value);
				break;
			case "properties":
			case "patternProperties":
			case "$defs":
			case "definitions":
			case "dependentSchemas":
				converted = normalizeJsonSchemaMap(value);
				break;
			default:
				continue;
		}

		if (converted === value) continue;
		normalized ??= { ...schema };
		normalized[key] = converted;
	}

	return normalized ?? schema;
}

export function jtdToJsonSchema(schema: unknown): unknown {
	if (isJTDSchema(schema)) {
		return convertSchema(schema);
	}
	return normalizeJsonSchemaNode(schema);
}

export function normalizeSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}
