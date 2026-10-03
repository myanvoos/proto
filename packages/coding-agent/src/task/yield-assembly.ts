import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator } from "../tools/output-schema-validator";
import type { YieldItem } from "./types";

/** Declared output-schema shape per section label: arrays accumulate, scalars keep the latest value. */
export type YieldSectionShapes = ReadonlyMap<string, "array" | "scalar">;

interface AssembledYieldResult {
	data: unknown;
	schemaOverridden: boolean;
	rawText: boolean;
	missingData: boolean;
}

function isIncrementalYieldType(type: YieldItem["type"]): type is string[] {
	return Array.isArray(type) && type.length > 0;
}

function getYieldLabels(type: YieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		if (typeof value !== "string") continue;
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function resolveYieldPayload(
	item: YieldItem,
	lastAssistantText: string | undefined,
	labels: string[],
): { value: unknown; fromLastAssistantText: boolean; missingData: boolean } {
	const hasData = item.data !== undefined;
	const shouldUseLastTurn = item.useLastTurn === true || (labels.length > 0 && !hasData);
	if (shouldUseLastTurn && lastAssistantText !== undefined) {
		return {
			value: lastAssistantText,
			fromLastAssistantText: true,
			missingData: lastAssistantText.length === 0,
		};
	}
	return {
		value: item.data,
		fromLastAssistantText: false,
		missingData: item.data === undefined || item.data === null,
	};
}

function appendYieldSection(
	sections: Record<string, unknown>,
	sectionCounts: Map<string, number>,
	label: string,
	value: unknown,
	shape: "array" | "scalar" | undefined,
): void {
	const count = sectionCounts.get(label) ?? 0;
	const existing = sections[label];
	if (shape === "scalar") {
		sections[label] = value;
	} else if (count === 0) {
		sections[label] = shape === "array" ? [value] : value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		sections[label] = [existing, value];
	}
	sectionCounts.set(label, count + 1);
}

function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

function collectPropertyShapes(schema: Record<string, unknown>, shapes: Map<string, "array" | "scalar" | "mixed">) {
	const properties = schema.properties;
	if (isRecord(properties)) {
		for (const key in properties) {
			const shape = isArrayTypedSchema(properties[key]) ? "array" : "scalar";
			const existing = shapes.get(key);
			shapes.set(key, existing === undefined || existing === shape ? shape : "mixed");
		}
	}
	for (const key of ["allOf", "oneOf", "anyOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (isRecord(branch)) collectPropertyShapes(branch, shapes);
		}
	}
}

/**
 * Shape of every output-schema property declared at the root or in its `allOf`/`oneOf`/`anyOf` branches (JTD
 * discriminators compile to a root `oneOf`). Array properties accumulate even a single section; other declared
 * properties are scalar, so a revised section replaces the earlier one instead of assembling an array the schema
 * rejects. A label declared array in one branch and scalar in another gets no shape and keeps the generic merge.
 */
export function yieldSectionShapes(outputSchema: unknown): YieldSectionShapes {
	const shapes = new Map<string, "array" | "scalar">();
	const { jsonSchema } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return shapes;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const collected = new Map<string, "array" | "scalar" | "mixed">();
	collectPropertyShapes(isRecord(dereferenced) ? dereferenced : jsonSchema, collected);
	for (const [key, shape] of collected) {
		if (shape !== "mixed") shapes.set(key, shape);
	}
	return shapes;
}

export function assembleYieldResult(
	yieldItems: YieldItem[],
	lastAssistantText?: string,
	sectionShapes?: YieldSectionShapes,
): AssembledYieldResult | undefined {
	if (yieldItems.length === 0) return undefined;

	let terminalItem: YieldItem | undefined;
	for (let index = yieldItems.length - 1; index >= 0; index--) {
		const item = yieldItems[index];
		if (item && !isIncrementalYieldType(item.type)) {
			terminalItem = item;
			break;
		}
	}

	const sections: Record<string, unknown> = {};
	const sectionCounts = new Map<string, number>();
	// A scalar section replaced by a later yield drops the earlier yield's schema-override provenance.
	const overriddenScalars = new Set<string>();
	let schemaOverridden = false;
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		const overridden = item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		const resolved = resolveYieldPayload(item, lastAssistantText, labels);
		missingData ||= resolved.missingData;
		if (labels.length === 0) schemaOverridden ||= overridden;
		for (const label of labels) {
			const shape = sectionShapes?.get(label);
			appendYieldSection(sections, sectionCounts, label, resolved.value, shape);
			if (shape === "scalar") {
				if (overridden) overriddenScalars.add(label);
				else overriddenScalars.delete(label);
			} else {
				schemaOverridden ||= overridden;
			}
			hasSections = true;
		}
	}

	if (terminalItem && terminalItem.data !== undefined) {
		const resolved = resolveYieldPayload(terminalItem, lastAssistantText, []);
		return {
			data: resolved.value,
			schemaOverridden: terminalItem.schemaOverridden === true,
			rawText: resolved.fromLastAssistantText && typeof resolved.value === "string",
			missingData: resolved.missingData,
		};
	}

	if (hasSections) {
		return {
			data: sections,
			schemaOverridden: schemaOverridden || overriddenScalars.size > 0,
			rawText: false,
			missingData,
		};
	}

	if (!terminalItem) return undefined;
	const resolved = resolveYieldPayload(terminalItem, lastAssistantText, getYieldLabels(terminalItem.type));
	return {
		data: resolved.value,
		schemaOverridden: terminalItem.schemaOverridden === true,
		rawText: resolved.fromLastAssistantText && typeof resolved.value === "string",
		missingData: resolved.missingData,
	};
}
